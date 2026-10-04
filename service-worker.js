/* DSR Travel Journal - network-first shell cache; Leaflet (jsdelivr) + map tiles cache-first so
   maps you've already looked at still show offline. Only ever deletes its OWN old caches:
   every DSR app shares the github.io origin's cache storage. */
var CACHE = 'dsr-travel-v49';
var OWN = 'dsr-travel-';
var SHARED = 'dsr-travel-shared';
var SHELL = ['./', './index.html', './app.js?v=3g', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png', './dsr-move.js?v=3'];
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
    /* 3b: photos (from DSR Day Photos, or Gallery › Share) are parked as shared-photo-0..n and open #sharedphotos */
    var to = '#shared';
    e.respondWith(req.formData().then(function (fd) {
      var f = fd.get('file'), ph = fd.getAll('photos').filter(function (x) { return x && x.size; });
      if (!f && !ph.length) { var all = fd.getAll('file'); if (all.length > 1) { ph = all; } }
      return caches.open(SHARED).then(function (c) {
        if (ph.length) {
          to = '#sharedphotos';
          return c.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return /shared-photo-/.test(k.url); }).map(function (k) { return c.delete(k); })); })
            .then(function () { return Promise.all(ph.map(function (p, i) { return c.put('./shared-photo-' + i, new Response(p, { headers: { 'Content-Type': p.type || 'image/jpeg', 'X-Name': encodeURIComponent(p.name || '') } })); })); })
            .then(function () { return c.put('./shared-photo-count', new Response(String(ph.length))); });
        }
        return f ? c.put('./shared-file', new Response(f, { headers: { 'X-Name': encodeURIComponent(f.name || '') } })) : null;
      });
    }).then(function () { return Response.redirect(new URL('./index.html' + to, self.registration.scope).href, 303); }));
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
