// POST /api/payment/payu/create-link
//
// Creates a PayU Payment Link for an existing PENDING order and stores the
// result in Supabase. This file runs ONLY on Vercel's serverless runtime —
// it never ships to the browser, so this is the one place PayU credentials
// are allowed to exist.
//
// Required Vercel Environment Variables (set in Project Settings → Environment
// Variables, NOT in this file, NOT committed to git):
//
//   PAYU_CLIENT_ID          - OAuth client ID from PayU dashboard
//   PAYU_CLIENT_SECRET      - OAuth client secret from PayU dashboard
//   PAYU_MERCHANT_ID        - Your PayU merchantId
//   PAYU_ENV                - "test" or "production" (defaults to "test")
//   SUPABASE_URL             - Your Supabase project URL (same one used client-side, not secret)
//   SUPABASE_SERVICE_ROLE_KEY - Supabase service role key (SECRET — server only, bypasses RLS)
//
// This function deliberately does its OWN authorization check rather than
// relying on RLS, because it uses the service role key (which bypasses RLS
// entirely) to read/write on the admin's behalf. That means the authorization
// logic below IS the security boundary for this endpoint — treat edits to it
// with the same care as an RLS policy change.

const { createClient } = require('@supabase/supabase-js');

const PAYU_TOKEN_URLS = {
  test: 'https://uat-accounts.payu.in/oauth/token',
  production: 'https://accounts.payu.in/oauth/token'
};
const PAYU_LINK_URLS = {
  test: 'https://uatoneapi.payu.in/payment-links',
  production: 'https://oneapi.payu.in/payment-links'
};

// Order statuses that mean "this order can no longer be paid for"
const NON_PAYABLE_STATUSES = new Set(['cancelled', 'refunded', 'returned']);

