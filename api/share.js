// api/share.js  →  small preview page for WhatsApp / Facebook / Instagram / Telegram link previews.
// vercel.json sends ONLY link-preview robots here (by user-agent). Real visitors and Google get the normal site.
// Uses existing Vercel env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
const { createClient } = require('@supabase/supabase-js');

const SITE = 'https://laizalifestyle.com';
const DEFAULT = {
  title: 'LAIZA™ Leather Wallets for Men – Italian & Genuine Leather',
  desc: 'Pop-up card wallets, slim bifolds and card holders in Italian & genuine leather. RFID blocking styles. Cash on Delivery · Ships across India · Extra 10% off on online payment.',
  image: SITE + '/og-laiza-v2.jpg', w: 1200, h: 630
};
const OLD = {"laiza-men-s-essential-slim-bifold-wallet-grey-italian-leather": "LAIZA-LW-001", "laiza-heritage-men-s-bifold-wallet-brown-croco-embossed-leather": "LAIZA-LW-002", "laiza-azure-croco-textured-leather-blue-bifold-wallet-for-men": "LAIZA-LW-003", "laiza-heritage-tri-fold-leather-wallet-with-rfid-blocking": "LAIZA-LW-006", "laiza-classic-vertical-slim-and-minimalist-leather-wallet-with-snap-closure": "LAIZA-LW-004", "laiza-vertical-slim-card-wallet-for-men-genuine-leather-snap-closure-brown": "LAIZA-LW-004", "laiza-vertical-slim-card-wallet-for-men-hunter-leather-snap-closure-brown": "LAIZA-LW-004", "laiza-secure-tri-fold-pop-up-italian-leather-card-holder-wallet-grey": "LAIZA-LW-005", "laiza-premium-leather-card-holder-wallet": "LZCH-001", "laiza-premium-slim-leather-card-holder-wallet": "LZCH-002", "laiza-premium-leather-carabiner-keychain": "LZK-001", "laiza-premium-leather-keychain-holder": "LZK-002", "laiza-premium-slim-bifold-leather-wallet": "LZW-001", "laiza-premium-men-s-side-popup-card-wallet-tan": "LAIZA-LW-006"};
const PAGES = { about: 'About LAIZA™', story: 'Our Story – LAIZA™', contact: 'Contact LAIZA™', track: 'Track your order – LAIZA™',
  guides: 'Leather Wallet Guides – LAIZA™', shipping: 'Shipping Policy – LAIZA™', returns: 'Returns Policy – LAIZA™',
  cancellation: 'Cancellation Policy – LAIZA™', privacy: 'Privacy Policy – LAIZA™', terms: 'Terms – LAIZA™' };
const CATS = { wallets: 'Leather Wallets for Men – LAIZA™', 'card-holders': 'Leather Card Holders – LAIZA™', keychains: 'Leather Keychains – LAIZA™' };

const slugify = t => (t || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = n => '₹' + Number(n).toLocaleString('en-IN');

module.exports = async (req, res) => {
  const q = req.query || {};
  const qs = new URLSearchParams(Object.entries(q).filter(([k]) => k !== 'full')).toString();
  const url = SITE + '/' + (qs ? '?' + qs : '');
  let m = { ...DEFAULT };

  try {
    if (q.product) {
      const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
      if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
        const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
        const { data } = await sb.from('products').select('name,description,price,compare_price,image_url,sku').eq('is_active', true);
        const slug = String(q.product);
        const oldSku = OLD[slug];
        const p = (data || []).find(x => slugify(x.name) === slug) ||
                  (oldSku ? (data || []).find(x => String(x.sku).replace(/O/g, '0') === oldSku) : null);
        if (p) {
          const name = String(p.name).replace(/^LAIZA™?\s+/i, '');
          const off = Number(p.compare_price) > Number(p.price) ? ` (MRP ${inr(p.compare_price)})` : '';
          m = {
            title: `${name} – ${inr(p.price)}${off} | LAIZA™`,
            desc: (String(p.description || '').slice(0, 180) || DEFAULT.desc) + ' Cash on Delivery · Ships across India.',
            image: p.image_url ? SITE + '/_vercel/image?url=' + encodeURIComponent(p.image_url) + '&w=1080&q=75' : DEFAULT.image,
            w: 1080, h: 1080
          };
          if (!p.image_url) { m.w = DEFAULT.w; m.h = DEFAULT.h; }
        }
      }
    } else if (q.page && PAGES[q.page]) m.title = PAGES[q.page];
    else if (q.category && CATS[q.category]) m.title = CATS[q.category];
  } catch (e) { /* fall back to default preview */ }

  const full = SITE + '/' + (qs ? '?' + qs + '&' : '?') + 'full=1';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(m.title)}</title>
<meta name="description" content="${esc(m.desc)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="${q.product ? 'product' : 'website'}">
<meta property="og:site_name" content="LAIZA™">
<meta property="og:url" content="${esc(url)}">
<meta property="og:title" content="${esc(m.title)}">
<meta property="og:description" content="${esc(m.desc)}">
<meta property="og:image" content="${esc(m.image)}">
<meta property="og:image:secure_url" content="${esc(m.image)}">
<meta property="og:image:width" content="${m.w}">
<meta property="og:image:height" content="${m.h}">
<meta property="og:image:alt" content="${esc(m.title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(m.image)}">
<meta name="robots" content="noindex">
</head><body><p><a href="${esc(full)}">${esc(m.title)}</a></p></body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400');
  res.status(200).send(html);
};
