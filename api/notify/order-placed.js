// POST /api/notify/order-placed   body: { orderId }
//
// Sends the "Order confirmed" email for Cash on Delivery orders right after checkout.
// (Online/PayU orders already get it from the PayU webhook once payment succeeds.)
//
// Safe to call publicly: it only ever emails the address stored on that order, only for
// a COD order placed in the last 30 minutes, and notifyOrder() never sends the same
// event twice for the same order. Uses the same Vercel env vars as the PayU webhook:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY

const { createClient } = require('@supabase/supabase-js');
const { notifyOrder } = require('../_lib/notify');

function json(res, code, body) {
  res.status(code).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const orderId = body && body.orderId;
  if (!orderId || !/^[0-9a-f-]{36}$/i.test(String(orderId))) return json(res, 400, { error: 'Invalid order' });

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return json(res, 500, { error: 'Server not configured' });
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  try {
    const { data: order } = await supabaseAdmin
      .from('orders').select('id, payment_method, status, created_at').eq('id', orderId).maybeSingle();
    if (!order) return json(res, 404, { error: 'Not found' });

    const isCod = /cash on delivery|\bcod\b/i.test(order.payment_method || '');
    const fresh = Date.now() - new Date(order.created_at).getTime() < 30 * 60 * 1000;
    if (!isCod || !fresh || ['cancelled', 'refunded', 'returned'].includes(order.status)) {
      return json(res, 200, { ok: true, skipped: true });
    }

    await notifyOrder(supabaseAdmin, order.id, 'confirmed');
    return json(res, 200, { ok: true });
  } catch (err) {
    console.error('order-placed notify failed', err);
    return json(res, 200, { ok: false });
  }
};
