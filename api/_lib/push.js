// api/_lib/push.js
//
// Web Push for the LAIZA admin app: shows "New order …" on the Proprietor's phone even when the
// admin is closed. Written with Node's built-in crypto (no extra npm package):
//   - message encryption: RFC 8291 (aes128gcm)
//   - sender identification: VAPID, RFC 8292 (ES256 JWT)
// Vercel env vars (set by the Proprietor; keys are created in the admin, never shared in chat):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY   (base64url, P-256)
//   VAPID_SUBJECT (optional, default mailto:laizalifestyle@gmail.com)
// Phones that turned alerts on are stored in table lz_push_subs (push_alerts.sql).

const crypto = require('crypto');

const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function unb64u(s) { s = String(s || '').replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Buffer.from(s, 'base64'); }
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function vapidHeader(endpoint, pubB64, privB64, subject) {
  const pub = unb64u(pubB64);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY is not a valid P-256 public key');
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: b64u(unb64u(privB64)) };
  const key = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${pubB64}`;
}

// RFC 8291 encryption. `fixed` (salt + server private key) is only used by the self-test.
function encrypt(payload, p256dhB64, authB64, fixed) {
  const uaPublic = unb64u(p256dhB64), authSecret = unb64u(authB64);
  const ecdh = crypto.createECDH('prime256v1');
  if (fixed && fixed.asPrivate) ecdh.setPrivateKey(unb64u(fixed.asPrivate)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = fixed && fixed.salt ? unb64u(fixed.salt) : crypto.randomBytes(16);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])])).subarray(0, 32);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

async function sendOne(sub, payload) {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  const subject = process.env.VAPID_SUBJECT || 'mailto:laizalifestyle@gmail.com';
  const body = encrypt(JSON.stringify(payload), sub.p256dh, sub.auth);
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      Authorization: vapidHeader(sub.endpoint, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, subject)
    },
    body
  });
  return { status: r.status, text: r.ok ? '' : (await r.text().catch(() => '')).slice(0, 300) };
}

// Send to every subscribed admin phone. Removes phones that unsubscribed (404/410).
async function pushToAdmins(supabaseAdmin, payload, onlyUserId) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return { sent: 0, skipped: 'VAPID keys not set in Vercel' };
  let q = supabaseAdmin.from('lz_push_subs').select('id, endpoint, p256dh, auth');
  if (onlyUserId) q = q.eq('user_id', onlyUserId);
  const { data: subs, error } = await q;
  if (error) return { sent: 0, skipped: 'lz_push_subs: ' + error.message };
  let sent = 0; const failed = [];
  for (const s of subs || []) {
    try {
      const r = await sendOne(s, payload);
      if (r.status >= 200 && r.status < 300) sent++;
      else { failed.push(r.status + ' ' + r.text); if (r.status === 404 || r.status === 410) await supabaseAdmin.from('lz_push_subs').delete().eq('id', s.id); }
    } catch (e) { failed.push(e.message); }
  }
  return { sent, devices: (subs || []).length, failed };
}

// "New order" alert — once per order (logged in notification_log as admin_push).
async function pushNewOrder(supabaseAdmin, orderId) {
  const { data: done } = await supabaseAdmin.from('notification_log').select('id').eq('order_id', orderId).eq('event', 'admin_push').eq('status', 'sent').limit(1);
  if (done && done.length) return;
  const { data: o } = await supabaseAdmin.from('orders')
    .select('order_number, total, payment_method, shipping_full_name, customer_name, shipping_city').eq('id', orderId).maybeSingle();
  if (!o) return;
  const cod = /cash on delivery|\bcod\b/i.test(o.payment_method || '');
  const amt = '₹' + Number(o.total || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const res = await pushToAdmins(supabaseAdmin, {
    title: `🛍️ New order · ${amt} · ${cod ? 'COD' : 'Paid'}`,
    body: `${o.order_number} — ${o.shipping_full_name || o.customer_name || 'Customer'}${o.shipping_city ? ', ' + o.shipping_city : ''}`,
    url: '/admin?order=' + encodeURIComponent(o.order_number), tag: 'order-' + o.order_number
  });
  await supabaseAdmin.from('notification_log').insert({
    order_id: orderId, event: 'admin_push', channel: 'push', recipient: (res.devices || 0) + ' device(s)',
    status: res.sent ? 'sent' : (res.skipped ? 'skipped' : 'failed'), detail: res.skipped || (res.failed || []).join(' | ').slice(0, 500) || null
  });
}

module.exports = { pushToAdmins, pushNewOrder, encrypt, vapidHeader, unb64u, b64u };
