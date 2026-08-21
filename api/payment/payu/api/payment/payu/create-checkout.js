// POST /api/payment/payu/create-checkout
//
// Builds a PayU Hosted Checkout (classic `_payment`) form for an existing
// PENDING order. Unlike create-link.js (which uses PayU's "Payment Links"
// product — no real redirect-back support), Hosted Checkout DOES redirect
// the customer's browser back to your site via surl/furl, because the
// checkout happens live in the customer's own browser session instead of
// being a shareable link opened later.
//
// This returns the exact fields the frontend must POST (as a real HTML form,
// not fetch/XHR) to PayU's `_payment` endpoint, including a server-computed
// hash. It does not call any PayU API — Hosted Checkout requires no token,
// just a correctly hashed form submitted directly to PayU by the browser.
//
// Required Vercel Environment Variables (Project Settings → Environment
// Variables — NOT the same credentials as create-link.js):
//
//   PAYU_MERCHANT_KEY        - Classic Merchant Key (PayU Dashboard → Merchant Key & Salt)
//   PAYU_MERCHANT_SALT       - Classic Salt, ideally Salt V2 (same place)
//   PAYU_ENV                 - "test" or "production" (defaults to "test")
//   SUPABASE_URL              - Same as create-link.js
//   SUPABASE_SERVICE_ROLE_KEY - Same as create-link.js
//   SITE_URL                  - Defaults to https://laizalifestyle.com
//
// PAYU_MERCHANT_KEY/SALT are DIFFERENT from PAYU_CLIENT_ID/PAYU_CLIENT_SECRET
// (those are only for the OAuth-based Payment Links API used by create-link.js).
// Find Merchant Key & Salt in the PayU dashboard, not the Payment Links section.

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const PAYU_CHECKOUT_URLS = {
  test: 'https://test.payu.in/_payment',
  production: 'https://secure.payu.in/_payment'
};

const NON_PAYABLE_STATUSES = new Set(['cancelled', 'refunded', 'returned']);

function json(res, statusCode, body) {
  res.status(statusCode).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

function generateTxnId(orderNumber) {
  const cleanOrderNumber = String(orderNumber).replace(/[^a-zA-Z0-9]/g, '');
  const suffix = Date.now().toString(36).toUpperCase();
  return `TXN${cleanOrderNumber}${suffix}`.slice(0, 50);
}

// sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT)
// See: https://docs.payu.in/docs/hashing-request-and-response
function generateHash({ key, txnid, amount, productinfo, firstname, email, udf1, udf2, salt }) {
  const str = [
    key, txnid, amount, productinfo, firstname, email,
    udf1 || '', udf2 || '', '', '', '', '', '', '', '', '', salt
  ].join('|');
  return crypto.createHash('sha512').update(str, 'utf8').digest('hex');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const PAYU_ENV = (process.env.PAYU_ENV || 'test').toLowerCase() === 'production' ? 'production' : 'test';
  const SITE_URL = process.env.SITE_URL || 'https://laizalifestyle.com';

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !process.env.PAYU_MERCHANT_KEY || !process.env.PAYU_MERCHANT_SALT) {
    return json(res, 500, { error: 'Server is not configured for PayU Hosted Checkout. Missing required environment variables.' });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // ---- 1. Authenticate the customer ----
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return json(res, 401, { error: 'Missing Authorization header' });
  }
  const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !userData?.user) {
    return json(res, 401, { error: 'Invalid or expired session' });
  }
  const userId = userData.user.id;

  // ---- 2. Parse input — orderId ONLY. Amount is never accepted from the client. ----
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return json(res, 400, { error: 'Invalid JSON body' });
  }
  const { orderId } = body;
  if (!orderId || typeof orderId !== 'string') {
    return json(res, 400, { error: 'orderId is required' });
  }

  // ---- 3. Fetch the order — the ONLY source of truth for amount ----
  const { data: order, error: orderError } = await supabaseAdmin
    .from('orders')
    .select('id, order_number, user_id, total, status, payment_status')
    .eq('id', orderId)
    .single();

  if (orderError || !order) {
    return json(res, 404, { error: 'Order not found' });
  }
  if (order.user_id !== userId) {
    return json(res, 403, { error: 'Not authorized to pay for this order.' });
  }
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

  // ---- 4. Customer contact info (required by Hosted Checkout) ----
  const { data: profile } = await supabaseAdmin
    .from('profiles').select('full_name, email, phone').eq('id', userId).single();

  const firstname = (profile?.full_name || 'Customer').split(' ')[0].slice(0, 60);
  const email = profile?.email || userData.user.email || '';
  const phone = (profile?.phone || '').replace(/\D/g, '').slice(-10);

  if (!email) {
    return json(res, 400, { error: 'A valid email is required to start payment. Please update your profile.' });
  }

  const key = process.env.PAYU_MERCHANT_KEY;
  const salt = process.env.PAYU_MERCHANT_SALT;
  const txnid = generateTxnId(order.order_number);
  const productinfo = `Order ${order.order_number}`;
  const amountStr = amount.toFixed(2);

  // udf1 = order id, udf2 = order number — returned unchanged by PayU in the response,
  // and part of the hash, so return.js can verify + look up the order without trusting
  // anything else in the POST body.
  const udf1 = order.id;
  const udf2 = order.order_number;

  const hash = generateHash({ key, txnid, amount: amountStr, productinfo, firstname, email, udf1, udf2, salt });

  // ---- 5. Log the attempt (mirrors payu_webhook_attempts — lets you confirm from
  // Supabase alone whether a checkout was ever initiated for this order) ----
  await supabaseAdmin.from('payu_checkout_attempts').insert({
    order_id: order.id,
    txnid,
    amount: amountStr,
    created_by: userId
  }).select().maybeSingle().then(() => {}, () => {});
  // (best-effort — table may not exist yet; see migration note below)

  return json(res, 200, {
    action: PAYU_CHECKOUT_URLS[PAYU_ENV],
    params: {
      key, txnid, amount: amountStr, productinfo, firstname, email, phone,
      surl: `${SITE_URL}/api/payment/payu/return`,
      furl: `${SITE_URL}/api/payment/payu/return`,
      udf1, udf2, hash
    }
  });
};
    
