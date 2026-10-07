// POST /api/notify/order-placed   body: { orderId, fbp?, fbc?, url? }
//
// Called by the website right after an order is created.
//  1. Saves the browser details Meta needs for matching (IP, browser, _fbp/_fbc cookies)
//     on the order, so the server "Purchase" event (Conversions API) can be matched to
//     the person who saw your ad — for COD and online orders alike.
//  2. Cash on Delivery: sends the "Order confirmed" email + admin alert + Meta Purchase now.
//     (Online/PayU orders get these from the PayU webhook once payment succeeds.)
//
// Safe to call publicly: only works for an order created in the last 30 minutes, only
// ever emails the address stored on that order, and nothing is ever sent twice.
// Vercel env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, META_CAPI_TOKEN

const { createClient } = require('@supabase/supabase-js');
const { notifyOrder } = require('../_lib/notify');

function json(res, code, body) {
  res.status(code).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

function cookie(req, name) {
  const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

const clean = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};
  const orderId = body.orderId;
  if (!orderId || !/^[0-9a-f-]{36}$/i.test(String(orderId))) return json(res, 400, { error: 'Invalid order' });

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return json(res, 500, { error: 'Server not configured' });
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  try {
    const { data: order } = await supabaseAdmin
      .from('orders').select('id, payment_method, status, created_at, meta_ctx').eq('id', orderId).maybeSingle();
    if (!order) return json(res, 404, { error: 'Not found' });

    const fresh = Date.now() - new Date(order.created_at).getTime() < 30 * 60 * 1000;
    if (!fresh) return json(res, 200, { ok: true, skipped: true });

    // 1. Remember the browser details for Meta (first call only)
    if (!order.meta_ctx) {
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.headers['x-real-ip'] || null;
      const ctx = {
        ip: clean(ip, 64),
        ua: clean(req.headers['user-agent'], 400),
        fbp: clean(body.fbp, 200) || cookie(req, '_fbp'),
        fbc: clean(body.fbc, 400) || cookie(req, '_fbc'),
        url: clean(body.url, 400)
      };
      await supabaseAdmin.from('orders').update({ meta_ctx: ctx }).eq('id', order.id);
    }

    // 2. COD: confirm now (email, admin alert, Meta Purchase)
    const isCod = /cash on delivery|\bcod\b/i.test(order.payment_method || '');
    if (!isCod || ['cancelled', 'refunded', 'returned'].includes(order.status)) {
      return json(res, 200, { ok: true, saved: true });
    }

    await notifyOrder(supabaseAdmin, order.id, 'confirmed');
    return json(res, 200, { ok: true });
  } catch (err) {
    console.error('order-placed notify failed', err);
    return json(res, 200, { ok: false });
  }
};
