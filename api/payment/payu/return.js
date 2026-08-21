// POST/GET /api/payment/payu/return
//
// This is the surl AND furl target for PayU Hosted Checkout — the URL PayU
// actually redirects the customer's browser to after payment, solving the
// "customer stuck on PayU's own page" problem that create-link.js's Payment
// Links product has no fix for.
//
// PayU POSTs (sometimes GETs) the transaction result here with a reverse
// hash. This handler verifies that hash, then 302-redirects the browser to
// your real site with a simple ?payment=success|failed&order=... — which is
// exactly what checkForPaymentReturn() in index.html already expects.
//
// IMPORTANT: this endpoint is a UX convenience only, same as the old
// checkForPaymentReturn() comment says. It never sets payment_status itself
// via a payment status update to "paid" — that stays the job of the async
// webhook (server-to-server, independent of whether the customer's browser
// ever makes it back here). This just verifies + redirects.
//
// Required Vercel Environment Variables (same PAYU_MERCHANT_KEY/SALT as
// create-checkout.js):
//
//   PAYU_MERCHANT_SALT  - Classic Salt (PayU Dashboard → Merchant Key & Salt)
//   SITE_URL            - Defaults to https://laizalifestyle.com

const crypto = require('crypto');

// Reverse hash order per PayU docs:
// sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
function verifyReverseHash({ key, txnid, amount, productinfo, firstname, email, udf1, udf2, status, hash, salt }) {
  const str = [
    salt, status, '', '', '', '', '', udf2 || '', udf1 || '',
    email, firstname, productinfo, amount, txnid, key
  ].join('|');
  const expected = crypto.createHash('sha512').update(str, 'utf8').digest('hex');
  return expected.toLowerCase() === String(hash || '').toLowerCase();
}

module.exports = async function handler(req, res) {
  const SITE_URL = process.env.SITE_URL || 'https://laizalifestyle.com';
  const salt = process.env.PAYU_MERCHANT_SALT;

  // PayU POSTs form-encoded data; some proxies/environments may forward it as
  // a query string on redirect too — check both.
  const data = { ...req.query, ...(req.body || {}) };
  const { key, txnid, amount, productinfo, firstname, email, udf1, udf2, status, hash } = data;

  if (!salt || !key || !txnid || !hash) {
    // Missing pieces — fail closed, send them to a generic failure landing rather
    // than guessing at success.
    res.writeHead(302, { Location: `${SITE_URL}/?payment=failed` });
    return res.end();
  }

  const orderNumber = udf2 || '';
  const hashOk = verifyReverseHash({ key, txnid, amount, productinfo, firstname, email, udf1, udf2, status, hash, salt });

  if (!hashOk) {
    // Hash mismatch — never trust this redirect's "status" field if the hash
    // doesn't check out. Send to failure; the real status still comes from the webhook.
    res.writeHead(302, { Location: `${SITE_URL}/?payment=failed&order=${encodeURIComponent(orderNumber)}` });
    return res.end();
  }

  const outcome = status === 'success' ? 'success' : 'failed';
  res.writeHead(302, { Location: `${SITE_URL}/?payment=${outcome}&order=${encodeURIComponent(orderNumber)}` });
  return res.end();
};

