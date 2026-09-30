// api/shipping/ithink/sync-tracking.js
//
// Keeps order statuses in step with iThink Logistics automatically.
// Called every 2 hours by a scheduled job in Supabase (pg_cron), so nobody has to
// change "Shipped / Out for Delivery / Delivered / Returned" by hand.
//
// For every order that has an AWB and isn't finished yet:
//   1. Ask iThink's track API for the latest status (10 AWBs per request — their limit)
//   2. Map it to our order status, only ever moving FORWARD (never back from Delivered etc.)
//   3. Save the new status, write a line in order_status_history, update delivery_orders
//   4. When an order becomes Delivered, send the customer the "Delivered" email/WhatsApp
//
// Required Vercel environment variables:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ITHINK_ACCESS_TOKEN, ITHINK_SECRET_KEY, ITHINK_ENV
//   TRACKING_SYNC_SECRET  — shared secret; the scheduled job sends it in the
//                           "x-sync-secret" header. Requests without it are refused.

const { createClient } = require('@supabase/supabase-js');
const { notifyOrder } = require('../../_lib/notify');

// iThink's docs list the track API on api.ithinklogistics.com; the rest of our calls use
// my.ithinklogistics.com. Try the documented host first and fall back to the other.
const TRACK_URLS = process.env.ITHINK_ENV === 'production'
  ? ['https://api.ithinklogistics.com/api_v3/order/track.json', 'https://my.ithinklogistics.com/api_v3/order/track.json']
  : ['https://pre-alpha.ithinklogistics.com/api_v3/order/track.json'];

// Statuses we never touch again once reached.
const FINAL = ['delivered', 'cancelled', 'returned', 'refunded'];

// Forward-only ordering for the in-flight statuses.
const RANK = {
  pending: 0, confirmed: 1, processing: 2, packed: 3, ready_for_dispatch: 4,
  shipped: 5, out_for_delivery: 6, delivered: 7, returned: 7
};

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

// Turn iThink's tracking entry into one of our order statuses (or null = no change).
function mapStatus(t) {
  const code = String(t.current_status_code || '').toUpperCase();
  const text = String(t.current_status || t.last_scan_details?.status || '').toLowerCase();

  if (code === 'DL') {
    // A delivered *return* is a returned order, not a delivered one.
    return (String(t.order_type || '').toLowerCase() === 'reverse' || text.includes('rto')) ? 'returned' : 'delivered';
  }
  if (code === 'RT' || text.includes('rto')) return 'returned';
  if (code === 'CN') return null; // shipment cancelled in iThink — flagged in history, order left alone
  if (text.includes('out for delivery') || text.includes('ofd')) return 'out_for_delivery';
  if (text.includes('picked') || text.includes('transit') || text.includes('dispatched')
      || text.includes('reached') || text.includes('undelivered') || text.includes('shipped')) return 'shipped';
  return null; // manifested / pickup pending etc. — nothing to change yet
}

async function trackBatch(awbs, creds) {
  let lastErr = null;
  for (const url of TRACK_URLS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { awb_number_list: awbs.join(','), ...creds } })
      });
      const data = await r.json();
      if (data && data.data && typeof data.data === 'object') return data.data;
      lastErr = data?.html_message || JSON.stringify(data).slice(0, 300);
    } catch (err) {
      lastErr = err.message;
    }
  }
  throw new Error(`iThink track failed: ${lastErr}`);
}

module.exports = async (req, res) => {
  const secret = process.env.TRACKING_SYNC_SECRET;
  if (!secret || req.headers['x-sync-secret'] !== secret) {
    return json(res, 401, { error: 'Unauthorized' });
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ITHINK_ACCESS_TOKEN, ITHINK_SECRET_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ITHINK_ACCESS_TOKEN || !ITHINK_SECRET_KEY) {
    return json(res, 500, { error: 'Server is not configured correctly.' });
  }
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const creds = { access_token: ITHINK_ACCESS_TOKEN, secret_key: ITHINK_SECRET_KEY };

  const { data: orders, error } = await supabaseAdmin
    .from('orders')
    .select('id, order_number, status, awb_code')
    .not('awb_code', 'is', null)
    .not('status', 'in', `(${FINAL.join(',')})`)
    .limit(200);
  if (error) return json(res, 500, { error: error.message });
  if (!orders || orders.length === 0) return json(res, 200, { checked: 0, updated: 0 });

  const byAwb = Object.fromEntries(orders.map(o => [String(o.awb_code), o]));
  const awbs = Object.keys(byAwb);
  const changes = [];
  const problems = [];

  for (let i = 0; i < awbs.length; i += 10) {
    let result;
    try {
      result = await trackBatch(awbs.slice(i, i + 10), creds);
    } catch (err) {
      problems.push(err.message);
      continue;
    }

    for (const [awb, t] of Object.entries(result)) {
      const order = byAwb[awb];
      if (!order || !t || String(t.message || '').toLowerCase() !== 'success') continue;

      const ithinkText = t.current_status || t.last_scan_details?.status || '';
      const code = String(t.current_status_code || '').toUpperCase();

      // Shipment cancelled / lost / shortage: don't guess the order status — just flag it.
      if (code === 'CN' || /lost|shortage/i.test(code) || /lost|shortage/i.test(ithinkText)) {
        const note = `iThink reports: ${ithinkText || code}. Please check this shipment.`;
        const { data: seen } = await supabaseAdmin.from('order_status_history')
          .select('id').eq('order_id', order.id).eq('note', note).limit(1);
        if (!seen || !seen.length) {
          await supabaseAdmin.from('order_status_history').insert({ order_id: order.id, status: order.status, note });
          problems.push(`${order.order_number}: ${ithinkText || code}`);
        }
        continue;
      }

      const next = mapStatus(t);
      if (!next || next === order.status) continue;
      if ((RANK[next] ?? 0) <= (RANK[order.status] ?? 0) && next !== 'returned') continue; // forward only

      const scan = t.last_scan_details || {};
      const note = `Auto-update from iThink: ${ithinkText}${scan.scan_location ? ' — ' + scan.scan_location : ''}${scan.status_date_time ? ' (' + scan.status_date_time + ')' : ''}`;

      await supabaseAdmin.from('orders').update({ status: next }).eq('id', order.id);
      await supabaseAdmin.from('order_status_history').insert({ order_id: order.id, status: next, note });

      const deliveryUpdate = { status: ithinkText || next };
      if (next === 'delivered') deliveryUpdate.delivered_at = new Date().toISOString();
      if (next === 'shipped') deliveryUpdate.shipped_at = new Date().toISOString();
      await supabaseAdmin.from('delivery_orders').update(deliveryUpdate).eq('order_id', order.id);

      if (next === 'delivered') {
        try {
          await notifyOrder(supabaseAdmin, order.id, 'delivered');
        } catch (err) {
          console.error('Delivered notification failed:', err.message);
        }
      }

      changes.push(`${order.order_number}: ${order.status} → ${next}`);
    }
  }

  if (problems.length) console.error('Tracking sync problems:', problems);
  return json(res, 200, { checked: awbs.length, updated: changes.length, changes, problems });
};
