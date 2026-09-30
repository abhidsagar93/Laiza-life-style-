// api/google-feed.js  →  https://laizalifestyle.com/api/google-feed
//
// Google Merchant Center product feed (RSS 2.0 + g: namespace), built live from Supabase.
// Merchant Center fetches this link on a schedule, so new products, price changes and
// stock changes reach Google automatically — nothing to upload by hand.
//
// Pricing: products.price is what the customer pays; products.compare_price is the MRP.
// When MRP is higher, Google gets price = MRP and sale_price = selling price, so the
// listing shows the discount exactly like the website does.
//
// Uses existing Vercel env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

const { createClient } = require('@supabase/supabase-js');

const SITE = 'https://laizalifestyle.com';
const BRAND = 'LAIZA';

function slugify(text) {
  return (text || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function xml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}
function plain(html) {
  return String(html || '')
    .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
function inr(n) {
  return Number(n).toFixed(2) + ' INR';
}
// Google's own taxonomy paths
function googleCategory(p) {
  const c = `${p.category || ''} ${p.name || ''}`.toLowerCase();
  if (c.includes('key')) return 'Apparel & Accessories > Clothing Accessories > Keychains';
  return 'Apparel & Accessories > Handbags, Wallets & Cases > Wallets & Money Clips';
}

module.exports = async (req, res) => {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).end('Server is not configured.');
    return;
  }
  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const [{ data: products, error }, { data: images }] = await Promise.all([
    db.from('products')
      .select('id, name, description, sku, price, compare_price, image_url, stock_qty, category')
      .eq('is_active', true)
      .order('created_at', { ascending: true }),
    db.from('product_images')
      .select('product_id, image_url, sort_order')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
  ]);
  if (error) {
    res.status(500).end('Could not load products.');
    return;
  }

  const extraImages = {};
  (images || []).forEach(i => { (extraImages[i.product_id] ||= []).push(i.image_url); });

  const items = (products || [])
    .filter(p => p.image_url && Number(p.price) > 0)
    .map(p => {
      const price = Number(p.price);
      const mrp = Number(p.compare_price || 0);
      const onSale = mrp > price;
      const extras = (extraImages[p.id] || []).filter(u => u && u !== p.image_url).slice(0, 10);
      const description = plain(p.description) || p.name;
      const isMens = /\bmen'?s?\b|for men/i.test(p.name || '');
      return [
        '    <item>',
        `      <g:id>${xml(p.sku || p.id)}</g:id>`,
        `      <g:title>${xml(p.name).slice(0, 150)}</g:title>`,
        `      <g:description>${xml(description.slice(0, 5000))}</g:description>`,
        `      <g:link>${xml(`${SITE}/?product=${slugify(p.name)}`)}</g:link>`,
        `      <g:image_link>${xml(p.image_url)}</g:image_link>`,
        ...extras.map(u => `      <g:additional_image_link>${xml(u)}</g:additional_image_link>`),
        `      <g:availability>${Number(p.stock_qty) > 0 ? 'in_stock' : 'out_of_stock'}</g:availability>`,
        `      <g:price>${inr(onSale ? mrp : price)}</g:price>`,
        onSale ? `      <g:sale_price>${inr(price)}</g:sale_price>` : null,
        `      <g:brand>${BRAND}</g:brand>`,
        '      <g:condition>new</g:condition>',
        '      <g:identifier_exists>no</g:identifier_exists>',
        `      <g:mpn>${xml(p.sku || p.id)}</g:mpn>`,
        `      <g:google_product_category>${xml(googleCategory(p))}</g:google_product_category>`,
        p.category ? `      <g:product_type>${xml(p.category)}</g:product_type>` : null,
        '      <g:age_group>adult</g:age_group>',
        `      <g:gender>${isMens ? 'male' : 'unisex'}</g:gender>`,
        '      <g:material>Leather</g:material>',
        '    </item>'
      ].filter(Boolean).join('\n');
    });

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">',
    '  <channel>',
    '    <title>Laiza Lifestyle</title>',
    `    <link>${SITE}</link>`,
    '    <description>Premium handcrafted leather wallets, card holders and accessories.</description>',
    ...items,
    '  </channel>',
    '</rss>'
  ].join('\n');

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  res.status(200).end(body);
};
        
