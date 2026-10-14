// middleware.js  (main folder, next to index.html)
// Runs before Vercel serves index.html. Only link-preview robots (WhatsApp, Facebook, Instagram,
// Telegram, X, LinkedIn…) are sent to /api/share so each product link shows its own photo + price.
// Real visitors and Google always get the normal website.
export const config = { matcher: '/' };

const BOTS = /WhatsApp|facebookexternalhit|Facebot|meta-externalagent|Twitterbot|TelegramBot|LinkedInBot|Slackbot|Discordbot|Pinterest|SkypeUriPreview|redditbot|Iframely|Embedly/i;

export default function middleware(request) {
  const ua = request.headers.get('user-agent') || '';
  const url = new URL(request.url);
  if (!BOTS.test(ua) || url.searchParams.has('full')) return; // normal website
  const dest = new URL('/api/share' + url.search, url);
  return new Response(null, { headers: { 'x-middleware-rewrite': dest.toString() } });
}
