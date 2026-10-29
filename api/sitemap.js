// api/sitemap.js  →  https://laizalifestyle.com/sitemap.xml  (vercel.json rewrites /sitemap.xml here)
// Lists the home page, every active product and every buying guide, built live from Supabase,
// so new products appear in Google's list automatically.
// Also: /api/sitemap?format=seo → product list for middleware.js (see seoJson below).
// Uses existing Vercel env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

const { createClient } = require('@supabase/supabase-js');

const SITE = 'https://laizalifestyle.com';
const PAGES = ['privacy', 'terms', 'shipping', 'returns', 'cancellation'];
const INFO_PAGES = ['about', 'story', 'contact'];
const CAT_SLUG = { 'leather wallets': 'wallets', 'card holders': 'card-holders', 'leather key chains': 'keychains' };
const GUIDES = [
  'diwali-gift-guide-leather-wallets-for-men',
  'best-leather-wallets-for-men-india',
  'bifold-vs-trifold-vs-card-holder',
  'how-to-identify-genuine-leather',
  'wallet-gift-ideas-for-men',
  'how-to-choose-a-leather-wallet',
  'rfid-protection-explained',
  'leather-care-guide'
];

function slugify(text) {
  return (text || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function xml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// ?format=seo → small JSON of active products for middleware.js (page titles/descriptions in the raw HTML).
// Cached by Vercel's CDN for 1 hour, so Supabase is asked at most about once an hour.
async function seoJson(req, res) {
  let list = [];
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data } = await db.from('products').select('name, description, price, compare_price, image_url, category, sku, stock_qty').eq('is_active', true);
      list = (data || []).map(p => ({ slug: slugify(p.name), name: p.name, description: p.description || '', price: p.price,
        compare_price: p.compare_price, image_url: p.image_url, category: p.category, sku: p.sku, in_stock: Number(p.stock_qty) > 0 }));
    } catch (_) { list = []; }
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', list.length ? 's-maxage=3600, stale-while-revalidate=86400' : 's-maxage=60');
  res.status(200).send(JSON.stringify({ products: list }));
}

module.exports = async (req, res) => {
  if ((req.query || {}).format === 'seo') return seoJson(req, res);
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: SITE + '/', changefreq: 'daily', priority: '1.0', lastmod: today },
    { loc: SITE + '/?page=guides', changefreq: 'weekly', priority: '0.6', lastmod: today }
  ];
  GUIDES.forEach(g => urls.push({ loc: `${SITE}/?page=guides&post=${g}`, changefreq: 'monthly', priority: '0.6' }));
  INFO_PAGES.forEach(pg => urls.push({ loc: `${SITE}/?page=${pg}`, changefreq: 'monthly', priority: '0.5' }));
  PAGES.forEach(pg => urls.push({ loc: `${SITE}/?page=${pg}`, changefreq: 'yearly', priority: '0.3' }));

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data } = await db.from('products').select('name, image_url, created_at, category').eq('is_active', true);
      (data || []).forEach(p => urls.push({
        loc: `${SITE}/?product=${slugify(p.name)}`,
        changefreq: 'weekly', priority: '0.9',
        lastmod: String(p.created_at || today).slice(0, 10),
        image: p.image_url, title: p.name
      }));
      const cats = [...new Set((data || []).map(p => p.category).filter(Boolean))];
      cats.forEach(c => urls.push({
        loc: `${SITE}/?category=${CAT_SLUG[c.toLowerCase()] || slugify(c)}`,
        changefreq: 'weekly', priority: '0.8', lastmod: today
      }));
    } catch (_) { /* still return the pages we know */ }
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls.map(u => `  <url>
    <loc>${xml(u.loc)}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ''}
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>${u.image ? `\n    <image:image><image:loc>${xml(u.image)}</image:loc><image:title>${xml(u.title)}</image:title></image:image>` : ''}
  </url>`).join('\n')}
</urlset>`;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  res.status(200).send(body);
};
