// api/shipping/ithink/ship-order.js
//
// Replaces the earlier Shiprocket integration. Single entrypoint the admin panel calls to
// push one order to iThink Logistics end-to-end:
//   1. Verify the caller is genuinely an admin (never trust a client-side check alone)
//   2. Check rate/check.json to find the cheapest serviceable courier for this pincode
//   3. Create the order via order/add.json with that courier selected
//   4. Save the AWB, courier name, and tracking URL back onto the order in Supabase
//
// Required Vercel environment variables:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   (never exposed to the client — server-side only)
//   ITHINK_ACCESS_TOKEN
//   ITHINK_SECRET_KEY
//   ITHINK_ENV                  ("staging" or "production" — defaults to staging if unset,
//                                 so a misconfigured env var can never accidentally hit production)

const { createClient } = require('@supabase/supabase-js');
const { notifyOrder } = require('../../_lib/notify');

const ITHINK_BASE = process.env.ITHINK_ENV === 'production'
  ? 'https://my.ithinklogistics.com/api_v3'
  : 'https://pre-alpha.ithinklogistics.com/api_v3';

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ITHINK_ACCESS_TOKEN = process.env.ITHINK_ACCESS_TOKEN;
  const ITHINK_SECRET_KEY = process.env.ITHINK_SECRET_KEY;

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ITHINK_ACCESS_TOKEN || !ITHINK_SECRET_KEY) {
    console.error('iThink ship-order: missing required environment variables');
    return json(res, 500, { error: 'Server is not configured correctly. Contact the site owner.' });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const creds = { access_token: ITHINK_ACCESS_TOKEN, secret_key: ITHINK_SECRET_KEY };

  // ---- 1. Verify the caller is a real, currently-logged-in admin ----
  const authHeader = req.headers.authorization || '';
  const callerToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!callerToken) {
    return json(res, 401, { error: 'Not signed in.' });
  }

  const { data: callerData, error: callerError } = await supabaseAdmin.auth.getUser(callerToken);
  if (callerError || !callerData?.user) {
    return json(res, 401, { error: 'Your session has expired. Please log in again.' });
  }

  const { data: callerProfile } = await supabaseAdmin
    .from('profiles')
    .select('is_admin')
    .eq('id', callerData.user.id)
    .maybeSingle();

  if (!callerProfile?.is_admin) {
    return json(res, 403, { error: 'Only admins can create shipments.' });
  }

  // ---- 2. Load the order, its items, and store settings ----
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return json(res, 400, { error: 'Invalid request body' });
  }
  const orderId = body?.order_id;
  if (!orderId) {
    return json(res, 400, { error: 'order_id is required' });
  }

  const { data: order, error: orderError } = await supabaseAdmin
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .single();

  if (orderError || !order) {
    return json(res, 404, { error: 'Order not found' });
  }

  if (order.awb_code) {
    return json(res, 409, {
      error: `This order already has an AWB assigned (${order.awb_code}, ${order.courier_name || 'unknown courier'}). Cancel it in iThink Logistics first if you need to re-ship.`
    });
  }

  // Read items from the order's own permanent snapshot (orders.items) rather than the
  // separate order_items table — the snapshot is what every order guarantees, and what
  // the rest of the admin panel actually displays. order_items is a secondary table that
  // isn't reliably populated for every order, and requiring it caused "no items recorded"
  // errors on orders that plainly showed real items in the admin UI.
  const rawItems = Array.isArray(order.items) ? order.items : [];
  if (rawItems.length === 0) {
    return json(res, 400, { error: 'This order has no items recorded.' });
  }

  const productIds = rawItems.map(i => i.id).filter(Boolean);
  const { data: productRows } = productIds.length
    ? await supabaseAdmin.from('products').select('id, sku, weight_kg, gst_rate, hsn_code').in('id', productIds)
    : { data: [] };
  const productById = Object.fromEntries((productRows || []).map(p => [p.id, p]));

  const orderItems = rawItems.map(i => ({
    product_name: i.name,
    sku: productById[i.id]?.sku || i.id,
    unit_price: i.price,
    quantity: i.qty,
    product_id: i.id,
    products: productById[i.id] || null
  }));

  const { data: settings } = await supabaseAdmin.from('store_settings').select('*').single();
  const pickupAddressId = settings?.itl_pickup_address_id || '1293';
  const pickupPincode = settings?.itl_pickup_pincode || '577401';

  // Same placeholder approach as before: real checkout address is used whenever it exists
  // (true for every order placed after shipping details started being tracked). Only orders
  // from before that fix fall back to a clearly-flagged placeholder, so the sync still
  // succeeds instead of being blocked outright — the address then gets corrected by hand
  // in iThink's dashboard before dispatch.
  const usingPlaceholderAddress = !order.shipping_address || !order.shipping_pincode;
  const shipTo = {
    name: order.shipping_full_name || order.customer_name || 'Customer — CONFIRM NAME',
    phone: (order.shipping_phone || settings?.business_phone || '9999999999').replace(/\D/g, '').slice(-10),
    address: order.shipping_address || `ADDRESS PENDING — update in iThink before dispatch (Order ${order.order_number})`,
    city: order.shipping_city || 'TBD',
    state: order.shipping_state || settings?.business_state || 'TBD',
    pincode: order.shipping_pincode || pickupPincode
  };

  const totalWeightKg = orderItems.reduce(
    (sum, item) => sum + (Number(item.products?.weight_kg || 0.15) * Number(item.quantity || 1)),
    0
  );
  // Small leather goods — sensible default parcel dimensions in cm when nothing more specific is tracked.
  const dimensions = { length: 15, width: 10, height: 2 };

  const isCod = (order.payment_method || '').toLowerCase().includes('cash on delivery')
    || (order.payment_method || '').toLowerCase().includes('cod');

  // ---- 3. Check rate/check.json to find the cheapest serviceable courier ----
  // NOTE: the exact response shape of this endpoint wasn't in the docs provided — this parses
  // the most likely shapes (a plain array under `data`, or `data.rate_list`), trying a few
  // common field-name variations for the courier name and price. If this doesn't match iThink's
  // real response on your first live test, the raw response is logged so it can be fixed quickly.
  let cheapestCourier = null;
  let courierCandidates = [];
  try {
    const rateRes = await fetch(`${ITHINK_BASE}/rate/check.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          from_pincode: pickupPincode,
          to_pincode: shipTo.pincode,
          shipping_length_cms: String(dimensions.length),
          shipping_width_cms: String(dimensions.width),
          shipping_height_cms: String(dimensions.height),
          shipping_weight_kg: String(Math.max(totalWeightKg, 0.05)),
          order_type: 'forward',
          payment_method: isCod ? 'cod' : 'prepaid',
          product_mrp: String(order.total),
          ...creds
        }
      })
    });
    const rateData = await rateRes.json();
    const rateList = Array.isArray(rateData?.data) ? rateData.data
      : Array.isArray(rateData?.data?.rate_list) ? rateData.data.rate_list
      : Array.isArray(rateData?.data?.courier_list) ? rateData.data.courier_list
      : [];

    if (rateList.length === 0) {
      console.error('iThink rate/check: could not find a courier list in the response. Raw response:', JSON.stringify(rateData));
      return json(res, 502, {
        error: 'Could not determine available couriers for this pincode — the rate-check response did not match the expected format. Check the server logs and share them so this can be fixed.',
        raw_response: rateData
      });
    }

    const getCost = c => Number(c.rate ?? c.total_charges ?? c.total_amount ?? c.price ?? Infinity);
    const getName = c => c.logistic ?? c.logistic_name ?? c.courier_name ?? c.name ?? 'Unknown';

    // Only keep couriers iThink marks as able to pick up from us AND handle this payment type
    // (COD vs prepaid) on this route. A missing flag is treated as "not stated" and allowed.
    const flagOk = v => v === undefined || v === null || v === '' || String(v).toUpperCase() === 'Y';
    const usable = rateList.filter(c => flagOk(c.pickup) && flagOk(isCod ? c.cod : c.prepaid));

    if (usable.length === 0) {
      return json(res, 422, {
        error: isCod
          ? `No courier offers Cash on Delivery with pickup for pincode ${shipTo.pincode}. Ship this order as prepaid, or check it manually in the iThink dashboard.`
          : `No courier offers pickup and prepaid delivery for pincode ${shipTo.pincode}.`,
        raw_response: rateData
      });
    }

    // Cheapest first — if iThink still rejects one, the next cheapest is tried automatically.
    courierCandidates = usable
      .map(c => ({ name: getName(c), rate: getCost(c) }))
      .sort((a, b) => a.rate - b.rate);
  } catch (err) {
    console.error('iThink rate/check error:', err.message);
    return json(res, 502, { error: 'Could not reach iThink Logistics to check courier rates.' });
  }

  // ---- 4. Create the order, trying couriers cheapest-first ----
  // iThink's staging/sandbox only permits Delhivery, so staging always uses that single courier.
  if (process.env.ITHINK_ENV !== 'production') {
    courierCandidates = [{ name: 'Delhivery', rate: courierCandidates[0]?.rate ?? 0 }];
  }

  let srResult;
  let shipmentResult;
  let shipmentSucceeded = false;
  const attempts = [];
  for (const courier of courierCandidates.slice(0, 5)) {
    try {
        const createRes = await fetch(`${ITHINK_BASE}/order/add.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            data: {
              shipments: [{
                waybill: '',
                order: order.order_number,
                sub_order: '',
                order_date: new Date(order.created_at).toISOString().slice(0, 10).split('-').reverse().join('-'),
                total_amount: String(order.total),
                name: shipTo.name,
                company_name: '',
                add: shipTo.address,
                add2: '',
                add3: '',
                pin: shipTo.pincode,
                city: shipTo.city,
                state: shipTo.state,
                country: 'India',
                phone: shipTo.phone,
                alt_phone: '',
                email: '',
                is_billing_same_as_shipping: 'yes',
                billing_name: shipTo.name,
                billing_add: shipTo.address,
                billing_pin: shipTo.pincode,
                billing_city: shipTo.city,
                billing_state: shipTo.state,
                billing_country: 'India',
                billing_phone: shipTo.phone,
                products: orderItems.map(item => ({
                  product_name: item.product_name,
                  product_sku: item.sku || item.product_id,
                  product_quantity: String(item.quantity),
                  product_price: String(item.unit_price),
                  product_tax_rate: String(item.products?.gst_rate ?? ''),
                  product_hsn_code: item.products?.hsn_code || '',
                  product_discount: '0'
                })),
                shipment_length: String(dimensions.length),
                shipment_width: String(dimensions.width),
                shipment_height: String(dimensions.height),
                weight: String(Math.max(totalWeightKg, 0.05)),
                shipping_charges: String(order.shipping_amount || 0),
                giftwrap_charges: '0',
                transaction_charges: '0',
                total_discount: String(order.discount_amount || 0),
                first_attemp_discount: '0',
                cod_charges: '0',
                advance_amount: '0',
                cod_amount: isCod ? String(order.total) : '0',
                payment_mode: isCod ? 'COD' : 'Prepaid',
                reseller_name: '',
                eway_bill_number: '',
                gst_number: '',
                return_address_id: String(pickupAddressId)
              }],
              pickup_address_id: String(pickupAddressId),
              // iThink's staging/sandbox environment only permits booking through Delhivery,
              // regardless of what the rate-check determines is cheapest — that restriction
              // doesn't exist in production, where the real cheapest-courier pick is used.
              logistics: courier.name,
              s_type: '',
              order_type: '',
              ...creds
            }
          })
        });
        srResult = await createRes.json();
    } catch (err) {
      console.error('iThink order/add error:', err.message);
      return json(res, 502, { error: 'Could not reach iThink Logistics to create the order.' });
    }

    shipmentResult = srResult?.data?.['1'];
    // Live API returns lowercase "success" (docs show "Success") — compare case-insensitively.
    shipmentSucceeded = (shipmentResult?.status || '').toLowerCase() === 'success';
    attempts.push({ courier: courier.name, remark: shipmentResult?.remark || srResult?.html_message || '' });

    if (srResult?.status === 'success' && shipmentSucceeded) {
      cheapestCourier = courier;
      break;
    }
    // A top-level error (e.g. bad credentials) won't be fixed by switching courier — stop.
    if (srResult?.status !== 'success') break;
  }

  if (!srResult || srResult.status !== 'success' || !shipmentResult || !shipmentSucceeded) {
    console.error('iThink order creation failed:', JSON.stringify({ attempts, last: srResult }));
    const tried = attempts.map(a => `${a.courier}: ${a.remark || 'rejected'}`).join('\n');
    return json(res, 502, {
      error: (srResult?.html_message || shipmentResult?.remark || 'iThink Logistics rejected this order.')
        + (tried ? `\n\nCouriers tried:\n${tried}` : ''),
      raw_response: srResult
    });
  }

  const awbCode = shipmentResult.waybill;
  const courierName = shipmentResult.logistic_name || cheapestCourier.name;
  const trackingUrl = shipmentResult.tracking_url || null;

  // ---- 5. Save everything back onto the order ----
  await supabaseAdmin
    .from('orders')
    .update({
      awb_code: awbCode,
      courier_name: courierName,
      tracking_url: trackingUrl
    })
    .eq('id', orderId);

  // Move the order along: an AWB means it is booked with the courier and waiting for pickup.
  // Later statuses (Shipped, Delivered…) are set automatically by sync-tracking.js.
  if (['pending', 'confirmed', 'processing', 'packed'].includes(order.status)) {
    await supabaseAdmin.from('orders').update({ status: 'ready_for_dispatch' }).eq('id', orderId);
    await supabaseAdmin.from('order_status_history').insert({
      order_id: orderId, status: 'ready_for_dispatch',
      note: `Shipment booked with ${courierName} — AWB ${awbCode}`
    });
  }

  await supabaseAdmin
    .from('delivery_orders')
    .insert({
      order_id: orderId,
      tracking_number: awbCode,
      status: 'AWB Assigned',
      awb_code: awbCode,
      courier_name: courierName,
      freight_charge: cheapestCourier.rate
    });

  // ---- 6. Tell the customer it has shipped (email + WhatsApp). Never blocks shipping. ----
  try {
    await notifyOrder(supabaseAdmin, orderId, 'shipped');
  } catch (err) {
    console.error('Shipped notification failed:', err.message);
  }

  return json(res, 200, {
    success: true,
    awb_code: awbCode,
    courier_name: courierName,
    freight_charge: cheapestCourier.rate,
    tracking_url: trackingUrl,
    address_warning: usingPlaceholderAddress
      ? 'This order had no shipping address on file, so a placeholder was sent to iThink Logistics. Update the real address there before dispatch — the cheapest-courier pick above is not reliable until you do.'
      : null
  });
};
