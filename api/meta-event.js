// api/meta-event.js  →  POST /api/meta-event
//
// Server copy (Meta Conversions API) of the browsing events the website's Pixel sends:
// ViewContent, AddToCart, InitiateCheckout and Search. The browser sends the same
// event_id to the Pixel and here, so Meta counts each event once (deduplication) while
// ad blockers / iPhone privacy no longer hide it. Purchase is NOT handled here — it is
// sent from the order itself (api/_lib/meta-capi.js).
//
// Vercel env vars: META_CAPI_TOKEN (required), META_PIXEL_ID (optional),
// META_TEST_EVENT_CODE (optional, only while testing).

const DEFAULT_PIXEL_ID = '2180019866727441';
const ALLOWED = new Set(['ViewContent', 'AddToCart', 'InitiateCheckout', 'Search']);
const SITE_HOST = /(^|\.)laizalifestyle\.com$/i;

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const num = v => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : undefined);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).end(); return; }

  const token = process.env.META_CAPI_TOKEN;
  if (!token) { res.status(204).end(); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
  if (Buffer.isBuffer(body)) { try { body = JSON.parse(body.toString('utf8')); } catch (_) { body = null; } }
  if (!body || !ALLOWED.has(body.event)) { res.status(400).end(); return; }

  const eventId = str(body.event_id, 100);
  if (!eventId) { res.status(400).end(); return; }

  // Only accept events about our own site
  let url = str(body.url, 500) || 'https://laizalifestyle.com/';
  try { if (!SITE_HOST.test(new URL(url).hostname)) { res.status(400).end(); return; } } catch (_) { url = 'https://laizalifestyle.com/'; }

  const d = body.data && typeof body.data === 'object' ? body.data : {};
  const custom = {
    currency: 'INR',
    value: num(d.value),
    content_type: str(d.content_type, 20),
    content_name: str(d.content_name, 200),
    content_ids: Array.isArray(d.content_ids) ? d.content_ids.map(x => String(x).slice(0, 64)).slice(0, 20) : undefined,
    contents: Array.isArray(d.contents) ? d.contents.slice(0, 20).map(c => ({
      id: String(c && c.id || '').slice(0, 64), quantity: Math.max(1, parseInt(c && c.quantity, 10) || 1), item_price: num(c && c.item_price)
    })) : undefined,
    num_items: Number.isFinite(Number(d.num_items)) ? Number(d.num_items) : undefined,
    search_string: str(d.search_string, 100)
  };
  Object.keys(custom).forEach(k => custom[k] === undefined && delete custom[k]);
  if (body.event === 'Search') { delete custom.value; delete custom.currency; }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.headers['x-real-ip'];
  const user_data = {
    client_ip_address: ip || undefined,
    client_user_agent: str(req.headers['user-agent'], 400),
    fbp: str(body.fbp, 200),
    fbc: str(body.fbc, 400)
  };
  Object.keys(user_data).forEach(k => user_data[k] === undefined && delete user_data[k]);
  if (!user_data.client_ip_address || !user_data.client_user_agent) { res.status(204).end(); return; }

  const payload = {
    data: [{
      event_name: body.event,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: 'website',
      event_source_url: url,
      user_data,
      custom_data: custom
    }]
  };
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;

  try {
    const pixelId = process.env.META_PIXEL_ID || DEFAULT_PIXEL_ID;
    const r = await fetch(`https://graph.facebook.com/v21.0/${pixelId}/events?access_token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    if (!r.ok) console.error('meta-event failed', r.status, (await r.text()).slice(0, 300));
  } catch (err) {
    console.error('meta-event error', err.message);
  }
  res.status(204).end();
};
