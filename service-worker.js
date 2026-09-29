/* DSR Travel Journal - network-first shell cache; Leaflet (jsdelivr) + map tiles cache-first so
   maps you've already looked at still show offline. Only ever deletes its OWN old caches:
   every DSR app shares the github.io origin's cache storage. */
var CACHE = 'dsr-travel-v21';
var OWN = 'dsr-travel-';
var SHARED = 'dsr-travel-shared';
var SHELL = ['./', './index.html', './app.js?v=1u', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(OWN) === 0 && k !== CACHE && k !== CACHE + '-tiles' && k !== SHARED; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  /* 1r: "Share to DSR Travel Journal" from Messenger etc. (manifest share_target) - keep the file
     for the app to import, then open the app on #shared */
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith(req.formData().then(function (fd) {
      var f = fd.get('file');
      return caches.open(SHARED).then(function (c) {
        return f ? c.put('./shared-file', new Response(f, { headers: { 'X-Name': encodeURIComponent(f.name || '') } })) : null;
      });
    }).then(function () { return Response.redirect(new URL('./index.html#shared', self.registration.scope).href, 303); }));
    return;
  }
  if (req.method !== 'GET') return;
  if (url.hostname.endsWith('tile.openstreetmap.org') || url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.open(CACHE + '-tiles').then(function (c) {
      return c.match(req).then(function (hit) {
        return hit || fetch(req).then(function (res) { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; });
      });
    }));
    return;
  }
  if (url.origin !== location.origin || url.pathname.indexOf(new URL(self.registration.scope).pathname) !== 0) return;   // 1u: not other github.io folders (shared trips, other DSR apps)
  e.respondWith(fetch(req).then(function (res) {
    if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
    return res;
  }).catch(function () { return caches.match(req).then(function (h) { return h || caches.match('./index.html'); }); }));
});
