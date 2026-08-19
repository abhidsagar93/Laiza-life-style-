// POST /api/payment/payu/webhook
//
// PayU calls THIS endpoint automatically whenever a payment succeeds or fails —
// no admin action needed. This is what actually closes the loop: create-link.js
// only creates the link; this file is what marks the order paid.
//
// Required NEW Vercel Environment Variables (in addition to the ones create-link.js uses):
//
//   PAYU_KEY   - Your classic PayU "Merchant Key" (NOT the OAuth Client ID — a
//                separate, older-style credential PayU still uses for webhook
//                hash verification). Find it on your dashboard, often labelled
//                "Merchant Key" or under Account Details, separate from the
//                API/OAuth Client ID & Secret used for Payment Links creation.
//   PAYU_SALT  - The Salt paired with that Merchant Key. Also from your dashboard.
//                NEVER share this value or commit it anywhere.
//
// SECURITY MODEL — read before touching this file:
// PayU's webhook payload includes a `hash` field. We recompute that hash
// ourselves using PAYU_SALT (a secret only we and PayU know) and the payload's
// own fields. If our computed hash doesn't match what PayU sent, we DO NOT
// trust the payload — full stop, no exceptions, no "trust it anyway" fallback.
// This is what stops anyone from POSTing a fake "payment successful" request
// to this public URL and getting an order marked as paid for free.
//
// This endpoint FAILS CLOSED: if anything is ambiguous or unverifiable, the
// order is simply left as-is (still "pending") rather than guessed into "paid".
// A missed auto-update is an annoyance an admin can fix manually with the
// existing Order Status dropdown; a forged "paid" mark is a real loss.

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

function json(res, statusCode, body) {
  res.status(statusCode).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

// Parses the incoming request body regardless of how Vercel/the browser delivered it —
// PayU sends application/x-www-form-urlencoded for payment success/failure events.
function parsePayload(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body; // Vercel already parsed it (JSON or urlencoded)
  }
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  const params = new URLSearchParams(raw);
  const out = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

// PayU's documented "reverse hash" formula for the payment response/webhook:
// SHA512( salt|status|udf10|udf9|udf8|udf7|udf6|udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key )
function computeResponseHash(payload, salt) {
  const fields = [
    salt,
    payload.status || '',
    payload.udf10 || '', payload.udf9 || '', payload.udf8 || '', payload.udf7 || '', payload.udf6 || '',
    payload.udf5 || '', payload.udf4 || '', payload.udf3 || '', payload.udf2 || '', payload.udf1 || '',
    payload.email || '',
    payload.firstname || '',
    payload.productinfo || '',
    payload.amount || '',
    payload.txnid || '',
    payload.key || ''
  ];
  return crypto.createHash('sha512').update(fields.join('|')).digest('hex');
}

module.exports = async function handler(req, res) {
  // Always respond quickly — PayU retries 3 times on anything other than a fast 200,
  // and we don't want business-logic edge cases (order not found, etc.) to trigger
  // needless retries. We return 200 in every case where we've validly PROCESSED the
  // callback, even if the outcome was "nothing to do."
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const PAYU_SALT = process.env.PAYU_SALT;

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !PAYU_SALT) {
    console.error('PayU webhook: missing required environment variables');
    return json(res, 200, { received: true, processed: false, reason: 'server not configured' });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const payload = parsePayload(req);

  // ---- Verify this genuinely came from PayU before trusting ANYTHING in it ----
  const receivedHash = (payload.hash || '').toLowerCase();
  const expectedHash = computeResponseHash(payload, PAYU_SALT);

  if (!receivedHash || receivedHash !== expectedHash) {
    console.error('PayU webhook: hash verification FAILED — payload rejected as untrusted', {
      txnid: payload.txnid, udf1: payload.udf1
    });
    // Still 200 — we don't want PayU retrying a request that will never verify.
    // The order is simply left untouched.
    return json(res, 200, { received: true, processed: false, reason: 'hash verification failed' });
  }

  // ---- We now trust this payload. Find which order it belongs to. ----
  // udf1 was set to the order's UUID when we created the payment link (see create-link.js).
  const orderId = payload.udf1;
  if (!orderId) {
    console.error('PayU webhook: verified payload had no udf1 (order id) — cannot match to an order');
    return json(res, 200, { received: true, processed: false, reason: 'missing order reference' });
  }

  const { data: order } = await supabaseAdmin
    .from('orders')
    .select('id, order_number, payment_status')
    .eq('id', orderId)
    .single();

  if (!order) {
    console.error('PayU webhook: verified payload referenced an order that no longer exists', { orderId });
    return json(res, 200, { received: true, processed: false, reason: 'order not found' });
  }

  const isSuccess = (payload.status || '').toLowerCase() === 'success';
  const isFailure = (payload.status || '').toLowerCase() === 'failure';

  // Never downgrade an already-paid order, even on a stray duplicate/failure callback
  if (order.payment_status === 'paid') {
    return json(res, 200, { received: true, processed: false, reason: 'order already marked paid' });
  }

  if (isSuccess) {
    await supabaseAdmin
      .from('orders')
      .update({ payment_status: 'paid' })
      .eq('id', orderId);

    await supabaseAdmin
      .from('payu_payment_links')
      .update({
        status: 'paid',
        payu_raw_response: payload
      })
      .eq('order_id', orderId)
      .eq('status', 'active');

    return json(res, 200, { received: true, processed: true, result: 'order marked paid' });
  }

  if (isFailure) {
    // Payment failed — order stays pending so the admin can share the link again
    // or generate a new one. We log the attempt for visibility but don't change status.
    await supabaseAdmin
      .from('payu_payment_links')
      .update({ payu_raw_response: payload })
      .eq('order_id', orderId)
      .eq('status', 'active');

    return json(res, 200, { received: true, processed: true, result: 'payment failure recorded, order left pending' });
  }

  // Any other status (e.g. "pending") — acknowledge, do nothing yet
  return json(res, 200, { received: true, processed: false, reason: `status was "${payload.status}", no action taken` });
};
    