function json(res, statusCode, body) {
  res.status(statusCode).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

function generateInvoiceNumber(orderNumber) {
  // PayU requires this to be strictly alphanumeric — no hyphens, underscores, or
  // any other punctuation. Still unique per call, since PayU rejects a reused
  // invoice number outright (even on an intentional regenerate).
  const cleanOrderNumber = String(orderNumber).replace(/[^a-zA-Z0-9]/g, '');
  const suffix = (Date.now().toString(36) + Math.random().toString(36).slice(2, 6))
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase();
  return `PAYU${cleanOrderNumber}${suffix}`.slice(0, 50);
}

async function getPayUAccessToken(env) {
  const tokenUrl = PAYU_TOKEN_URLS[env];
  const body = new URLSearchParams({
    client_id: process.env.PAYU_CLIENT_ID,
    client_secret: process.env.PAYU_CLIENT_SECRET,
    grant_type: 'client_credentials',
    scope: 'create_payment_links'
  });

  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error('PayU token request failed: ' + (data.error_description || data.error || resp.statusText));
  }
  return data.access_token;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const PAYU_ENV = (process.env.PAYU_ENV || 'test').toLowerCase() === 'production' ? 'production' : 'test';

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !process.env.PAYU_CLIENT_ID || !process.env.PAYU_CLIENT_SECRET || !process.env.PAYU_MERCHANT_ID) {
    // Fail loudly in config, not silently — a half-configured payment endpoint is worse than a down one
    return json(res, 500, { error: 'Server is not configured for PayU payments. Missing required environment variables.' });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // ---- 1. Authenticate the admin ----
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return json(res, 401, { error: 'Missing Authorization header' });
  }

  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return json(res, 401, { error: 'Invalid or expired session' });
  }
  const adminUserId = userData.user.id;

  // ---- 2. Parse input — orderId ONLY. Amount is never accepted from the client. ----
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return json(res, 400, { error: 'Invalid JSON body' });
  }
  const { orderId, regenerate } = body;
  if (!orderId || typeof orderId !== 'string') {
    return json(res, 400, { error: 'orderId is required' });
  }

  // ---- 3. Fetch the order from Supabase — the ONLY source of truth for amount ----
  const { data: order, error: orderError } = await supabaseAdmin
    .from('orders')
    .select('id, order_number, user_id, total, status, payment_status, customer_name')
    .eq('id', orderId)
    .single();

  if (orderError || !order) {
    return json(res, 404, { error: 'Order not found' });
  }

  // Authorized if: admin/finance staff (generating on a customer's behalf), OR the
  // customer generating a link for their OWN order (self-checkout flow). Never anyone else's.
  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('is_admin')
    .eq('id', adminUserId)
    .single();
  const { data: hasFinanceAccess } = await supabaseAdmin.rpc('has_admin_permission', { module: 'finance' });
  const isStaff = !profileError && (profile?.is_admin || hasFinanceAccess);
  const isOwnOrder = order.user_id === adminUserId;

  if (!isStaff && !isOwnOrder) {
    return json(res, 403, { error: 'Not authorized to generate a payment link for this order.' });
  }

  // ---- 4. Verify the order is actually payable ----
  if (order.payment_status === 'paid') {
    return json(res, 409, { error: 'This order has already been paid.' });
  }
  if (NON_PAYABLE_STATUSES.has(order.status)) {
    return json(res, 409, { error: `This order is ${order.status} and can no longer be paid for.` });
  }

  const amount = Number(order.total);
  if (!amount || amount <= 0) {
    return json(res, 400, { error: 'Order has no payable amount.' });
  }

  // ---- 5. Duplicate-link prevention — reuse an existing active link unless explicitly told not to ----
  const { data: existingLinks } = await supabaseAdmin
    .from('payu_payment_links')
    .select('*')
    .eq('order_id', orderId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1);

  const existingLink = existingLinks && existingLinks[0];
  if (existingLink && !regenerate) {
    return json(res, 200, {
      reused: true,
      id: existingLink.id,
      paymentLink: existingLink.payment_link,
      invoiceNumber: existingLink.invoice_number,
      amount: existingLink.amount,
      expiryDate: existingLink.expiry_date
    });
  }

  if (existingLink && regenerate) {
    // Explicit request for a new link — retire the old one rather than deleting it,
    // so the audit trail (who generated what, when) stays intact.
    await supabaseAdmin.from('payu_payment_links').update({ status: 'cancelled' }).eq('id', existingLink.id);
  }

  // ---- 6. Fetch customer contact info for the payment link ----
  const { data: customerProfile } = await supabaseAdmin
    .from('profiles')
    .select('full_name, email, phone')
    .eq('id', order.user_id)
    .single();

  const invoiceNumber = generateInvoiceNumber(order.order_number);
  const SITE_URL = process.env.SITE_URL || 'https://laizalifestyle.com';

  // ---- 7 & 8. Get a PayU access token, then create the payment link ----
  let accessToken, payuResult;
  try {
    accessToken = await getPayUAccessToken(PAYU_ENV);

    const payuResp = await fetch(PAYU_LINK_URLS[PAYU_ENV], {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'merchantId': process.env.PAYU_MERCHANT_ID
      },
      body: JSON.stringify({
        invoiceNumber,
        isAmountFilledByCustomer: false,
        subAmount: amount,
        description: `Payment for order ${order.order_number}`,
        source: 'API',
        isPartialPaymentAllowed: false,
        customer: {
          name: customerProfile?.full_name || order.customer_name || 'Customer',
          email: customerProfile?.email || undefined,
          phone: customerProfile?.phone || undefined
        },
        udf: { udf1: order.id, udf2: order.order_number },
        successUrl: `${SITE_URL}/?payment=success&order=${encodeURIComponent(order.order_number)}`,
        failureUrl: `${SITE_URL}/?payment=failed&order=${encodeURIComponent(order.order_number)}`
      })
    });

    payuResult = await payuResp.json();

    if (!payuResp.ok || payuResult.status !== 0 || !payuResult.result?.paymentLink) {
      const failMessage = payuResult.message || 'PayU declined to create the payment link';
      await supabaseAdmin.from('payu_payment_links').insert({
        order_id: orderId,
        invoice_number: invoiceNumber,
        amount,
        status: 'failed',
        payu_raw_response: payuResult,
        error_message: failMessage,
        created_by: adminUserId
      });
      return json(res, 502, { error: failMessage });
    }
  } catch (err) {
    await supabaseAdmin.from('payu_payment_links').insert({
      order_id: orderId,
      invoice_number: invoiceNumber,
      amount,
      status: 'failed',
      error_message: err.message,
      created_by: adminUserId
    });
    return json(res, 502, { error: 'Could not reach PayU: ' + err.message });
  }

  // ---- 9. Save the successful result ----
  const { data: savedLink, error: saveError } = await supabaseAdmin
    .from('payu_payment_links')
    .insert({
      order_id: orderId,
      invoice_number: invoiceNumber,
      payment_link: payuResult.result.paymentLink,
      amount,
      status: 'active',
      payu_raw_response: payuResult.result,
      expiry_date: payuResult.result.expiryDate || null,
      created_by: adminUserId
    })
    .select()
    .single();

  if (saveError) {
    // The link WAS created on PayU's side even though our save failed — surface both facts
    // rather than silently losing track of a real, live payment link.
    return json(res, 500, {
      error: 'Payment link was created on PayU but could not be saved: ' + saveError.message,
      paymentLink: payuResult.result.paymentLink,
      invoiceNumber
    });
  }

  // ---- 10. Return the payment URL to the admin panel ----
  return json(res, 200, {
    reused: false,
    id: savedLink.id,
    paymentLink: savedLink.payment_link,
    invoiceNumber: savedLink.invoice_number,
    amount: savedLink.amount,
    expiryDate: savedLink.expiry_date
  });
};
                                                     
