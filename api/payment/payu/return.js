// POST/GET /api/payment/payu/return
//
// This is the surl AND furl target for PayU Hosted Checkout — the URL PayU
// actually redirects the customer's browser to after payment.
//
// PayU POSTs (sometimes GETs) the transaction result here with a reverse
// hash. This handler verifies that hash, then 302-redirects the browser to
// your real site with a simple ?payment=success|failed&order=... — which is
// exactly what checkForPaymentReturn() in index.html already expects.
//
// IMPORTANT: this endpoint is a UX convenience only. It never sets
// payment_status itself to "paid" — that stays the job of the async webhook
// (server-to-server, independent of whether the customer's browser ever
// makes it back here). This just verifies + redirects.
//
// Required Vercel Environment Variables:
//   PAYU_MERCHANT_SALT  - Classic Salt (PayU Dashboard → Merchant Key & Salt)
//   SITE_URL            - Defaults to https://laizalifestyle.com

const crypto = require('crypto');

// Reverse hash order per PayU's actual spec (verified against webhook.js, which uses
// the identical formula and is confirmed working correctly against live transactions):
// sha512(SALT|status|udf10|udf9|udf8|udf7|udf6|udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
//
// PREVIOUS BUG: this formula only had 5 empty pipe-separated fields between `status` and
// `udf2` instead of the required 8 (for udf10 down to udf3). That misalignment meant the
// computed hash could never match PayU's real one, so this endpoint told customers their
// payment had failed even when it had genuinely succeeded (confirmed paid via webhook).
function verifyReverseHash({ key, txnid, amount, productinfo, firstname, email, udf1, udf2, status, hash, salt }) {
  const str = [
    salt, status, '', '', '', '', '', '', '', '', udf2 || '', udf1 || '',
    email, firstname, productinfo, amount, txnid, key
  ].join('|');
  const expected = crypto.createHash('sha512').update(str, 'utf8').digest('hex');
  return expected.toLowerCase() === String(hash || '').toLowerCase();
}

module.exports = async function handler(req, res) {
  const SITE_URL = process.env.SITE_URL || 'https://laizalifestyle.com';
  const salt = process.env.PAYU_MERCHANT_SALT;

  const data = { ...req.query, ...(req.body || {}) };
  const { key, txnid, amount, productinfo, firstname, email, udf1, udf2, status, hash } = data;

  if (!salt || !key || !txnid || !hash) {
    res.writeHead(302, { Location: `${SITE_URL}/?payment=failed` });
    return res.end();
  }

  const orderNumber = udf2 || '';
  const hashOk = verifyReverseHash({ key, txnid, amount, productinfo, firstname, email, udf1, udf2, status, hash, salt });

  if (!hashOk) {
    res.writeHead(302, { Location: `${SITE_URL}/?payment=failed&order=${encodeURIComponent(orderNumber)}` });
    return res.end();
  }

  const outcome = status === 'success' ? 'success' : 'failed';
  res.writeHead(302, { Location: `${SITE_URL}/?payment=${outcome}&order=${encodeURIComponent(orderNumber)}` });
  return res.end();
};
