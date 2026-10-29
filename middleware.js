// middleware.js  (main folder, next to index.html) — updated 29 Oct 2026
// 1) Link-preview robots (WhatsApp, Facebook, Telegram, X, LinkedIn…) → /api/share (photo + price preview). Same as before.
// 2) NEW: for every product, category, guide and info/policy link, the page HTML itself now carries that page's own
//    title, description, canonical link and (for products) product details — so Google sees a separate page per link
//    straight away, instead of the same home-page HTML for every link. Same HTML for visitors and Google (no cloaking).
//    The rest of the website is untouched. If anything fails, the normal index.html is served exactly as before.
// Supabase use: none directly. Product names/prices come from /api/sitemap?format=seo, which Vercel caches for 1 hour.
export const config = { matcher: '/' };

const BOTS = /WhatsApp|facebookexternalhit|Facebot|meta-externalagent|Twitterbot|TelegramBot|LinkedInBot|Slackbot|Discordbot|Pinterest|SkypeUriPreview|redditbot|Iframely|Embedly/i;
const SITE = 'https://laizalifestyle.com';
const OG = SITE + '/og-laiza-v2.jpg';
const PAGES = {"about": ["About Us: Genuine Leather Wallets from Sagara, Karnataka — LAIZA™", "LAIZA™ is run by Jainul Abhid, Proprietor of Laiza International, Sagara, Karnataka. Genuine leather wallets, card holders and keychains chosen for neat stitching and a slim, practical design."], "story": ["Our Story: How LAIZA™ Began in Sagara, Karnataka — LAIZA™", "LAIZA™ began in Sagara, Karnataka with one idea: bring genuine leather wallets and card holders to people who were only offered synthetic imitations. Read the LAIZA™ story."], "contact": ["Contact Us: Order Help on WhatsApp & Email — LAIZA™", "Need help with an order, a return or a product? Contact LAIZA™ on WhatsApp +91 97316 74173 or email hello@laizalifestyle.com. Laiza International, Sagara, Karnataka."], "privacy": ["Privacy Policy — LAIZA™", "How LAIZA™ (Laiza International) collects, uses, stores and protects your personal information when you browse, create an account or order on laizalifestyle.com."], "terms": ["Terms & Conditions — LAIZA™", "Terms and conditions for using laizalifestyle.com and buying LAIZA™ wallets, card holders and keychains: orders, prices, payments, delivery and returns."], "shipping": ["Shipping Policy — Delivery Across India | LAIZA™", "LAIZA™ ships across India. Orders are dispatched within 1–2 business days and usually delivered in 5–7 business days. Cash on Delivery and order tracking available."], "returns": ["Return & Refund Policy — 7-Day Returns | LAIZA™", "Return or exchange an unused LAIZA™ product within 7 days of delivery. See which items qualify, how to request a return and how refunds are paid."], "cancellation": ["Cancellation Policy — LAIZA™", "Cancel a LAIZA™ order before it is dispatched by WhatsApp or email. What happens if an order has already shipped, and how refunds for cancelled orders work."], "guides": ["Leather Care Guides & Buying Advice — LAIZA", "Practical guides on choosing, caring for, and understanding genuine leather wallets and RFID protection."]};
const CATS = {"wallets": ["Wallets for Men — LAIZA™", "Shop LAIZA™ men's leather wallets: Italian leather slim bifold, croco-textured bifolds, hunter leather vertical wallet and RFID pop-up card wallets. Gift box, COD, free delivery."], "card-holders": ["Card Holders for Men — LAIZA™", "Slim genuine leather card holders by LAIZA™: fold-over card holder with snap button, slim black card holder and slim card holder wallet. Cash on Delivery and free delivery across India."], "keychains": ["Keychains for Men — LAIZA™", "Genuine leather keychains by LAIZA™: carabiner keychain with metal clip and leather key holder pouch with snap button. Cash on Delivery and free delivery across India."], "all": ["All Leather Wallets, Card Holders & Keychains — LAIZA™", "All LAIZA™ products in one place: men's leather wallets, card holders and keychains in genuine and Italian leather. Cash on Delivery, free delivery across India, 7-day returns."]};
const GUIDES = {"diwali-gift-guide-leather-wallets-for-men": ["Diwali Gift Guide 2026: Leather Wallet Gifts for Men — LAIZA", "Diwali gift ideas for men: which leather wallet to choose for husband, father, brother or colleagues — by payment habit, leather, colour, RFID and budget. Gift box, free delivery and COD."], "best-leather-wallets-for-men-india": ["Best Leather Wallets for Men in India: A Simple Buying Guide — LAIZA", "Which leather wallet suits you — slim bifold, trifold, pop-up card wallet or card holder? Styles, RFID, leather types and price ranges for men's wallets in India."], "bifold-vs-trifold-vs-card-holder": ["Bifold vs Trifold vs Card Holder: Which Wallet Is Right for You? — LAIZA", "Bifold, trifold, pop-up card wallet or slim card holder — a quick comparison of size, capacity and comfort to help you choose the right men's wallet."], "how-to-identify-genuine-leather": ["How to Identify a Genuine Leather Wallet (5 Easy Checks) — LAIZA", "Real leather or PU? Five simple checks — smell, grain, edges, touch and price — to spot a genuine leather wallet before you buy."], "wallet-gift-ideas-for-men": ["Wallet Gift Ideas for Men: Birthdays, Anniversaries & Festivals — LAIZA", "A leather wallet is a gift men use every day. How to choose the right wallet gift for a husband, father, brother or friend — styles, colours and budget."], "how-to-choose-a-leather-wallet": ["How to Choose the Right Leather Wallet — LAIZA", "A practical guide to picking a leather wallet that actually fits how you live — card count, fold style, RFID protection, and what genuine leather should feel like."], "rfid-protection-explained": ["RFID Protection Explained: Do You Really Need It? — LAIZA", "What RFID skimming actually is, how realistic the risk is, and whether an RFID-blocking wallet is worth it for your cards."], "leather-care-guide": ["How to Care for Genuine Leather: A Complete Guide — LAIZA", "Simple, practical leather care habits that keep a genuine leather wallet looking good and lasting for years — cleaning, conditioning, and what to avoid."]};
const OLD = {"lzk-002": "laiza-key-holder-pouch-genuine-leather-snap-button", "laiza-lw-001": "laiza-slim-bifold-wallet-for-men-italian-leather-zip-pocket-grey", "laiza-lw-006": "laiza-pop-up-card-wallet-for-men-italian-leather-rfid-blocking-tan", "lzch-001": "laiza-fold-over-card-holder-genuine-leather-snap-button-black-brown-chocolate", "lzw-001": "laiza-slim-card-holder-wallet-genuine-leather-black-brown", "lzch-002": "laiza-slim-card-holder-genuine-leather-black", "laiza-vertical-slim-card-wallet-for-men-genuine-leather-snap-closure-brown": "laiza-vertical-slim-card-wallet-for-men-genuine-hunter-leather-snap-closure-brown", "laiza-lw-004": "laiza-vertical-slim-card-wallet-for-men-genuine-hunter-leather-snap-closure-brown", "laiza-lw-002": "laiza-croco-bifold-wallet-for-men-genuine-leather-brown", "laiza-lw-005": "laiza-pop-up-card-holder-wallet-for-men-italian-leather-rfid-blocking-grey", "lzk-001": "laiza-carabiner-keychain-genuine-leather-strap-metal-clip", "laiza-lw-003": "laiza-croco-bifold-wallet-for-men-genuine-leather-blue", "laiza-men-s-essential-slim-bifold-wallet-grey-italian-leather": "laiza-slim-bifold-wallet-for-men-italian-leather-zip-pocket-grey", "laiza-heritage-men-s-bifold-wallet-brown-croco-embossed-leather": "laiza-croco-bifold-wallet-for-men-genuine-leather-brown", "laiza-azure-croco-textured-leather-blue-bifold-wallet-for-men": "laiza-croco-bifold-wallet-for-men-genuine-leather-blue", "laiza-heritage-tri-fold-leather-wallet-with-rfid-blocking": "laiza-pop-up-card-wallet-for-men-italian-leather-rfid-blocking-tan", "laiza-classic-vertical-slim-and-minimalist-leather-wallet-with-snap-closure": "laiza-vertical-slim-card-wallet-for-men-genuine-hunter-leather-snap-closure-brown", "laiza-vertical-slim-card-wallet-for-men-hunter-leather-snap-closure-brown": "laiza-vertical-slim-card-wallet-for-men-genuine-hunter-leather-snap-closure-brown", "laiza-secure-tri-fold-pop-up-italian-leather-card-holder-wallet-grey": "laiza-pop-up-card-holder-wallet-for-men-italian-leather-rfid-blocking-grey", "laiza-premium-leather-card-holder-wallet": "laiza-fold-over-card-holder-genuine-leather-snap-button-black-brown-chocolate", "laiza-premium-slim-leather-card-holder-wallet": "laiza-slim-card-holder-genuine-leather-black", "laiza-premium-leather-carabiner-keychain": "laiza-carabiner-keychain-genuine-leather-strap-metal-clip", "laiza-premium-leather-keychain-holder": "laiza-key-holder-pouch-genuine-leather-snap-button", "laiza-premium-slim-bifold-leather-wallet": "laiza-slim-card-holder-wallet-genuine-leather-black-brown", "laiza-premium-men-s-side-popup-card-wallet-tan": "laiza-pop-up-card-wallet-for-men-italian-leather-rfid-blocking-tan"};
const CAT_NAME = { 'leather wallets': ['Wallets', 'wallets'], 'card holders': ['Card Holders', 'card-holders'], 'leather key chains': ['Keychains', 'keychains'] };

