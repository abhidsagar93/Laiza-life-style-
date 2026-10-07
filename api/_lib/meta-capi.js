// api/_lib/meta-capi.js
//
// Sends the "Purchase" event to Meta from the SERVER (Meta Conversions API), as a
// back-up to the browser Pixel. Meta counts an order once even when both arrive,
// because both use the same event ID (the order number).
//
// Why: ad blockers, iPhone privacy settings and customers who pay on PayU but never
// come back to the site all stop the browser Pixel. The server copy still reaches
// Meta, so your ads learn from every real sale.
//
// Vercel environment variables:
//   META_CAPI_TOKEN   (required) access token from Events Manager → dataset → Settings
//                     → Conversions API → "Generate access token". Paste ONLY in Vercel.
//   META_PIXEL_ID     (optional) defaults to the Laiza dataset 2180019866727441
//   META_TEST_EVENT_CODE (optional) e.g. TEST12345 — only while testing in "Test events";
//                     remove it afterwards.
//
// Customer details (email, phone, name, city…) are SHA-256 hashed before sending,
// as Meta requires. Every attempt is logged in notification_log (channel "meta").

const crypto = require('crypto');

const DEFAULT_PIXEL_ID = '2180019866727441';
const SITE_URL = 'https://laizalifestyle.com';

const sha = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const norm = v => String(v || '').trim().toLowerCase();
const hashed = v => (norm(v) ? [sha(norm(v))] : undefined);

function phoneE164(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 10) return '91' + d;
  if (d.length === 12 && d.startsWith('91')) return d;
  return d || '';
}

function splitName(full) {
  const parts = norm(full).replace(/\(guest\)/g, '').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  return { fn: parts[0] || '', ln: parts.length > 1 ? parts[parts.length - 1] : '' };
}

async function sendMetaPurchase(supabaseAdmin, orderId) {
  const token = process.env.META_CAPI_TOKEN;
  const pixelId = process.env.META_PIXEL_ID || DEFAULT_PIXEL_ID;

  const log = (status, detail) => supabaseAdmin.from('notification_log').insert({
    order_id: orderId, event: 'meta_purchase', channel: 'meta', recipient: 'Meta Conversions API', status, detail: detail || null
  });

  if (!token) { await log('skipped', 'META_CAPI_TOKEN not set in Vercel'); return; }

  const { data: already } = await supabaseAdmin.from('notification_log').select('id')
    .eq('order_id', orderId).eq('event', 'meta_purchase').eq('status', 'sent').limit(1);
  if (already && already.length) return;

  const { data: o } = await supabaseAdmin.from('orders')
    .select('id, user_id, order_number, total, created_at, payment_method, customer_email, customer_name, shipping_full_name, shipping_phone, shipping_city, shipping_state, shipping_pincode, meta_ctx')
    .eq('id', orderId).maybeSingle();
  if (!o) return;

  let email = o.customer_email, phone = o.shipping_phone;
  if (o.user_id && (!email || !phone)) {
    const { data: p } = await supabaseAdmin.from('profiles').select('email, phone').eq('id', o.user_id).maybeSingle();
    email = email || p?.email; phone = phone || p?.phone;
  }
  const { data: items } = await supabaseAdmin.from('order_items')
    .select('product_id, quantity, unit_price').eq('order_id', orderId);

  const ctx = o.meta_ctx || {};
  const { fn, ln } = splitName(o.shipping_full_name || o.customer_name);
  const user_data = {
    em: hashed(email),
    ph: phoneE164(phone) ? [sha(phoneE164(phone))] : undefined,
    fn: fn ? [sha(fn)] : undefined,
    ln: ln ? [sha(ln)] : undefined,
    ct: hashed(String(o.shipping_city || '').replace(/[^a-zA-Z]/g, '')),
    st: hashed(String(o.shipping_state || '').replace(/[^a-zA-Z]/g, '')),
    zp: hashed(String(o.shipping_pincode || '').replace(/\D/g, '')),
    country: [sha('in')],
    external_id: o.user_id ? [sha(o.user_id)] : (phoneE164(phone) ? [sha('ph' + phoneE164(phone))] : undefined),
    client_ip_address: ctx.ip || undefined,
    client_user_agent: ctx.ua || undefined,
    fbp: ctx.fbp || undefined,
    fbc: ctx.fbc || undefined
  };
  Object.keys(user_data).forEach(k => user_data[k] === undefined && delete user_data[k]);

  const contents = (items || []).filter(i => i.product_id).map(i => ({ id: i.product_id, quantity: Number(i.quantity) || 1, item_price: Number(i.unit_price) || 0 }));
  const created = Math.floor(new Date(o.created_at).getTime() / 1000);
  const now = Math.floor(Date.now() / 1000);

  const event = {
    event_name: 'Purchase',
    event_time: Math.min(now, Math.max(created, now - 6 * 24 * 3600)), // Meta accepts up to 7 days old
    event_id: String(o.order_number),           // same ID the browser Pixel uses → no double counting
    action_source: 'website',
    event_source_url: ctx.url || SITE_URL + '/',
    user_data,
    custom_data: {
      currency: 'INR',
      value: Number(o.total) || 0,
      order_id: String(o.order_number),
      content_type: 'product',
      content_ids: contents.map(c => c.id),
      contents,
      num_items: contents.reduce((a, c) => a + c.quantity, 0)
    }
  };

  const body = { data: [event] };
  if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;

  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    await log(r.ok ? 'sent' : 'failed', r.ok ? `events_received: ${data.events_received ?? '?'}` : JSON.stringify(data).slice(0, 500));
  } catch (err) {
    await log('failed', err.message);
  }
}

module.exports = { sendMetaPurchase };
