// api/shipping/shiprocket/ship-order.js
//
// Single entrypoint the admin panel calls to push one order to Shiprocket end-to-end:
//   1. Verify the caller is genuinely an admin (never trust a client-side check alone)
//   2. Create the order in Shiprocket
//   3. Check courier serviceability + rates for the delivery pincode, pick the cheapest
//   4. Assign that courier's AWB
//   5. Generate the shipping label PDF
//   6. Save everything back onto the order in Supabase
//
// Required Vercel environment variables:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   (never exposed to the client — server-side only)
//   SHIPROCKET_EMAIL
//   SHIPROCKET_PASSWORD

const { createClient } = require('@supabase/supabase-js');

const SHIPROCKET_BASE = 'https://apiv2.shiprocket.in/v1/external';

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
  const SHIPROCKET_EMAIL = process.env.SHIPROCKET_EMAIL;
  const SHIPROCKET_PASSWORD = process.env.SHIPROCKET_PASSWORD;

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !SHIPROCKET_EMAIL || !SHIPROCKET_PASSWORD) {
    console.error('Shiprocket ship-order: missing required environment variables');
    return json(res, 500, { error: 'Server is not configured correctly. Contact the site owner.' });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // ---- 1. Verify the caller is a real, currently-logged-in admin ----
  // Never trust a client-side "isAdmin" flag — always re-check server-side against the
  // actual database, using the caller's own access token, before doing anything sensitive.
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
    return json(res, 403, { error: 'Only admins can create Shiprocket shipments.' });
  }

  // ---- 2. Load the order, its items (with product weight), and store settings ----
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
      error: `This order already has an AWB assigned (${order.awb_code}, ${order.courier_name || 'unknown courier'}). Cancel it in Shiprocket first if you need to re-ship.`
    });
  }

  const { data: orderItems } = await supabaseAdmin
    .from('order_items')
    .select('product_name, sku, unit_price, quantity, product_id, products(weight_kg)')
    .eq('order_id', orderId);

  if (!orderItems || orderItems.length === 0) {
    return json(res, 400, { error: 'This order has no items recorded.' });
  }

  const { data: settings } = await supabaseAdmin.from('store_settings').select('*').single();
  const pickupLocation = settings?.shiprocket_pickup_location || 'Primary';
  const pickupPincode = settings?.shiprocket_pickup_pincode || '577401';

  // The real checkout address is used whenever it exists (true for every order placed after
  // shipping details started being tracked). Only orders from before that fix fall back to a
  // clearly-flagged placeholder — this lets the order still sync to Shiprocket instead of being
  // blocked outright, on the understanding that the address gets corrected there by hand before
  // dispatch. The pincode placeholder specifically falls back to your OWN pickup pincode rather
  // than something random, purely so the courier-serviceability lookup has a valid-format pincode
  // to query — the resulting "cheapest courier" pick won't be meaningful until the real delivery
  // pincode is entered in Shiprocket and the courier is re-checked there.
  const usingPlaceholderAddress = !order.shipping_address || !order.shipping_pincode;
  const shipTo = {
    name: order.shipping_full_name || order.customer_name || 'Customer — CONFIRM NAME',
    phone: (order.shipping_phone || settings?.business_phone || '9999999999').replace(/\D/g, '').slice(-10),
    address: order.shipping_address || `ADDRESS PENDING — update in Shiprocket before dispatch (Order ${order.order_number})`,
    city: order.shipping_city || 'TBD',
    state: order.shipping_state || settings?.business_state || 'TBD',
    pincode: order.shipping_pincode || pickupPincode
  };

  const totalWeightKg = orderItems.reduce(
    (sum, item) => sum + (Number(item.products?.weight_kg || 0.15) * Number(item.quantity || 1)),
    0
  );
  // Small leather goods — sensible default parcel dimensions in cm when nothing more specific is tracked.
  const dimensions = { length: 15, breadth: 10, height: 2 };

  const isCod = (order.payment_method || '').toLowerCase().includes('cash on delivery')
    || (order.payment_method || '').toLowerCase().includes('cod');

  // ---- 3. Authenticate with Shiprocket (cached token, re-login only when it's actually expired) ----
  let shiprocketToken;
  try {
    shiprocketToken = await getShiprocketToken(supabaseAdmin, SHIPROCKET_EMAIL, SHIPROCKET_PASSWORD);
  } catch (err) {
    console.error('Shiprocket auth failed:', err.message);
    return json(res, 502, { error: 'Could not authenticate with Shiprocket. Check the account credentials in Vercel settings.' });
  }

  const srHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${shiprocketToken}`
  };

  // ---- 4. Create the order in Shiprocket ----
  let srOrder;
  try {
    const createRes = await fetch(`${SHIPROCKET_BASE}/orders/create/adhoc`, {
      method: 'POST',
      headers: srHeaders,
      body: JSON.stringify({
        order_id: order.order_number,
        order_date: new Date(order.created_at).toISOString().slice(0, 19).replace('T', ' '),
        pickup_location: pickupLocation,
        billing_customer_name: shipTo.name,
        billing_last_name: '',
        billing_address: shipTo.address,
        billing_city: shipTo.city,
        billing_pincode: shipTo.pincode,
        billing_state: shipTo.state,
        billing_country: 'India',
        billing_email: 'orders@laizalifestyle.com',
        billing_phone: shipTo.phone,
        shipping_is_billing: true,
        order_items: orderItems.map(item => ({
          name: item.product_name,
          sku: item.sku || item.product_id,
          units: item.quantity,
          selling_price: item.unit_price
        })),
        payment_method: isCod ? 'COD' : 'Prepaid',
        sub_total: order.subtotal,
        length: dimensions.length,
        breadth: dimensions.breadth,
        height: dimensions.height,
        weight: Math.max(totalWeightKg, 0.05)
      })
    });
    srOrder = await createRes.json();
    if (!createRes.ok || !srOrder?.shipment_id) {
      console.error('Shiprocket order creation failed:', srOrder);
      return json(res, 502, { error: srOrder?.message || 'Shiprocket rejected this order. Check the shipping address details.' });
    }
  } catch (err) {
    console.error('Shiprocket order creation error:', err.message);
    return json(res, 502, { error: 'Could not reach Shiprocket to create the order.' });
  }

  const shipmentId = srOrder.shipment_id;
  const shiprocketOrderId = srOrder.order_id;

  // ---- 5. Check serviceability + pick the cheapest courier ----
  let cheapestCourier = null;
  try {
    const rateRes = await fetch(
      `${SHIPROCKET_BASE}/courier/serviceability/?pickup_postcode=${pickupPincode}&delivery_postcode=${shipTo.pincode}&weight=${Math.max(totalWeightKg, 0.05)}&cod=${isCod ? 1 : 0}`,
      { headers: srHeaders }
    );
    const rateData = await rateRes.json();
    const couriers = rateData?.data?.available_courier_companies || [];
    if (couriers.length === 0) {
      return json(res, 502, {
        error: 'No courier currently serviceable for this pincode. The Shiprocket order was created but no courier was assigned — assign one manually in Shiprocket.',
        shiprocket_order_id: shiprocketOrderId,
        shipment_id: shipmentId
      });
    }
    cheapestCourier = couriers.reduce((min, c) => (Number(c.rate) < Number(min.rate) ? c : min), couriers[0]);
  } catch (err) {
    console.error('Shiprocket serviceability check error:', err.message);
    return json(res, 502, {
      error: 'Order created in Shiprocket, but could not check courier rates. Assign a courier manually.',
      shiprocket_order_id: shiprocketOrderId,
      shipment_id: shipmentId
    });
  }

  // ---- 6. Assign AWB with the cheapest courier ----
  let awbCode;
  try {
    const awbRes = await fetch(`${SHIPROCKET_BASE}/courier/assign/awb`, {
      method: 'POST',
      headers: srHeaders,
      body: JSON.stringify({ shipment_id: shipmentId, courier_id: cheapestCourier.courier_company_id })
    });
    const awbData = await awbRes.json();
    awbCode = awbData?.response?.data?.awb_code;
    if (!awbRes.ok || !awbCode) {
      console.error('Shiprocket AWB assignment failed:', awbData);
      return json(res, 502, {
        error: 'Order created in Shiprocket, but AWB assignment failed. Assign a courier manually.',
        shiprocket_order_id: shiprocketOrderId,
        shipment_id: shipmentId
      });
    }
  } catch (err) {
    console.error('Shiprocket AWB assignment error:', err.message);
    return json(res, 502, {
      error: 'Order created in Shiprocket, but AWB assignment failed due to a network error.',
      shiprocket_order_id: shiprocketOrderId,
      shipment_id: shipmentId
    });
  }

  // ---- 7. Generate the shipping label (best-effort — a missing label shouldn't block the AWB being saved) ----
  let labelUrl = null;
  try {
    const labelRes = await fetch(`${SHIPROCKET_BASE}/courier/generate/label`, {
      method: 'POST',
      headers: srHeaders,
      body: JSON.stringify({ shipment_id: [shipmentId] })
    });
    const labelData = await labelRes.json();
    labelUrl = labelData?.label_url || null;
  } catch (err) {
    console.error('Shiprocket label generation error (non-fatal):', err.message);
  }

  // ---- 8. Save everything back onto the order ----
  await supabaseAdmin
    .from('orders')
    .update({
      shiprocket_order_id: String(shiprocketOrderId),
      shiprocket_shipment_id: String(shipmentId),
      awb_code: awbCode,
      courier_name: cheapestCourier.courier_name,
      shiprocket_status: 'AWB Assigned'
    })
    .eq('id', orderId);

  const { data: deliveryOrder } = await supabaseAdmin
    .from('delivery_orders')
    .insert({
      order_id: orderId,
      tracking_number: awbCode,
      status: 'AWB Assigned',
      shiprocket_shipment_id: String(shipmentId),
      awb_code: awbCode,
      courier_name: cheapestCourier.courier_name,
      freight_charge: cheapestCourier.rate
    })
    .select('id')
    .single();

  if (labelUrl && deliveryOrder?.id) {
    await supabaseAdmin.from('shipping_labels').insert({
      delivery_order_id: deliveryOrder.id,
      label_url: labelUrl
    });
  }

  return json(res, 200, {
    success: true,
    shiprocket_order_id: shiprocketOrderId,
    shipment_id: shipmentId,
    awb_code: awbCode,
    courier_name: cheapestCourier.courier_name,
    freight_charge: cheapestCourier.rate,
    label_url: labelUrl,
    tracking_url: `https://shiprocket.co/tracking/${awbCode}`,
    // Set when this order predates address tracking, so the admin panel can clearly flag
    // that the address/courier pick here is based on a placeholder and needs manual fixing.
    address_warning: usingPlaceholderAddress
      ? 'This order had no shipping address on file, so a placeholder was sent to Shiprocket. Update the real address there, then re-check the courier — the cheapest-courier pick above is not reliable until you do.'
      : null
  });
};

// Reuses a cached token until it's actually close to expiring, instead of logging in on
// every request — avoids hammering Shiprocket's auth endpoint and any rate limits on it.
async function getShiprocketToken(supabaseAdmin, email, password) {
  const { data: cached } = await supabaseAdmin
    .from('shiprocket_auth_cache')
    .select('token, expires_at')
    .eq('id', true)
    .maybeSingle();

  if (cached?.token && cached.expires_at && new Date(cached.expires_at) > new Date(Date.now() + 60 * 60 * 1000)) {
    return cached.token;
  }

  const loginRes = await fetch(`${SHIPROCKET_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  const loginData = await loginRes.json();
  if (!loginRes.ok || !loginData?.token) {
    throw new Error(loginData?.message || 'Shiprocket login failed — check SHIPROCKET_EMAIL/SHIPROCKET_PASSWORD.');
  }

  // Shiprocket tokens are valid ~10 days; cache for 9 to be safe.
  const expiresAt = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString();
  await supabaseAdmin
    .from('shiprocket_auth_cache')
    .upsert({ id: true, token: loginData.token, expires_at: expiresAt });

  return loginData.token;
         }
                                                                                                                                                                     