const clean = v => String(v || '').toLowerCase().replace(/[^a-z0-9-]+/g, '');
const slugify = t => String(t || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = n => { const x = Math.round(Number(n) || 0).toString(); const l3 = x.slice(-3), r = x.slice(0, -3); return (r ? r.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : '') + l3; };
const ld = (id, o) => '<script type="application/ld+json" id="' + id + '">' + JSON.stringify(o).replace(/</g, '\\u003c') + '</script>';

async function get(url, ms) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { signal: ac.signal }); return r.ok ? r : null; } catch (e) { return null; } finally { clearTimeout(t); }
}

function setMeta(html, id, v) {
  return html.replace(new RegExp('(<meta id="' + id + '"[^>]*?content=")[^"]*(")'), (m, a, b) => a + esc(v) + b);
}

async function pageFor(url) {
  const q = url.searchParams;
  if (q.get('product')) {
    const r = await get(new URL('/api/sitemap?format=seo', url.origin), 2500);
    if (!r) return null;
    const list = ((await r.json()) || {}).products || [];
    const k = clean(q.get('product')); const slug = OLD[k] || k;
    const p = list.find(x => x.slug === slug);
    if (!p) return null;
    const n = String(p.name).replace(/^LAIZA™?\s+/i, '');
    const canon = SITE + '/?product=' + p.slug;
    const cat = CAT_NAME[String(p.category || '').toLowerCase()];
    const schema = ld('productSchema', { '@context': 'https://schema.org', '@type': 'Product', name: p.name, description: p.description || undefined,
      image: p.image_url ? [p.image_url] : undefined, sku: p.sku || undefined, mpn: p.sku || undefined, brand: { '@type': 'Brand', name: 'LAIZA' },
      offers: { '@type': 'Offer', url: canon, itemCondition: 'https://schema.org/NewCondition', seller: { '@type': 'Organization', name: 'LAIZA™' },
        priceCurrency: 'INR', price: Number(p.price).toFixed(2), availability: p.in_stock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
        hasMerchantReturnPolicy: { '@type': 'MerchantReturnPolicy', applicableCountry: 'IN', returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow', merchantReturnDays: 7 } } })
      + ld('breadcrumbSchema', { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: SITE + '/' },
        ...(cat ? [{ '@type': 'ListItem', position: 2, name: cat[0], item: SITE + '/?category=' + cat[1] }] : []),
        { '@type': 'ListItem', position: cat ? 3 : 2, name: p.name, item: canon }] });
    const mrp = Number(p.compare_price) > Number(p.price) ? ' <s>₹' + inr(p.compare_price) + '</s>' : '';
    const body = '<div id="productDetailBody"><article style="max-width:760px;margin:0 auto;padding:28px 18px"><h1 style="font-size:24px;margin:0 0 8px">' + esc(p.name) + '</h1>'
      + '<p style="font-size:20px;margin:0 0 12px"><b>₹' + inr(p.price) + '</b>' + mrp + '</p>'
      + (p.description ? '<p style="line-height:1.6;margin:0 0 12px">' + esc(p.description) + '</p>' : '')
      + '<p style="margin:0;color:#6e675e">Cash on Delivery · Free delivery across India · 7-day returns</p></article></div>';
    return { t: n + ' – Buy Online in India | LAIZA',
      d: ('Buy ' + n + ' online at ₹' + inr(p.price) + '. Genuine leather, Cash on Delivery, free delivery across India. ' + (p.description || '')).slice(0, 158),
      canon, img: p.image_url || OG, head: schema, body };
  }
  if (q.get('post')) { const g = GUIDES[clean(q.get('post'))]; return g ? { t: g[0], d: g[1], canon: SITE + '/?page=guides&post=' + clean(q.get('post')) } : null; }
  const pg = q.get('page');
  if (pg) { const x = PAGES[clean(pg)]; return x ? { t: x[0], d: x[1], canon: SITE + '/?page=' + clean(pg) } : null; }
  const c = q.get('category');
  if (c) { const x = CATS[clean(c)]; return x ? { t: x[0], d: x[1], canon: SITE + '/?category=' + clean(c) } : null; }
  return null;
}

export default async function middleware(request) {
  const ua = request.headers.get('user-agent') || '';
  const url = new URL(request.url);
  if (BOTS.test(ua) && !url.searchParams.has('full')) {
    const dest = new URL('/api/share' + url.search, url);
    return new Response(null, { headers: { 'x-middleware-rewrite': dest.toString() } });
  }
  if (!url.search || (request.method !== 'GET' && request.method !== 'HEAD')) return; // home page and everything else: unchanged
  try {
    const m = await pageFor(url);
    if (!m) return;
    const r = await get(new URL('/index.html', url.origin), 3000);
    if (!r) return;
    let html = await r.text();
    if (html.length < 20000 || html.indexOf('id="pageTitle"') < 0) return;
    html = html.replace(/<title id="pageTitle">[^<]*<\/title>/, '<title id="pageTitle">' + esc(m.t) + '</title><link id="canonicalLink" rel="canonical" href="' + esc(m.canon) + '">');
    html = setMeta(html, 'metaDescription', m.d);
    html = setMeta(html, 'ogTitle', m.t); html = setMeta(html, 'ogDescription', m.d); html = setMeta(html, 'ogUrl', m.canon);
    html = setMeta(html, 'twitterTitle', m.t); html = setMeta(html, 'twitterDescription', m.d);
    if (m.img) { html = setMeta(html, 'ogImage', m.img); html = setMeta(html, 'twitterImage', m.img); }
    if (m.head) html = html.replace('</head>', m.head + '</head>');
    if (m.body) html = html.replace('<div id="productDetailBody">Loading…</div>', m.body);
    return new Response(request.method === 'HEAD' ? null : html, { status: 200, headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache, must-revalidate', 'x-lz-page': '1' } });
  } catch (e) { return; }
}
