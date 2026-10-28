// sw.js — LAIZA admin app: shows "New order" notifications from the server (Web Push) and
// opens the order when tapped. No offline caching: the website loads exactly as before.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'LAIZA', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'LAIZA', {
    body: d.body || '', icon: '/icon-192.png', tag: d.tag || undefined, renotify: !!d.tag,
    vibrate: [200, 100, 200], data: { url: d.url || '/admin' }
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || '/admin', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (ws) {
    for (var i = 0; i < ws.length; i++) {
      if (new URL(ws[i].url).origin === self.location.origin && 'focus' in ws[i]) {
        return ws[i].navigate(url).then(function (w) { return (w || ws[i]).focus(); }).catch(function () { return ws[i].focus(); });
      }
    }
    return self.clients.openWindow(url);
  }));
});
