// api/sitemap.js  →  https://laizalifestyle.com/api/sitemap
//
// Always-up-to-date sitemap for Google Search Console, built live from Supabase —
// replaces the manual "download sitemap.xml and re-upload" step in the admin panel.
// Submit https://laizalifestyle.com/api/sitemap once in Search Console → Sitemaps.

const { createClient } = require('@supabase/supabase-js');

const SITE = 'https://laizalifestyle.com';
const PAGES = ['privacy', 'terms', 'shipping', 'returns', 'cancellation']; // pages that open directly from a link

function slugify(text) {
  return (text || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

module.exports = async (req, res) => {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${SITE}/`, freq: 'daily', priority: '1.0' }
  ];

  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: products } = await db.from('products').select('name').eq('is_active', true).order('name');
    const seen = new Set();
    (products || []).forEach(p => {
      const slug = slugify(p.name);
      if (slug && !seen.has(slug)) {
        seen.add(slug);
        urls.push({ loc: `${SITE}/?product=${slug}`, freq: 'weekly', priority: '0.8' });
      }
    });
  }
  PAGES.forEach(page => urls.push({ loc: `${SITE}/?page=${page}`, freq: 'monthly', priority: '0.5' }));

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map(u => `  <url>\n    <loc>${u.loc.replace(/&/g, '&amp;')}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${u.freq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`),
    '</urlset>'
  ].join('\n');

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  res.status(200).end(body);
};
  
