// api/sitemap.js  →  https://laizalifestyle.com/sitemap.xml  (vercel.json rewrites /sitemap.xml here)
// Lists the home page, every active product and every buying guide, built live from Supabase,
// so new products appear in Google's list automatically.
// Uses existing Vercel env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

const { createClient } = require('@supabase/supabase-js');

const SITE = 'https://laizalifestyle.com';
const PAGES = ['privacy', 'terms', 'shipping', 'returns', 'cancellation'];
const GUIDES = [
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

module.exports = async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: SITE + '/', changefreq: 'daily', priority: '1.0', lastmod: today },
    { loc: SITE + '/?page=guides', changefreq: 'weekly', priority: '0.6', lastmod: today }
  ];
  GUIDES.forEach(g => urls.push({ loc: `${SITE}/?page=guides&post=${g}`, changefreq: 'monthly', priority: '0.6' }));
  PAGES.forEach(pg => urls.push({ loc: `${SITE}/?page=${pg}`, changefreq: 'yearly', priority: '0.3' }));

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const { data } = await db.from('products').select('name, image_url, created_at').eq('is_active', true);
      (data || []).forEach(p => urls.push({
        loc: `${SITE}/?product=${slugify(p.name)}`,
        changefreq: 'weekly', priority: '0.9',
        lastmod: String(p.created_at || today).slice(0, 10),
        image: p.image_url, title: p.name
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
