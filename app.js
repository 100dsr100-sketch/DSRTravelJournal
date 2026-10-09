/* DSR Travel Journal - trips > days > notes with photos & maps; A5 page layout; A4 booklet printing.
   Everything is stored on this device (IndexedDB). Free services only: OpenStreetMap tiles,
   Open-Meteo (geocoding + weather), OSRM (road routes). Google Timeline = import of the phone's export. */
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const main = $("#main");
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function toast(m, ms = 2200) { const t = $("#toast"); t.textContent = m; t.style.display = "block"; clearTimeout(toast.t); toast.t = setTimeout(() => t.style.display = "none", ms); }
const fmtDate = iso => iso ? new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "";
const shortDate = iso => iso ? new Date(iso + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";

/* ======================= storage ======================= */
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("dsr-travel-journal", 2);
    r.onupgradeneeded = e => {
      const idb = r.result;
      if (e.oldVersion < 1) { idb.createObjectStore("trips", { keyPath: "id" }); idb.createObjectStore("photos"); }
      if (e.oldVersion < 2) {
        /* 4a: each trip's Google Timeline (often 100 000s of points) moves to its own store. Inside the trip it was
           re-written on every autosave (about once a second while typing) and loaded with every trip on Home. */
        idb.createObjectStore("timelines");
        if (e.oldVersion >= 1) {
          const ts = r.transaction.objectStore("trips"), tl = r.transaction.objectStore("timelines");
          ts.openCursor().onsuccess = ev => { const c = ev.target.result; if (!c) return; const t = c.value;
            if (Array.isArray(t.timeline)) { tl.put(t.timeline, t.id); t.tlCount = t.timeline.length; t.timeline = null; c.update(t); }
            c.continue(); };
        }
      }
    };
    r.onsuccess = () => { db = r.result; db.onversionchange = () => db.close(); res(); };
    r.onerror = () => rej(r.error);
  });
}
const tx = (store, mode = "readonly") => db.transaction(store, mode).objectStore(store);
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const allTrips = () => req(tx("trips").getAll());
const getTrip = id => req(tx("trips").get(id));
/* 4a: the trip record never carries the Timeline - it's written to its own store only when it changed */
async function putTrip(t) {
  t.updated = Date.now();
  const { timeline, _tlStored, ...rec } = t;
  if (Array.isArray(timeline)) {
    rec.tlCount = t.tlCount = timeline.length;
    if (!_tlStored) { await req(tx("timelines", "readwrite").put(timeline, t.id)); t._tlStored = true; }
  }
  rec.timeline = null;
  return req(tx("trips", "readwrite").put(rec));
}
const delTrip = async id => { await req(tx("timelines", "readwrite").delete(id)); return req(tx("trips", "readwrite").delete(id)); };
/* the trip's Timeline points, loaded only where a map needs them */
async function ensureTL(t) {
  if (Array.isArray(t.timeline)) return t.timeline;            // loaded already (or an old in-trip copy: the next save moves it)
  const tl = await req(tx("timelines").get(t.id));
  if (tl) { t.timeline = tl; t._tlStored = true; }
  return t.timeline;
}
const setTL = (t, pts) => { t.timeline = pts; t._tlStored = false; };
const photoIdsOf = t => [...new Set([...(t.cover || []), ...t.days.flatMap(d => [...(d.notes || "").matchAll(/data-pid="([^"]+)"/g)].map(m => m[1]))])];
const putPhoto = (id, blob) => req(tx("photos", "readwrite").put(blob, id));
const getPhoto = id => req(tx("photos").get(id));
/* 2n: photos stored but no longer used by any trip (cover or notes), newest first. Before 2n, saving a day
   dropped photos sitting at the end of the notes; the photos themselves were never deleted. [extra] =
   ids still in use that may not be saved yet (the day being edited). */
async function unusedPhotos(extra = []) {
  const used = new Set(extra);
  for (const t of await allTrips()) {
    (t.cover || []).forEach(id => used.add(id));
    for (const d of t.days || []) for (const m of (d.notes || "").matchAll(/data-pid="([^"]+)"/g)) used.add(m[1]);
  }
  const added = id => parseInt(String(id).slice(1, -5), 36) || 0;   // photo ids are "p" + uid(): time first
  return (await req(tx("photos").getAllKeys())).filter(id => !used.has(id)).sort((a, b) => added(b) - added(a)).map(id => ({ id, when: added(id) }));
}
const photoUrls = {};
async function photoURL(id) {
  if (photoUrls[id]) return photoUrls[id];
  const b = await getPhoto(id); if (!b) return "";
  return (photoUrls[id] = URL.createObjectURL(b));
}

/* photos: downscale on the way in (a phone photo is 3-8 MB; 1600px JPEG is plenty for A5) */
/* 2p: when a photo was taken, as local "YYYY-MM-DD HH:MM" - from the camera's file name (Samsung / Pixel:
   20260914_153012.jpg, PXL_20260914_053012345.jpg is UTC so skipped), else the date written in the JPEG (EXIF
   DateTimeOriginal), else the file's own date. near = the day being filled: EXIF is only read for files whose
   file date is within a couple of days of it (reading every photo on the phone would be slow). */
async function photoTakenAt(f, near, thorough) {
  const m = f.name.match(/(?:^|[^\d])(20\d\d)(\d\d)(\d\d)[_-](\d\d)(\d\d)(\d\d)/);
  if (m && !/^PXL_/i.test(f.name)) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  const fd = localDay(f.lastModified), close = near && Math.abs(Date.parse(fd) - Date.parse(near)) <= 2 * 864e5;
  if ((close || !near || thorough) && /\.(jpe?g)$/i.test(f.name)) { const e = await exifDate(f); if (e) return e; }
  const t = new Date(f.lastModified); return `${fd} ${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}
async function exifDate(f) {
  try {
    const b = new DataView(await f.slice(0, 256 * 1024).arrayBuffer());
    if (b.getUint16(0) !== 0xFFD8) return null;
    let o = 2;
    while (o + 4 < b.byteLength) {
      const mk = b.getUint16(o), len = b.getUint16(o + 2);
      if (mk === 0xFFE1 && b.getUint32(o + 4) === 0x45786966) {          // "Exif"
        const t = o + 10, le = b.getUint16(t) === 0x4949, u16 = x => b.getUint16(x, le), u32 = x => b.getUint32(x, le);
        const tag = (ifd, want) => { const n = u16(t + ifd); for (let i = 0; i < n; i++) { const e = t + ifd + 2 + i * 12; if (u16(e) === want) return e; } return 0; };
        const ex = tag(u32(t + 4), 0x8769); if (!ex) return null;
        const dt = tag(u32(ex + 8), 0x9003) || tag(u32(ex + 8), 0x9004); if (!dt) return null;
        const at = t + u32(dt + 8); let s = ""; for (let i = 0; i < 19; i++) s += String.fromCharCode(b.getUint8(at + i));
        const q = s.match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d)/); return q ? `${q[1]}-${q[2]}-${q[3]} ${q[4]}:${q[5]}` : null;
      }
      if ((mk & 0xFF00) !== 0xFF00) return null;
      o += 2 + len;
    }
  } catch {}
  return null;
}
function pickFiles(input, multiple = true) {
  return new Promise(res => {
    input.multiple = multiple; input.value = "";
    input.onchange = () => res([...input.files]);
    input.click();
  });
}
/*
 * Decode a picked photo robustly (1b). Phones hand over things a desktop never sees:
 *  - HEIC/HEIF (Samsung "High efficiency pictures", iPhone photos) - Chrome can't decode them,
 *    so they're converted with heic-to (2c; heic2any as fallback), loaded from the CDN only when needed;
 *  - huge images (108 MP on an S22 Ultra) - a full-size decode can run out of memory, so a
 *    downscaled decode is tried next;
 *  - anything else odd - a plain <img> decode as the last resort.
 * Before 1b a failed decode threw silently and the 📷 button looked dead.
 */
/* 2c: heic-to (current libheif, runs in a worker, returns the picture directly) - heic2any's 2018
   libheif ran on the page and could take minutes or stall on a 12 MP Samsung HEIC; it stays as the fallback */
const loadScriptOnce = (src, name) => new Promise((ok, bad) => {
  if (window[name]) return ok(window[name]);
  const sc = document.createElement("script"); sc.src = src;
  sc.onload = () => window[name] ? ok(window[name]) : bad(new Error("HEIC converter didn't start"));
  sc.onerror = () => { sc.remove(); bad(new Error("couldn't load the HEIC converter (offline?)")); };
  document.head.appendChild(sc);
});
async function heicDecode(file) {
  try { const conv = await loadScriptOnce("https://cdn.jsdelivr.net/npm/heic-to@1.5.2/dist/iife/heic-to.js", "HeicTo"); return await conv({ blob: file, type: "bitmap" }); }
  catch (e) { console.warn("heic-to failed, trying heic2any", e); }
  const conv = await loadScriptOnce("https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js", "heic2any");
  const out = await conv({ blob: file, toType: "image/jpeg", quality: 0.9 });
  return createImageBitmap(Array.isArray(out) ? out[0] : out);
}
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
async function decodeImage(file) {
  const heic = /\.hei[cf]$/i.test(file.name || "") || /hei[cf]/i.test(file.type || "");
  if (heic) return heicDecode(file);
  const src = file;
  const big = src.size > 5 * 1024 * 1024;   // 2a: phone photos can be 50-200 megapixels - decode those straight at 1600px, never full size
  const tries = [
    () => createImageBitmap(src, big ? { resizeWidth: 1600, resizeQuality: "high" } : undefined),
    () => createImageBitmap(src, { resizeWidth: 1600, resizeQuality: "high" }),
    async () => { const url = URL.createObjectURL(src); const im = new Image(); im.src = url; await im.decode(); setTimeout(() => URL.revokeObjectURL(url), 5000); return im; },
    async () => heicDecode(file),   // a HEIC with a misleading name/type
  ];
  for (const t of tries) { try { const b = await t(); if ((b.width || b.naturalWidth) > 0) return b; } catch {} }
  throw new Error("not a picture this phone can read");
}
async function importPhoto(file) {
  const img = await decodeImage(file);
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const max = 1600, k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  img.close?.();
  const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.82));
  if (!blob) throw new Error("couldn't re-encode the picture");
  const id = "p" + uid(); await putPhoto(id, blob); return id;
}

/* ======================= fonts (1i) =======================
   Only fonts built into Android / Windows (no downloads), so they work offline and print. */
const FONTS = {
  classic: { label: "Classic", css: 'Georgia,"Times New Roman","Noto Serif",serif' },
  clean: { label: "Clean", css: '"Segoe UI",Roboto,Arial,sans-serif' },
  hand: { label: "Handwriting", css: '"Segoe Script","Bradley Hand","Dancing Script",cursive' },
  casual: { label: "Casual", css: '"Comic Sans MS","Coming Soon",casual,cursive' },
  type: { label: "Typewriter", css: '"Courier New","Cutive Mono",monospace' },
};
const SIZES = { small: { label: "Small", k: 0.9 }, normal: { label: "Normal", k: 1 }, large: { label: "Large", k: 1.15 }, xl: { label: "Extra large", k: 1.3 } };
/* the trip's journal font as CSS custom properties, set on the page container / notes editor */
function fontVars(t) {
  const f = FONTS[t?.font?.family] || FONTS.classic, z = SIZES[t?.font?.size] || SIZES.normal;
  return `--jf:${f.css};--js:${z.k}`;
}
/* per-selection sizes in the notes (relative, so they scale with the trip size in print too) */
const SEL_SIZES = [["", "Size"], ["0.8", "Small"], ["1", "Normal"], ["1.3", "Large"], ["1.7", "Larger"], ["2.3", "Title"]];

/* ======================= free web services ======================= */
async function geoSearch(q) {
  const r = await fetch("https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&format=json&name=" + encodeURIComponent(q));
  const j = await r.json();
  return (j.results || []).map(p => ({ name: p.name, region: [p.admin1, p.country].filter(Boolean).join(", "), country: p.country || "", cc: p.country_code || "", lat: p.latitude, lon: p.longitude }));
}
async function reverseGeo(lat, lon) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=13&addressdetails=1&lat=${lat}&lon=${lon}`);
    const a = (await r.json()).address || {};
    return { name: a.village || a.town || a.city || a.suburb || a.hamlet || a.county || "Here", region: [a.state, a.country].filter(Boolean).join(", "), country: a.country || "", cc: (a.country_code || "").toUpperCase(), lat, lon };
  } catch { return { name: "Here", region: "", country: "", cc: "", lat, lon }; }
}
async function roadRoute(a, b) {
  const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`);
  const j = await r.json();
  if (!j.routes || !j.routes[0]) throw new Error("No road route found");
  const km = Math.round(j.routes[0].distance / 1000);
  return { coords: j.routes[0].geometry.coordinates.map(([x, y]) => [y, x]), km };
}
/* great-circle arc, longitudes unwrapped so Leaflet draws the short way across the date line */
function flightArc(a, b, n = 64) {
  const R = Math.PI / 180, toD = 180 / Math.PI;
  const p1 = [a.lat * R, a.lon * R], p2 = [b.lat * R, b.lon * R];
  const d = 2 * Math.asin(Math.sqrt(Math.sin((p2[0] - p1[0]) / 2) ** 2 + Math.cos(p1[0]) * Math.cos(p2[0]) * Math.sin((p2[1] - p1[1]) / 2) ** 2));
  if (d === 0) return [[a.lat, a.lon]];
  const out = []; let prevLon = null;
  for (let i = 0; i <= n; i++) {
    const f = i / n, A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1[0]) * Math.cos(p1[1]) + B * Math.cos(p2[0]) * Math.cos(p2[1]);
    const y = A * Math.cos(p1[0]) * Math.sin(p1[1]) + B * Math.cos(p2[0]) * Math.sin(p2[1]);
    const z = A * Math.sin(p1[0]) + B * Math.sin(p2[0]);
    let lon = Math.atan2(y, x) * toD; const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) * toD;
    if (prevLon !== null) { while (lon - prevLon > 180) lon -= 360; while (lon - prevLon < -180) lon += 360; }
    prevLon = lon; out.push([lat, lon]);
  }
  return out;
}
const kmBetween = (a, b) => { const R = Math.PI / 180, h = Math.sin((b.lat - a.lat) * R / 2) ** 2 + Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.sin((b.lon - a.lon) * R / 2) ** 2; return Math.round(12742 * Math.asin(Math.sqrt(h))); };
const WMO = c => c == null ? "" : c === 0 ? "Clear" : c <= 2 ? "Partly cloudy" : c === 3 ? "Cloudy" : c <= 48 ? "Fog" : c <= 57 ? "Drizzle" : c <= 67 ? "Rain" : c <= 77 ? "Snow" : c <= 82 ? "Showers" : c <= 86 ? "Snow showers" : "Storms";
async function dayWeather(date, place) {
  const today = todayLocal();
  const base = date < today ? "https://archive-api.open-meteo.com/v1/archive" : "https://api.open-meteo.com/v1/forecast";
  const r = await fetch(`${base}?latitude=${place.lat}&longitude=${place.lon}&start_date=${date}&end_date=${date}&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto`);
  const j = await r.json(); const d = j.daily;
  if (!d || d.temperature_2m_max[0] == null) throw new Error("No weather for that date yet");
  return { min: Math.round(d.temperature_2m_min[0]), max: Math.round(d.temperature_2m_max[0]), summary: WMO(d.weather_code[0]) };
}

/* Open Google Maps' Timeline so the user can export it (1i). A web page can't open Android's Settings
   screens, but this link opens the Maps app's Timeline on the phone; export is in its ⋮ menu. */
function openTimeline(quiet) {
  if (!quiet) alert("Google Maps will open your Timeline.\n\nTo export it: tap ⋮ (top right) › Location & privacy settings › Export Timeline data, save the file, then come back and use Import / Build map.\n\n(Or: phone Settings › Location › Location services › Timeline › Export Timeline data.)");
  /* 1y: Timeline now lives in the Google Maps app (the web page only offers deleting old history),
     so on Android open the Maps app itself */
  const web = "https://www.google.com/maps/timeline";
  if (/Android/i.test(navigator.userAgent)) location.href = "intent://www.google.com/maps/timeline#Intent;scheme=https;package=com.google.android.apps.maps;S.browser_fallback_url=" + encodeURIComponent(web) + ";end";
  else window.open(web, "_blank");
}
/* 4f: the phone's Location settings - the shortest way to Export Timeline data (Location services › Timeline).
   Tested on the user's S22: a web link CAN open this Settings screen (Google's Timeline settings page itself
   is locked to apps); the Maps Timeline has no Export in it any more. */
function openLocationSettings() {
  if (/Android/i.test(navigator.userAgent)) location.href = "intent:#Intent;action=android.settings.LOCATION_SOURCE_SETTINGS;end";
  else alert("On your phone: Settings › Location › Location services › Timeline › Export Timeline data.");
}
/* ======================= Google Timeline import =======================
   Google moved Timeline onto the phone in 2024 - there is no web API. The phone can export it:
   Settings > Location > Location services > Timeline > Export Timeline data  (Timeline.json)
   Older Google Takeout "Records.json" / "Semantic Location History" files work too. */
function parseLatLng(s) { const m = String(s).match(/(-?\d+(?:\.\d+)?)°?,\s*(-?\d+(?:\.\d+)?)/); return m ? [+m[1], +m[2]] : null; }
function parseTimeline(json) {
  const pts = [];
  const add = (t, ll) => { if (t && ll) pts.push({ t: new Date(t).getTime(), lat: ll[0], lon: ll[1] }); };
  if (Array.isArray(json.semanticSegments)) {                       // new on-device export
    for (const s of json.semanticSegments) {
      for (const p of s.timelinePath || []) add(p.time, parseLatLng(p.point));
      if (s.visit?.topCandidate?.placeLocation?.latLng) add(s.startTime, parseLatLng(s.visit.topCandidate.placeLocation.latLng));
      if (s.activity?.start?.latLng) add(s.startTime, parseLatLng(s.activity.start.latLng));
      if (s.activity?.end?.latLng) add(s.endTime, parseLatLng(s.activity.end.latLng));
    }
    for (const r of json.rawSignals || []) if (r.position?.LatLng) add(r.position.timestamp, parseLatLng(r.position.LatLng));
  }
  if (Array.isArray(json.locations)) for (const l of json.locations)  // Takeout Records.json
    add(l.timestamp || (l.timestampMs && +l.timestampMs), [l.latitudeE7 / 1e7, l.longitudeE7 / 1e7]);
  if (Array.isArray(json.timelineObjects)) for (const o of json.timelineObjects) {  // Takeout semantic history
    const a = o.activitySegment, v = o.placeVisit;
    if (a) { for (const w of a.waypointPath?.waypoints || []) add(a.duration?.startTimestamp, [w.latE7 / 1e7, w.lngE7 / 1e7]);
      if (a.startLocation) add(a.duration?.startTimestamp, [a.startLocation.latitudeE7 / 1e7, a.startLocation.longitudeE7 / 1e7]);
      if (a.endLocation) add(a.duration?.endTimestamp, [a.endLocation.latitudeE7 / 1e7, a.endLocation.longitudeE7 / 1e7]); }
    if (v?.location) add(v.duration?.startTimestamp, [v.location.latitudeE7 / 1e7, v.location.longitudeE7 / 1e7]);
  }
  return pts.filter(p => !isNaN(p.t)).sort((a, b) => a.t - b.t);
}
const localDay = t => { const d = new Date(t); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
function thin(coords, max = 400) { if (coords.length <= max) return coords; const k = coords.length / max; return Array.from({ length: max }, (_, i) => coords[Math.floor(i * k)]).concat([coords[coords.length - 1]]); }

/* ======================= maps ======================= */
const TILE = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
/* 4a: the map library loads when a screen with a map opens (it used to load with every start, Home included) */
const LEAFLET = "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/";
function leafletReady() {
  if (window.L) return Promise.resolve();
  return leafletReady.p ||= Promise.all([
    new Promise(ok => { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = LEAFLET + "leaflet.css"; l.onload = l.onerror = ok; document.head.appendChild(l); }),
    new Promise((ok, bad) => { const sc = document.createElement("script"); sc.src = LEAFLET + "leaflet.js"; sc.onload = ok;
      sc.onerror = () => { sc.remove(); leafletReady.p = null; bad(new Error("couldn't load the maps - are you online?")); }; document.head.appendChild(sc); })]);
}
/* 4a: every live map, so leaving a screen removes them (they used to keep running, with their window listeners) */
const liveMaps = new Set();
function drawMap(el, { routes = [], points = [], view = null, interactive = true, onView = null, caption = "" }) {
  el.innerHTML = "";
  if (!window.L) { el.innerHTML = `<div class="hint" style="padding:8px">Map unavailable – no connection</div>`; return null; }
  const m = L.map(el, { preferCanvas: !interactive,   // 1p: print view draws routes on a canvas so Share can copy them in place
    zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 120,   // 1x: finer zoom - pinch in quarter steps, +/- in half steps (was whole steps = x2 each)
    zoomControl: interactive, attributionControl: false, dragging: interactive, scrollWheelZoom: interactive, doubleClickZoom: interactive, touchZoom: interactive, boxZoom: false, keyboard: false });
  L.tileLayer(TILE, { maxZoom: 18, crossOrigin: true }).addTo(m);
  const all = [];
  for (const r of routes) {
    if (!r.coords || r.coords.length < 2) continue;
    L.polyline(r.coords, { color: r.kind === "flight" ? "#1f5fbf" : "#b3261e", weight: r.kind === "flight" ? 2.5 : 3.5, dashArray: r.kind === "flight" ? "6 6" : null }).addTo(m);
    all.push(...r.coords);
  }
  for (const p of points) { L.circleMarker([p.lat, p.lon], { radius: 4, color: "#3b2b05", fillColor: "#FFD700", fillOpacity: 1, weight: 1.5 }).addTo(m).bindTooltip(p.name || "", { permanent: !!p.label, direction: "top", className: "" }); all.push([p.lat, p.lon]); }
  if (view) m.setView(view.c, view.z);
  else if (all.length) m.fitBounds(L.latLngBounds(all).pad(0.15), { maxZoom: 13 });
  else m.setView([-31.43, 152.91], 5);
  if (onView) m.on("moveend", () => onView({ c: [m.getCenter().lat, m.getCenter().lng], z: m.getZoom() }));
  if (caption) { const c = document.createElement("div"); c.className = "cap"; c.textContent = caption; el.appendChild(c); }
  setTimeout(() => { if (liveMaps.has(m)) m.invalidateSize(); }, 60);
  liveMaps.add(m); m.on("unload", () => liveMaps.delete(m));
  return m;
}
/* km along a route (timeline tracks carry no km of their own) */
function routeKm(r) {
  if (!r?.coords?.length) return 0; if (r.km) return r.km;
  const R = Math.PI / 180; let k = 0;
  for (let i = 1; i < r.coords.length; i++) { const [a1, o1] = r.coords[i - 1], [a2, o2] = r.coords[i];
    const h = Math.sin((a2 - a1) * R / 2) ** 2 + Math.cos(a1 * R) * Math.cos(a2 * R) * Math.sin((o2 - o1) * R / 2) ** 2; k += 12742 * Math.asin(Math.sqrt(h)); }
  return Math.round(k);
}
function dayRoutes(day) { return day.route?.coords?.length ? [{ kind: day.route.kind, coords: day.route.coords }] : []; }
function dayPoints(day) { return [day.from, day.to].filter(p => p && p.lat != null).map(p => ({ ...p, label: true })); }

/* ======================= router ======================= */
const views = {};
let current = null;
/* 1l: tapping a date box on the phone only selected the day digits (no calendar) - open the
   calendar on any tap instead. showPicker() needs a user tap, which this is. */
document.addEventListener("click", e => {
  const el = e.target;
  if (el instanceof HTMLInputElement && el.type === "date" && typeof el.showPicker === "function") {
    try { el.showPicker(); } catch (_) {}
  }
});

/* 1l: an edit screen registers how to save itself here. Before 1l, Edit trip / Edit day only saved
   from their own Save / ‹ Back buttons - the phone's Back gesture, switching apps or closing the app
   lost the changes (a new trip stayed "New trip"). Now leaving by ANY route saves, the app going to
   the background saves, and typing autosaves too. */
let leaveHook = null;
async function leaveCurrent() {
  const f = leaveHook; leaveHook = null;
  if (f) try { await f("leave"); } catch (e) { console.error(e); }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") leaveHook?.("hidden"); });
addEventListener("pagehide", () => leaveHook?.("hidden"));
/* typing autosave: each edit screen sets autoSave; runs ~1 s after the last change */
let autoSave = null;
const kickAutoSave = () => { clearTimeout(kickAutoSave.t); if (autoSave) kickAutoSave.t = setTimeout(() => autoSave?.(), 1000); };
main.addEventListener("input", kickAutoSave);
main.addEventListener("change", kickAutoSave);
/* today's date on THIS phone - toISOString() is UTC, which in Australia is yesterday until 10-11 am */
const todayLocal = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const addDaysIso = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };

function go(name, ...args) { current = { name, args }; location.hash = [name, ...args].join("/"); }
window.addEventListener("hashchange", render);
let layoutDrawAll = null;   // 4a: the Pages screen's "draw every map that's left" (for Print / Share)
async function render() {
  await leaveCurrent();
  clearTimeout(kickAutoSave.t); autoSave = null; layoutDrawAll = null;
  for (const m of [...liveMaps]) { try { m.remove(); } catch {} liveMaps.delete(m); }
  document.querySelectorAll("body > .imgbar:not(#imgbar), body > .movehandle").forEach(e => e.remove());   // pickers / the 2i move handle   // an open ℹ Info / map picker from the screen just left
  const [name = "home", ...args] = location.hash.replace(/^#/, "").split("/").filter(Boolean);
  document.getElementById("pagestyle")?.remove();
  window.scrollTo(0, 0);
  try { await (views[name] || views.home)(...args); } catch (e) { console.error(e); main.innerHTML = `<div class="card">Something went wrong: ${esc(e.message)}</div><button onclick="location.hash=''">Home</button>`; }
}

/* ======================= spending (4a) =======================
   Each day: amount + currency + category. Totals in the trip's home currency at today's rate
   (open.er-api.com - free, no key; the last rates are kept for offline). */
const CATS = { stay: "🏨 Stay", food: "🍽 Food", travel: "🚗 Transport", flight: "✈ Flights", fuel: "⛽ Fuel", fun: "🎟 Activities", shop: "🛍 Shopping", other: "• Other" };
const CURS = ["AUD", "NZD", "USD", "EUR", "GBP", "CAD", "JPY", "CHF", "CNY", "HKD", "SGD", "THB", "INR", "IDR", "MYR", "VND", "PHP", "KRW", "FJD", "ZAR", "AED", "SEK", "NOK", "DKK", "MXN"];
const guessHome = () => ({ AU: "AUD", NZ: "NZD", GB: "GBP", US: "USD", CA: "CAD", IN: "INR", IE: "EUR", ZA: "ZAR", SG: "SGD" })[(navigator.language || "").split("-")[1]] || "AUD";
const curOptions = sel => CURS.map(c => `<option${c === sel ? " selected" : ""}>${c}</option>`).join("");
const FX_KEY = "dsr-travel-fx";
const fxCached = base => { try { const c = JSON.parse(localStorage.getItem(FX_KEY)); return c && c.base === base ? c.rates : null; } catch { return null; } };
async function fxRates(base) {
  let c = null; try { c = JSON.parse(localStorage.getItem(FX_KEY)); } catch {}
  if (c && c.base === base && Date.now() - c.at < 12 * 3600e3) return c.rates;
  try { const j = await (await fetch("https://open.er-api.com/v6/latest/" + base)).json();
    if (j.result === "success") { try { localStorage.setItem(FX_KEY, JSON.stringify({ base, at: Date.now(), rates: j.rates })); } catch {} return j.rates; } } catch {}
  return c && c.base === base ? c.rates : null;
}
const toHome = (e, home, rates) => e.cur === home ? e.amt : rates?.[e.cur] ? e.amt / rates[e.cur] : null;
const money = (v, cur) => { try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 }).format(v); } catch { return v.toFixed(2) + " " + cur; } };
function moneySum(list, home, rates) {
  let tot = 0; const other = {};
  for (const e of list) { const v = toHome(e, home, rates); if (v == null) other[e.cur] = (other[e.cur] || 0) + e.amt; else tot += v; }
  return [tot || !Object.keys(other).length ? money(tot, home) : "", ...Object.entries(other).map(([c, v]) => money(v, c))].filter(Boolean).join(" + ");
}
const spendOf = d => (d.spend || []).filter(e => e.amt > 0);
/* ======================= trip in numbers (4a) ======================= */
function tripStats(t) {
  const st = { days: t.days.length, km: 0, flyKm: 0, countries: new Set(), places: new Set(), nights: 0, photos: photoIdsOf(t).length, words: 0 };
  for (const d of t.days) {
    const k = routeKm(d.route); if (d.route?.kind === "flight") st.flyKm += k; else st.km += k;
    for (const p of [d.from, d.to]) if (p?.name) { st.places.add(p.name); if (p.country) st.countries.add(p.country); }
    if (d.motel) st.nights++;
    st.words += ((d.notes || "").replace(/<[^>]+>/g, " ").match(/[A-Za-z0-9À-ž']+/g) || []).length;
  }
  return st;
}
const nf = n => n.toLocaleString();
function statLine(st, sep = " · ") {
  return [`${st.days} day${st.days === 1 ? "" : "s"}`, st.km ? `${nf(st.km)} km on the ground` : "", st.flyKm ? `${nf(st.flyKm)} km flown` : "",
    st.countries.size ? `${st.countries.size} countr${st.countries.size === 1 ? "y" : "ies"}` : "", st.places.size ? `${st.places.size} place${st.places.size === 1 ? "" : "s"}` : "",
    st.nights ? `${st.nights} night${st.nights === 1 ? "" : "s"} away` : "", st.photos ? `${st.photos} photo${st.photos === 1 ? "" : "s"}` : "", st.words ? `${nf(st.words)} words` : ""].filter(Boolean).join(sep);
}
const stars = n => n ? "★".repeat(n) + "☆".repeat(5 - n) : "";
const flag = cc => /^[A-Za-z]{2}$/.test(cc || "") ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 127397 + c.charCodeAt(0))) : "";
const plainText = h => (h || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
/* search every trip (4a): names, places, hotels, highlights, notes, spending */
function searchTrips(trips, q) {
  const ql = q.toLowerCase(), out = [];
  const snip = (hay, i) => { const a = Math.max(0, i - 40), b = Math.min(hay.length, i + q.length + 60);
    return (a ? "…" : "") + esc(hay.slice(a, i)) + "<b>" + esc(hay.slice(i, i + q.length)) + "</b>" + esc(hay.slice(i + q.length, b)) + (b < hay.length ? "…" : ""); };
  for (const t of trips) {
    const th = [t.name, t.description].filter(Boolean).join(" · "), ti = th.toLowerCase().indexOf(ql);
    if (ti >= 0) out.push({ t, d: null, html: snip(th, ti) });
    const days = [...t.days].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    days.forEach((d, n) => {
      const hay = [d.title, d.highlight, d.from?.name, d.to?.name, d.motel, d.roomDesc, plainText(d.notes), ...(d.spend || []).map(e => e.what)].filter(Boolean).join(" · ");
      const i = hay.toLowerCase().indexOf(ql); if (i >= 0) out.push({ t, d, n: n + 1, html: snip(hay, i) });
    });
  }
  return out.slice(0, 80);
}

/* ======================= views ======================= */
views.home = async () => {
  const trips = (await allTrips()).sort((a, b) => (b.start || "").localeCompare(a.start || ""));
  // 4a: "on this day" - days from earlier years on today's date
  const today = todayLocal(), memories = [];
  for (const t of trips) [...t.days].sort((a, b) => (a.date || "").localeCompare(b.date || "")).forEach((d, i) => {
    if (d.date && d.date.slice(5) === today.slice(5) && d.date.slice(0, 4) < today.slice(0, 4)) memories.push({ t, d, n: i + 1 });
  });
  const tripCards = () => trips.map(t => `<div class="card tripcard" data-id="${t.id}"><div class="ttl">${esc(t.name)}</div>
      <div class="sub">${esc(t.description || "")}</div><div class="sub">${fmtDate(t.start)}${t.end ? " – " + fmtDate(t.end) : ""} · ${t.days.length} day${t.days.length === 1 ? "" : "s"}</div></div>`).join("");
  main.innerHTML = `
    <div class="row" style="justify-content:space-between"><h2>My trips</h2><button class="pri" id="newTrip">+ New trip</button></div>
    ${trips.length ? `<input id="q" type="search" placeholder="🔍 Search every trip – places, notes, hotels…" style="margin-bottom:10px">` : ""}
    ${memories.slice(0, 3).map(m => `<div class="card tripcard memory" data-t="${m.t.id}" data-d="${m.d.id}"><div class="sub" style="color:var(--gold)">📅 On this day in ${m.d.date.slice(0, 4)}</div>
      <div class="ttl" style="font-size:15px">${esc(m.t.name)} · Day ${m.n}${m.d.title ? " · " + esc(m.d.title) : ""}</div>${m.d.highlight ? `<div class="sub">${esc(m.d.highlight)}</div>` : ""}</div>`).join("")}
    <div id="homeList">${trips.length ? tripCards() : `<div class="card"><div class="ttl">No trips yet</div><div class="sub">Tap “New trip”, give it a name, then add a page for each day of travel.</div></div>`}</div>
    ${trips.some(t => t.days.some(d => d.from || d.to)) ? `<div class="row" style="margin:4px 0 6px"><button id="world">🌍 My travel map</button></div>` : ""}
    <div class="row" id="unusedLink" style="margin:4px 0 6px"></div>
    <h3>Open a shared trip / backup</h3><div class="row"><button class="pri" id="impAll">Open a shared trip or backup file</button></div>
    <p class="hint">Got a trip PDF in Messenger? Open it, tap ⋮ › Download, then tap the button above and pick it (it's in Downloads).</p>
    <p class="hint">Journals are saved on this device. Use Export on a trip to back it up or move it to another phone/PC.</p>`;
  const wire = () => {
    main.querySelectorAll(".tripcard[data-id]").forEach(c => c.onclick = () => go("trip", c.dataset.id));
    main.querySelectorAll("[data-t][data-d]").forEach(c => c.onclick = () => go("day", c.dataset.t, c.dataset.d));
  };
  wire();
  const q = $("#q");
  if (q) q.oninput = () => { clearTimeout(q.t); q.t = setTimeout(() => {
    const v = q.value.trim();
    if (v.length < 2) { $("#homeList").innerHTML = tripCards(); return wire(); }
    const hits = searchTrips(trips, v);
    $("#homeList").innerHTML = hits.length ? `<div class="hint" style="margin-bottom:6px">${hits.length}${hits.length === 80 ? "+" : ""} found</div>` + hits.map(h => h.d
      ? `<div class="card tripcard" data-t="${h.t.id}" data-d="${h.d.id}"><div class="sub" style="color:var(--gold)">${esc(h.t.name)} · Day ${h.n} · ${shortDate(h.d.date)}</div><div class="ttl" style="font-size:14px">${esc(h.d.title || "Untitled day")}</div><div class="sub">${h.html}</div></div>`
      : `<div class="card tripcard" data-id="${h.t.id}"><div class="ttl" style="font-size:15px">${esc(h.t.name)}</div><div class="sub">${h.html}</div></div>`).join("")
      : `<div class="card"><div class="sub">Nothing found for “${esc(v)}”.</div></div>`;
    wire();
  }, 200); };
  if ($("#world")) $("#world").onclick = () => go("world");
  /* 4b: photos stored but in no day (taken out of the notes) - one link here instead of a button on every day */
  unusedPhotos().then(list => { const box = $("#unusedLink"); if (!box || !list.length) return;
    box.innerHTML = `<button class="sm" id="goUnused">🧩 ${list.length} unused photo${list.length === 1 ? "" : "s"} – put back or delete</button>`;
    $("#goUnused").onclick = () => go("unused"); });
  $("#newTrip").onclick = async () => {
    const t = { id: uid(), name: "New trip", description: "", start: todayLocal(), end: "", cover: [], days: [], timeline: null };
    await putTrip(t); go("tripEdit", t.id);
  };
  $("#impAll").onclick = importBackup;
};

views.trip = async id => {
  const t = await getTrip(id); if (!t) return go("home");
  t.days.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  main.innerHTML = `
    <div class="row"><button class="sm" onclick="location.hash=''">‹ Trips</button></div>
    <h2>${esc(t.name)}</h2><div class="hint">${esc(t.description || "")}</div>
    ${t.days.length ? `<div class="tnums">${statLine(tripStats(t), "</span><span>").replace(/^/, "<span>")}</span></div>` : ""}
    <div class="card" id="spendCard" style="display:none"></div>
    <div class="row" style="margin:10px 0"><button id="addDay" class="pri">+ Add day</button><button id="editTrip">Edit trip</button><button id="layout">A5 pages / print</button>
      <button id="packing">🧳 Packing list${t.packing?.length ? ` · ${t.packing.filter(x => x.done).length}/${t.packing.length}` : ""}</button></div>
    ${t.days.map((d, i) => `<div class="card tripcard" data-d="${d.id}"><div class="ttl">Day ${i + 1} · ${esc(d.title || "Untitled day")}${d.rating ? ` <span class="starsml">${stars(d.rating)}</span>` : ""}</div>
      <div class="sub">${fmtDate(d.date)}${d.from?.name || d.to?.name ? " · " + esc([d.from?.name, d.to?.name].filter(Boolean).join(" → ")) : ""}</div>
      ${d.highlight ? `<div class="sub" style="color:var(--gold-deep)">✨ ${esc(d.highlight)}</div>` : ""}</div>`).join("") || `<div class="card"><div class="sub">No days yet – tap “Add day”.</div></div>`}`;
  main.querySelectorAll("[data-d]").forEach(c => c.onclick = () => go("day", id, c.dataset.d));
  $("#packing").onclick = () => go("packing", id);
  /* 4a: what the trip cost - home currency, per category, per day */
  const all = t.days.flatMap(spendOf);
  if (all.length) {
    const home = t.homeCur || guessHome();
    fxRates(home).then(rates => {
      const card = $("#spendCard"); if (!card) return;
      const byCat = {}; for (const e of all) (byCat[e.cat] ||= []).push(e);
      const daysWith = t.days.filter(d => spendOf(d).length).length, conv = all.every(e => toHome(e, home, rates) != null);
      const tot = conv ? all.reduce((n, e) => n + toHome(e, home, rates), 0) : 0;
      card.innerHTML = `<div class="ttl" style="font-size:15px">💰 Spent ${moneySum(all, home, rates)}${conv && daysWith ? ` <span class="hint">· about ${money(tot / daysWith, home)} a day</span>` : ""}</div>
        <div class="tnums" style="margin:6px 0 0">${Object.entries(byCat).sort((a, b) => b[1].length - a[1].length).map(([c, l]) => `<span>${esc(CATS[c] || c)} ${moneySum(l, home, rates)}</span>`).join("")}</div>
        <div class="hint" style="margin-top:4px">Other currencies at today's rate${rates ? "" : " – no rates yet (offline)"}.</div>`;
      card.style.display = "";
    });
  }
  $("#addDay").onclick = async () => {
    const last = t.days[t.days.length - 1];
    const next = last?.date ? addDaysIso(last.date, 1) : (t.start || todayLocal());
    const d = { id: uid(), date: next, title: "", from: last?.to || null, to: null, weather: null, motel: "", room: "", roomDesc: "", notes: "", route: null, mapView: null };
    t.days.push(d); await putTrip(t); go("day", id, d.id);
  };
  $("#editTrip").onclick = () => go("tripEdit", id);
  $("#layout").onclick = () => go("layout", id);
};

views.tripEdit = async id => {
  const t = await getTrip(id); if (!t) return go("home");
  await ensureTL(t);
  main.innerHTML = `
    <div class="row"><button class="sm" id="back">‹ Back</button></div>
    <h2>Edit trip</h2>
    <label>Trip name</label><input id="name" value="${esc(t.name)}">
    <label>Trip description (shown small in every page footer)</label><input id="desc" value="${esc(t.description)}">
    <div class="two"><div><label>Start date</label><input type="date" id="start" value="${t.start || ""}"></div><div><label>End date</label><input type="date" id="end" value="${t.end || ""}"></div></div>
    <div class="two"><div><label>Journal font</label><select id="jfont">${Object.entries(FONTS).map(([k, f]) => `<option value="${k}" style="font-family:${esc(f.css)}">${f.label}</option>`).join("")}</select></div>
      <div><label>Text size</label><select id="jsize">${Object.entries(SIZES).map(([k, z]) => `<option value="${k}">${z.label}</option>`).join("")}</select></div></div>
    <div class="hint" id="jfontprev" style="padding:8px;border-radius:6px;background:var(--paper);color:var(--ink);margin-top:6px">Our journey through the Highlands – 26 September</div>
    <div class="two"><div><label>Home currency (spending totals)</label><select id="homeCur">${curOptions(t.homeCur || guessHome())}</select></div>
      <div><label>Journal pages</label><label style="color:var(--text);font-size:13px;display:flex;gap:6px;align-items:center;margin-top:8px"><input type="checkbox" id="showSpend" style="width:auto"${t.showSpend ? " checked" : ""}> show each day's spending</label></div></div>
    <h3>Cover photos</h3><div class="row" id="covers"></div>
    <div class="row" style="margin-top:6px"><button class="sm" id="addCover">+ Add cover photos</button></div>
    <h3>Google Timeline</h3>
    <div class="hint">${t.timeline ? `Imported: ${t.timeline.length} location points. Days with a timeline track can use it as their travel map.` : "Not imported."}<br>
      On your phone: Settings › Location › Location services › Timeline › Export Timeline data, then pick that file here.</div>
    <div class="row" style="margin-top:6px"><button class="sm" id="openLoc">📍 Phone location settings</button><button class="sm" id="openTl">Open Google Timeline</button><button class="sm" id="impTl">Import Timeline file</button>${t.timeline ? `<button class="sm" id="useTl">Use timeline for every day</button>` : ""}</div>
    <h3>Save / share</h3>
    <div class="row"><button class="pri" id="save">Save</button><button class="sm" id="export">Export backup file</button><button class="sm" id="shareLink">Share whole trip (link)</button><button class="sm" id="shareTrip">Send as a file</button><button class="sm danger" id="del">Delete trip</button></div>
    <div class="card" id="linkbox" style="display:none"></div>
    <p class="hint"><b>Share whole trip (link)</b> publishes the journal (days, notes, photos, maps) as a website on your GitHub Pages and sends its link in Messenger, WhatsApp, email… Anyone can read it in their browser – no app needed – and it has a button to add the trip to their own DSR Travel Journal. It's also listed on your trips home page. Share again after changes and the same link shows the new version.<br>
      <b>Send as a file</b> sends it as a PDF instead; the other person downloads it and opens it with <b>Open a shared trip</b> on the home screen.</p>`;
  const drawCovers = async () => {
    $("#covers").innerHTML = "";
    for (const pid of t.cover) {
      const w = document.createElement("div"); w.style.cssText = "position:relative";
      w.innerHTML = `<img src="${await photoURL(pid)}" style="width:80px;height:80px;object-fit:cover;border-radius:6px;border:1px solid var(--gold-deep)"><button class="sm danger" style="position:absolute;top:2px;right:2px;padding:1px 6px">×</button>`;
      w.querySelector("button").onclick = () => { t.cover = t.cover.filter(x => x !== pid); drawCovers(); kickAutoSave(); };
      $("#covers").appendChild(w);
    }
  };
  drawCovers();
  const collect = () => { t.name = $("#name").value.trim() || "Untitled trip"; t.description = $("#desc").value.trim(); t.start = $("#start").value; t.end = $("#end").value;
    t.font = { family: $("#jfont").value, size: $("#jsize").value }; t.homeCur = $("#homeCur").value; t.showSpend = $("#showSpend").checked; };
  $("#jfont").value = t.font?.family || "classic"; $("#jsize").value = t.font?.size || "normal";
  const fontPreview = () => { const f = FONTS[$("#jfont").value], z = SIZES[$("#jsize").value]; $("#jfontprev").style.fontFamily = f.css; $("#jfontprev").style.fontSize = (15 * z.k) + "px"; };
  $("#jfont").onchange = $("#jsize").onchange = fontPreview; fontPreview();
  $("#addCover").onclick = async () => {
    const failed = [];
    for (const f of (await pickFiles($("#filePick"))).slice(0, 6)) { try { t.cover.push(await withTimeout(importPhoto(f), 60000, "took over a minute - is it still downloading from Google Photos?")); } catch (e) { failed.push(`${f.name || "photo"}: ${e.message}`); } }
    t.cover = t.cover.slice(0, 6); drawCovers(); kickAutoSave();
    if (failed.length) toast(`Couldn't add ${failed.length} photo${failed.length > 1 ? "s" : ""} – ${failed[0]}`, 6000);
  };
  // 1l: saved however the screen is left, when the app goes to the background, and while typing
  let deleted = false;
  const persist = async () => { if (deleted) return; collect(); await putTrip(t); };
  leaveHook = persist; autoSave = persist;
  $("#save").onclick = async () => { await persist(); toast("Trip saved"); go("trip", id); };
  $("#back").onclick = () => go("trip", id);   // leaving saves (leaveHook)
  $("#del").onclick = async () => { if (confirm(`Delete “${t.name}” and all its days?`)) { deleted = true; leaveHook = autoSave = null; await delTrip(id); go("home"); } };
  $("#export").onclick = async () => { await persist(); exportTrip(t); };   // 1l: include edits not yet saved (the Timeline is loaded above)
  $("#shareTrip").onclick = async () => { await persist(); shareTrip(t, $("#shareTrip")); };
  $("#shareLink").onclick = async () => { await persist(); shareLinkUI(t); };
  $("#openTl").onclick = openTimeline;
  $("#openLoc").onclick = openLocationSettings;
  $("#impTl").onclick = async () => {
    const [f] = await pickFiles($("#jsonPick"), false); if (!f) return;
    try {
      let pts = parseTimeline(JSON.parse(await f.text()));
      if (t.start) { const s = new Date(t.start + "T00:00:00").getTime() - 864e5, e = (t.end ? new Date(t.end + "T23:59:59").getTime() : Date.now()) + 864e5; pts = pts.filter(p => p.t >= s && p.t <= e); }
      if (!pts.length) return toast("No timeline points found for this trip's dates", 3500);
      setTL(t, pts.map(p => [p.t, +p.lat.toFixed(5), +p.lon.toFixed(5)]));
      collect(); await putTrip(t); toast(`Imported ${pts.length} points`); views.tripEdit(id);
    } catch (e) { toast("That file isn't a Timeline export: " + e.message, 4000); }
  };
  const useTl = $("#useTl"); if (useTl) useTl.onclick = async () => {
    const n = applyTimeline(t);
    collect(); await putTrip(t); toast(n ? `Timeline track added to ${n} day${n === 1 ? "" : "s"}` : "Every day already has its Timeline track (locked maps are left alone)", 3500);
  };
};
/* 1z: give every day that has Timeline points its real track - skipping locked maps and days
   whose track is already up to date (their framing is kept); returns how many changed */
function applyTimeline(t, skip) {
  let n = 0;
  for (const d of t.days) {
    if (d === skip || d.mapLocked || !d.date) continue;
    const c = timelineFor(t, d.date); if (c.length < 2) continue;
    if (d.route?.kind === "timeline" && JSON.stringify(d.route.coords) === JSON.stringify(c)) continue;
    d.route = { kind: "timeline", coords: c }; d.mapView = null; n++;
  }
  return n;
}
const timelineFor = (t, date) => thin((t.timeline || []).filter(p => localDay(p[0]) === date).map(p => [p[1], p[2]]));
/* 2h: the day's Timeline track between two times ("HH:MM", either may be blank) - for a path map in the notes */
const timelinePart = (t, date, from, to) => {
  const mins = s => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ""); return m ? +m[1] * 60 + +m[2] : null; };
  const a = mins(from) ?? 0, b = mins(to) ?? 24 * 60;
  return thin((t.timeline || []).filter(p => { if (localDay(p[0]) !== date) return false; const d = new Date(p[0]), m = d.getHours() * 60 + d.getMinutes(); return m >= a && m <= b; })
    .map(p => [p[1], p[2]]), 300);
};

/* geo picker: type a place, pick from suggestions; "📍" = current position */
function geoField(el, value, onPick) {
  el.classList.add("geo");
  el.innerHTML = `<div class="row" style="flex-wrap:nowrap"><input placeholder="Search town, airport, place…" value="${esc(value?.name ? value.name + (value.region ? ", " + value.region : "") : "")}"><button class="sm" title="Use my location">📍</button></div><div class="sug" hidden></div>`;
  const inp = el.querySelector("input"), sug = el.querySelector(".sug"); let tmr;
  inp.oninput = () => { clearTimeout(tmr); if (inp.value.trim().length < 2) { sug.hidden = true; return; }
    tmr = setTimeout(async () => { const res = await geoSearch(inp.value.trim()).catch(() => []);
      sug.innerHTML = res.map((p, i) => `<div data-i="${i}">${esc(p.name)} <span class="hint">${esc(p.region)}</span></div>`).join("") || `<div class="hint">No matches</div>`;
      sug.hidden = false; sug.querySelectorAll("[data-i]").forEach(d => d.onclick = () => { const p = res[+d.dataset.i]; inp.value = p.name + ", " + p.region; sug.hidden = true; onPick(p); }); }, 350); };
  el.querySelector("button").onclick = () => navigator.geolocation.getCurrentPosition(async pos => {
    const p = await reverseGeo(+pos.coords.latitude.toFixed(5), +pos.coords.longitude.toFixed(5)); inp.value = p.name + (p.region ? ", " + p.region : ""); onPick(p);
  }, () => toast("Location not available"), { enableHighAccuracy: true, timeout: 15000 });
}

views.day = async (tripId, dayId, flag) => {
  const t = await getTrip(tripId); const d = t?.days.find(x => x.id === dayId); if (!d) return go("trip", tripId);
  await leafletReady().catch(e => toast(e.message, 4000));
  main.innerHTML = `
    <div class="row"><button class="sm" id="back">‹ ${esc(t.name)}</button><div style="flex:1"></div><button class="sm" id="shareDay" title="Send this day's pages to Messenger, WhatsApp, email… (PDF or pictures)">📤 Share this day</button><button class="sm danger" id="delDay">Delete day</button></div>
    <h2>Edit day</h2>
    <label>Travel day description</label><input id="title" value="${esc(d.title)}" placeholder="e.g. Drive to Sydney, fly to New Delhi">
    <div class="two"><div><label>How was the day?</label><div class="stars" id="stars">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-star="${n}" title="${n} star${n > 1 ? "s" : ""}">★</button>`).join("")}</div></div>
      <div><label>Highlight of the day</label><input id="hl" value="${esc(d.highlight || "")}" placeholder="the best bit"></div></div>
    <label>Date</label><input type="date" id="date" value="${d.date || ""}">
    <label>From</label><div id="from"></div>
    <label>To</label><div id="to"></div>
    <label>Weather for the day</label>
    <div class="row" style="flex-wrap:nowrap"><input id="wx" value="${esc(d.weather ? `${d.weather.min}–${d.weather.max}°C ${d.weather.summary || ""}` : "")}" placeholder="auto-fills from the date + place"><button class="sm" id="getWx">Get</button></div>
    <div class="two"><div><label>Motel / hotel</label><input id="motel" value="${esc(d.motel)}"></div><div><label>Room number</label><input id="room" value="${esc(d.room)}"></div></div>
    <label>Room description</label><textarea id="roomDesc">${esc(d.roomDesc)}</textarea>
    <h3>Day's travel map</h3>
    <div class="row"><select id="rkind" style="flex:1">
      <option value="">No travel map</option><option value="road">Journey line – road route (from → to)</option><option value="flight">Journey line – flight (from → to)</option>
      <option value="timeline">Google Timeline – where I actually went</option></select><button class="sm" id="build">Build map</button></div>
    <div class="hint" id="rinfo"></div>
    <div class="row" style="margin-top:6px"><button class="sm" id="tlExport">📍 Export Google Timeline</button><button class="sm" id="tlLoad">📂 Load Timeline file</button></div>
    <div class="card hint" id="tlSteps" style="display:none;margin-top:6px"><b style="color:var(--gold)">Export your Google Timeline</b> (it lives on your phone):<br>
      1. Tap <b>📍 Phone location settings</b> below, then <b>Location services</b> › <b>Timeline</b> › <b>Export Timeline data</b>.<br>
      2. Save the file (e.g. to Downloads).<br>
      3. Come back here and tap <b>📂 Load Timeline file</b> – this day's map is then drawn from where you actually went, and it offers to do the other days too.<br>
      <i>No need to do this daily:</i> until then each day shows its From → To road route; export every few days or once at the end.<br>
      <button class="sm" id="tlLoc" style="margin-top:6px">📍 Phone location settings</button></div>
    <div class="mapframe" id="dmap" style="height:260px;margin-top:6px"></div>
    <div class="hint"><span id="dmaphint">Pinch/drag the map to frame it – the page uses exactly this view.</span> <button class="sm" id="refit">Re-fit</button> <button class="sm" id="dlock">🔒 Lock</button></div>
    <h3>Travel notes</h3>
    <div class="etb"><button class="sm" id="bPhoto">📷 Photo</button><button class="sm" id="bDayPhotos" title="Show only the photos taken on this day">📅 Day's photos</button><button class="sm" id="bMap">🗺 Map</button><button class="sm" data-cmd="bold"><b>B</b></button><button class="sm" data-cmd="italic"><i>I</i></button><button class="sm" data-cmd="insertUnorderedList">• List</button><button class="sm" id="bVoice" title="Speak your notes">🎤 Voice</button><button class="sm" id="bInfo" title="Highlight a place or feature, then tap to add a paragraph about it">ℹ Info</button><select id="selFont" class="sm" style="width:auto"><option value="">Font</option>${Object.entries(FONTS).map(([k, f]) => `<option value="${k}" style="font-family:${esc(f.css)}">${f.label}</option>`).join("")}</select><select id="selSize" class="sm" style="width:auto">${SEL_SIZES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select><div style="flex:1"></div><button class="sm pri" id="save">Save</button>
      <div class="hint" id="voiceLive" style="display:none;color:var(--gold);flex-basis:100%"></div>
      <div class="row vk" id="voiceKeys" style="display:none;flex-basis:100%;gap:4px">
        <button class="sm" data-vk="full stop" data-l="Full stop">.</button><button class="sm" data-vk="comma" data-l="Comma">,</button><button class="sm" data-vk="question mark" data-l="Question">?</button>
        <button class="sm" data-vk="new paragraph" data-l="New line">¶</button><button class="sm" data-vk="word" data-l="Del word">⌫</button><button class="sm" data-vk="scratch" data-l="Scratch">↶</button>
        <select id="voiceEng" class="sm" style="width:auto;flex:1;min-width:120px"><option value="google">Google</option>${DsrSpeech.MODELS.filter(m => !/small/.test(m.id)).map(m => `<option value="${m.id}">${m.name} – private</option>`).join("")}</select></div>
      <div class="hint" id="photoMsg" style="display:none;color:var(--gold);flex-basis:100%" title="Tap to hide"></div></div>
    <div class="notes-edit" id="notes" contenteditable="true" style="${esc(fontVars(t))}"></div>
    <p class="hint">Tap in the text where you want a photo, then 📷 (or 🎤 to speak). Highlight a place or sight and tap ℹ Info to add a paragraph about it. Tap a photo or map to resize, align or remove it.</p>
    <h3>Spending</h3><div id="spend"></div>
    <div class="row" style="margin-top:6px"><button class="sm" id="addSpend">+ Add an expense</button><span class="hint" id="spendTot"></span></div>`;
  /* 4a: rating (tap the same star again to clear) */
  let rating = d.rating || 0;
  const paintStars = () => main.querySelectorAll("[data-star]").forEach(b => b.classList.toggle("on", +b.dataset.star <= rating));
  main.querySelectorAll("[data-star]").forEach(b => b.onclick = () => { rating = rating === +b.dataset.star ? 0 : +b.dataset.star; paintStars(); kickAutoSave(); });
  paintStars();
  /* 4a: spending - one line per expense */
  const home = t.homeCur || guessHome(), spendBox = $("#spend");
  const spendRow = e => {
    const r = document.createElement("div"); r.className = "sprow";
    r.innerHTML = `<input class="amt" type="number" inputmode="decimal" step="0.01" min="0" placeholder="Amount" value="${e.amt ?? ""}"><select class="cur">${curOptions(e.cur || home)}</select>
      <select class="cat">${Object.entries(CATS).map(([k, v]) => `<option value="${k}"${k === e.cat ? " selected" : ""}>${v}</option>`).join("")}</select>
      <input class="what" placeholder="What for (optional)" value="${esc(e.what || "")}"><button class="sm danger" type="button" title="Remove this expense">✕</button>`;
    r.querySelector("button").onclick = () => { r.remove(); spendTotal(); kickAutoSave(); };
    spendBox.appendChild(r); return r;
  };
  const readSpend = () => [...spendBox.querySelectorAll(".sprow")].map(r => ({ amt: Math.round(parseFloat(r.querySelector(".amt").value) * 100) / 100 || 0, cur: r.querySelector(".cur").value,
    cat: r.querySelector(".cat").value, what: r.querySelector(".what").value.trim() })).filter(e => e.amt > 0 || e.what);
  const spendTotal = async () => { const l = readSpend().filter(e => e.amt > 0); $("#spendTot").textContent = l.length ? "This day: " + moneySum(l, home, await fxRates(home)) : ""; };
  (d.spend || []).forEach(spendRow);
  $("#addSpend").onclick = () => { const last = readSpend().pop(); spendRow({ cur: last?.cur || t.lastCur || home, cat: "food" }).querySelector(".amt").focus(); };
  spendBox.addEventListener("input", spendTotal); spendBox.addEventListener("change", spendTotal); spendTotal();
  let from = d.from, to = d.to;
  geoField($("#from"), from, p => { from = p; autoRoute(); });
  geoField($("#to"), to, p => { to = p; autoRoute(); });
  $("#rkind").value = d.route?.kind || "";
  // notes: stored with data-pid only; object URLs attached at load
  const notes = $("#notes"); notes.innerHTML = d.notes || "<p><br></p>";
  await hydrate(notes, true);
  let map = null;
  // d.mapLocked (1h): the day map stops taking drags/pinches so scrolling past it can't reframe it
  const drawDayMap = (view = d.mapView) => { map?.remove(); map = drawMap($("#dmap"), { routes: dayRoutes(d), points: dayPoints({ from, to }), view, interactive: !d.mapLocked, onView: d.mapLocked ? null : v => d.mapView = v }); };
  const dayLockUI = () => { $("#dlock").textContent = d.mapLocked ? "🔓 Unlock" : "🔒 Lock"; $("#refit").disabled = !!d.mapLocked;
    $("#dmaphint").textContent = d.mapLocked ? "Map locked – unlock to move or zoom it." : "Pinch/drag the map to frame it – the page uses exactly this view."; };
  drawDayMap();
  const info = () => $("#rinfo").textContent = d.route ? `${d.route.kind === "timeline" ? "Timeline track" : d.route.kind === "flight" ? "Flight" : "Road"}${d.route.km ? " · about " + d.route.km + " km" : ""}` : "";
  info();
  $("#refit").onclick = () => { d.mapView = null; drawDayMap(null); };
  $("#dlock").onclick = () => {
    // keep exactly what's on screen when locking
    if (!d.mapLocked && map) d.mapView = { c: [map.getCenter().lat, map.getCenter().lng], z: map.getZoom() };
    d.mapLocked = !d.mapLocked; drawDayMap(); dayLockUI(); toast(d.mapLocked ? "Day map locked" : "Day map unlocked");
  };
  dayLockUI();
  /* Journey line by default (1c): with From and To set and no map chosen, draw the road route
     automatically (a flight arc if there's no road - sea crossings - or it's over 1500 km).
     Choosing "No travel map" and pressing Build map switches this off for the day. */
  async function autoRoute() {
    if (!from || !to || d.noAutoRoute) return;
    if (d.route && !d.route.auto) return;                       // the user picked their own map
    if (d.route?.auto && d.route.fromKey === key(from) && d.route.toKey === key(to)) return;
    let r;
    try { if (kmBetween(from, to) > 1500) throw 0; toast("Drawing the journey…"); const rr = await roadRoute(from, to); r = { kind: "road", coords: thin(rr.coords, 500), km: rr.km }; }
    catch { r = { kind: "flight", coords: flightArc(from, to), km: kmBetween(from, to) }; }
    d.route = { ...r, auto: true, fromKey: key(from), toKey: key(to) };
    d.from = from; d.to = to; d.mapView = null; $("#rkind").value = r.kind; drawDayMap(null); info();
  }
  const key = p => p ? (+p.lat).toFixed(3) + "," + (+p.lon).toFixed(3) : "";
  if (d.route) $("#rkind").value = d.route.kind;
  autoRoute();
  /* Google Timeline straight from the day screen: pick the phone's Timeline export once; its points
     are kept with the trip (merged with any earlier import) so every day can use them */
  async function importTimelineHere() {
    const [f] = await pickFiles($("#jsonPick"), false); if (!f) return false;
    try {
      const pts = parseTimeline(JSON.parse(await f.text()));
      if (!pts.length) { toast("No location points in that file", 3500); return false; }
      await ensureTL(t);
      const seen = new Set((t.timeline || []).map(p => p[0]));
      setTL(t, [...(t.timeline || []), ...pts.filter(p => !seen.has(p.t)).map(p => [p.t, +p.lat.toFixed(5), +p.lon.toFixed(5)])].sort((a, b) => a[0] - b[0]));
      await putTrip(t); toast(`Timeline loaded: ${pts.length} points`); return true;
    } catch (e) { toast("That file isn't a Timeline export: " + e.message, 4500); return false; }
  }
  /* 1y: Timeline export / load right beside the day map */
  $("#tlExport").onclick = () => { const b = $("#tlSteps"); b.style.display = b.style.display === "none" ? "block" : "none"; };
  $("#tlLoc").onclick = openLocationSettings;
  $("#tlLoad").onclick = async () => {
    if (!await importTimelineHere()) return;
    $("#tlSteps").style.display = "none";
    const others = t.days.filter(x => x !== d && !x.mapLocked && x.date && timelineFor(t, x.date).length > 1 &&
      !(x.route?.kind === "timeline" && JSON.stringify(x.route.coords) === JSON.stringify(timelineFor(t, x.date)))).length;
    if (others && confirm(`The Timeline also covers ${others} other day${others === 1 ? "" : "s"} of this trip.\n\nUse it for their maps too? (Locked maps are left as they are.)`)) {
      const n = applyTimeline(t, d); await putTrip(t); toast(`Timeline track added to ${n} other day${n === 1 ? "" : "s"}`, 3000);
    }
    if (!$("#date").value) return toast("Timeline loaded - set the day's date, then Build map with Google Timeline", 4000);
    $("#rkind").value = "timeline"; $("#build").click();
  };
  $("#build").onclick = async () => {
    const k = $("#rkind").value;
    try {
      if (!k) { d.route = null; d.noAutoRoute = true; }
      else if (k === "timeline") {
        if (!$("#date").value) throw new Error("Set the day's date first");
        await ensureTL(t);
        let c = timelineFor(t, $("#date").value);
        if (c.length < 2 && !t.timeline && confirm("No Google Timeline loaded yet.\n\nOpen your phone's Location settings now to export it?\n(Then Location services › Timeline › Export Timeline data. Cancel if you already have the file.)")) { openLocationSettings(); return; }
        if (c.length < 2 && confirm((t.timeline ? "No Timeline points for this date yet." : "No Google Timeline loaded yet.") +
            "\n\nPick your Timeline export file now?\n(On the phone: Settings › Location › Location services › Timeline › Export Timeline data)")) {
          if (await importTimelineHere()) c = timelineFor(t, $("#date").value);
        }
        if (c.length < 2) throw new Error("No timeline points on this date");
        d.route = { kind: "timeline", coords: c }; d.noAutoRoute = false; }
      else { if (!from || !to) throw new Error("Choose From and To first");
        d.noAutoRoute = false;
        if (k === "road") { toast("Finding the road route…"); const r = await roadRoute(from, to); d.route = { kind: "road", coords: thin(r.coords, 500), km: r.km }; }
        else d.route = { kind: "flight", coords: flightArc(from, to), km: kmBetween(from, to) }; }
      d.from = from; d.to = to; d.mapView = null; drawDayMap(null); info();
    } catch (e) { toast(e.message, 3500); }
  };
  $("#getWx").onclick = async () => {
    const place = to || from; if (!place || !$("#date").value) return toast("Set the date and a place first");
    try { const w = await dayWeather($("#date").value, place); d.weather = w; $("#wx").value = `${w.min}–${w.max}°C ${w.summary}`; } catch (e) { toast(e.message, 3000); }
  };
  // editor toolbar
  main.querySelectorAll("[data-cmd]").forEach(b => b.onmousedown = e => { e.preventDefault(); document.execCommand(b.dataset.cmd); });
  let savedRange = null;
  const keepRange = () => { const s = getSelection(); if (s.rangeCount && notes.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange(); };
  notes.addEventListener("keyup", keepRange); notes.addEventListener("mouseup", keepRange); notes.addEventListener("touchend", () => setTimeout(keepRange, 0)); notes.addEventListener("input", keepRange);
  const insertNode = node => {
    const s = getSelection(); s.removeAllRanges();
    if (savedRange && notes.contains(savedRange.startContainer)) s.addRange(savedRange); else { const r = document.createRange(); r.selectNodeContents(notes); r.collapse(false); s.addRange(r); }
    const r = s.getRangeAt(0); r.deleteContents(); r.insertNode(node); r.setStartAfter(node); r.collapse(true); s.removeAllRanges(); s.addRange(r); savedRange = r.cloneRange();
  };
  /* Font / Size for the selected text (1i). Picking from a list on a phone takes the focus away from
     the notes, so the last selection is restored first. Sizes are relative (em) so they scale with
     the trip's text size in print. */
  // (1l: removed again when the day is left - it used to pile up one listener per visit)
  const onSelChange = () => { const sel = getSelection(); if (sel.rangeCount && notes.contains(sel.anchorNode) && !sel.isCollapsed) savedRange = sel.getRangeAt(0).cloneRange(); };
  document.addEventListener("selectionchange", onSelChange);
  const styleSelection = (apply) => {
    if (!savedRange || savedRange.collapsed || !notes.contains(savedRange.startContainer)) { toast("Select some text in the notes first"); return; }
    notes.focus(); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(savedRange);
    document.execCommand("styleWithCSS", false, true);
    apply();
    const r = getSelection().rangeCount ? getSelection().getRangeAt(0) : null; if (r) savedRange = r.cloneRange();
  };
  $("#selFont").onchange = e => { const f = FONTS[e.target.value]; e.target.value = ""; if (!f) return;
    styleSelection(() => document.execCommand("fontName", false, f.css)); };
  $("#selSize").onchange = e => { const v = e.target.value; e.target.value = ""; if (!v) return;
    styleSelection(() => {
      document.execCommand("fontSize", false, "7");   // marks the selection; replaced with our relative size
      const made = [];
      notes.querySelectorAll('font[size="7"], span[style*="xxx-large"]').forEach(el => {
        const span = document.createElement("span"); span.style.fontSize = v + "em"; span.innerHTML = el.innerHTML;
        if (el.style?.fontFamily) span.style.fontFamily = el.style.fontFamily;
        el.replaceWith(span); made.push(span);
      });
      if (made.length) {   // re-select the text so Font can be applied straight after
        const r = document.createRange(); r.setStartBefore(made[0]); r.setEndAfter(made[made.length - 1]);
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      }
    }); };
  /* 🎤 Voice (4a): DSR Dictation 3a's engine (dsr-speech.js - shared with DSR Notes / Secure Store). Google, or
     Private (on this phone - nothing leaves it; Moonshine shows words while you talk). Spoken commands (full stop,
     comma, new paragraph, question mark, scratch that, delete last word, replace X with Y, insert date, stop
     dictation…), um / uh left out, automatic capitals, punctuation keys, screen kept awake. */
  const VKEY = "dsr-voice";
  const VS = Object.assign({ engine: "google", model: DsrSpeech.DEFAULT_MODEL }, (() => { try { return JSON.parse(localStorage.getItem(VKEY) || "{}"); } catch { return {}; } })());
  const voiceBtn = $("#bVoice"), live = $("#voiceLive"), vkeys = $("#voiceKeys");
  let vsess = null, vlastOps = 0, vcaps = false, vwake = null;
  const caretRange = () => { if (!(savedRange && notes.contains(savedRange.startContainer))) { const r = document.createRange(); r.selectNodeContents(notes); r.collapse(false); savedRange = r; } return savedRange; };
  /* the text before the cursor; a cursor at the start of an empty / new paragraph counts as a new line (capitals) */
  const ctxBefore = () => {
    const r = caretRange(), all = (() => { const x = r.cloneRange(); x.setStart(notes, 0); return x.toString(); })();
    let blk = r.startContainer; while (blk && blk !== notes && blk.parentNode !== notes) blk = blk.parentNode;
    if (blk && blk !== notes) { const rb = document.createRange(); rb.setStart(blk, 0); rb.setEnd(r.startContainer, r.startOffset); if (!rb.toString().trim()) return all.replace(/\s*$/, "") + (all.trim() ? "\n" : ""); }
    return all;
  };
  const vselect = () => { notes.focus(); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(caretRange()); return sel; };
  const vdone = () => { const sel = getSelection(); if (sel.rangeCount && notes.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange(); kickAutoSave(); };
  const vinsert = (text, eat) => {
    const sel = vselect(); let ops = 0;
    if (eat) { for (let k = 0; k < eat; k++) sel.modify("extend", "backward", "character"); document.execCommand("delete"); ops++; }
    text.split("\n").forEach((ln, i) => { if (i) { document.execCommand("insertParagraph"); ops++; } if (ln) { document.execCommand("insertText", false, ln); ops++; } });
    vlastOps = ops; vdone();
  };
  const vcmd = (c, a) => {
    if (c === "stop") { stopVoice(); return toast("Voice typing stopped"); }
    if (c === "capsOn" || c === "capsOff") { vcaps = c === "capsOn"; return toast(vcaps ? "CAPS on" : "CAPS off"); }
    if (c === "scratch") { if (!vlastOps) return; vselect(); for (let k = 0; k < vlastOps; k++) document.execCommand("undo"); vlastOps = 0; vdone(); return toast("Removed the last bit"); }
    if (c === "undo" || c === "redo") { vselect(); document.execCommand(c); vlastOps = 0; return vdone(); }
    const gran = { deleteWord: "word", deleteSentence: "sentenceboundary", deleteLine: "paragraphboundary" }[c];
    if (gran) { const sel = vselect(); sel.modify("extend", "backward", gran); if (!sel.isCollapsed) document.execCommand("delete"); vlastOps = 0; return vdone(); }
    if (c === "readBack") {
      const m = ctxBefore().trim().match(/[^.!?\n]*[.!?]*$/), txt = m && m[0].trim();
      if (txt && "speechSynthesis" in window) { stopVoice(); const u = new SpeechSynthesisUtterance(txt); u.lang = navigator.language || "en-AU"; u.onend = () => { if (notes.isConnected && !vsess) voiceBtn.click(); }; speechSynthesis.speak(u); }
      return;
    }
    if (c === "replace") {   // the LAST place those words appear (within one run of text)
      const re = new RegExp("(^|[^A-Za-z0-9])(" + a.from.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+") + ")(?![A-Za-z0-9])", "gi");
      const tw = document.createTreeWalker(notes, NodeFilter.SHOW_TEXT); let hit = null, n;
      while ((n = tw.nextNode())) { re.lastIndex = 0; let m; while ((m = re.exec(n.data))) { hit = { n, at: m.index + m[1].length, old: m[2] }; if (m.index === re.lastIndex) re.lastIndex++; } }
      if (!hit) return;
      const keep = caretRange().cloneRange(), r = document.createRange(); r.setStart(hit.n, hit.at); r.setEnd(hit.n, hit.at + hit.old.length);
      notes.focus(); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      document.execCommand("insertText", false, /^[A-Z]/.test(hit.old) ? a.to.charAt(0).toUpperCase() + a.to.slice(1) : a.to);
      if (notes.contains(keep.startContainer)) savedRange = keep;
      vlastOps = 0; kickAutoSave(); return toast("Replaced “" + hit.old + "”");
    }
  };
  const vcommit = (raw, over) => {
    if (!notes.isConnected) return;
    const r = DsrSpeech.process(raw, ctxBefore(), Object.assign({ fillers: true, caps: true, capsLock: vcaps, has: q => notes.textContent.toLowerCase().includes(q.toLowerCase()) }, over || {}));
    if (r.cmd) return vcmd(r.cmd, r.arg);
    if (r.text) vinsert(r.text.replace(/\n{2,}/g, "\n"), r.eat);   // a new line here is already a new paragraph
  };
  const vname = () => VS.engine === "private" ? DsrSpeech.modelInfo(VS.model).name + " (private)" : "Google";
  const setVoiceUI = () => {
    const on = !!vsess;
    voiceBtn.textContent = on ? "⏹ Stop" : "🎤 Voice"; voiceBtn.classList.toggle("pri", on);
    live.style.display = vkeys.style.display = on ? "" : "none";
    $("#voiceEng").value = VS.engine === "private" ? VS.model : "google";
  };
  const stopVoice = () => { const s = vsess; vsess = null; try { s?.stop(); } catch {} try { vwake?.release(); } catch {} vwake = null; setVoiceUI(); };
  const startVoice = () => {
    const s = vsess = DsrSpeech.start({ engine: VS.engine, model: VS.model, lang: navigator.language || "en-AU", interim: true, continuous: true,
      onInterim: tx => { if (vsess === s) live.textContent = tx ? "… " + tx : "Listening (" + vname() + ")…"; },
      onFinal: tx => vcommit(tx),
      onStatus: tx => { if (vsess === s) live.textContent = tx; },
      onProgress: (p, label, amt) => { if (vsess === s && p != null) live.textContent = label + (amt ? " (" + amt + ")" : ""); },
      onError: (m, fatal) => { toast(m, 5000); if (fatal && vsess === s) stopVoice(); },
      onEnd: () => { if (vsess === s) stopVoice(); } });
    try { navigator.wakeLock?.request("screen").then(w => { if (vsess === s) vwake = w; else w.release(); }, () => {}); } catch {}
    live.textContent = "Starting (" + vname() + ")…"; setVoiceUI();
  };
  voiceBtn.onmousedown = e => e.preventDefault();   // keep the cursor where it is in the notes
  voiceBtn.onclick = () => vsess ? stopVoice() : startVoice();
  vkeys.querySelectorAll("button").forEach(b => { b.onmousedown = e => e.preventDefault();
    b.onclick = () => { if (b.dataset.vk === "word") vcmd("deleteWord"); else if (b.dataset.vk === "scratch") vcmd("scratch"); else vcommit(b.dataset.vk, { punct: true }); }; });
  $("#voiceEng").onchange = e => {
    const v = e.target.value; if (v === "google") VS.engine = "google"; else { VS.engine = "private"; VS.model = v; }
    try { localStorage.setItem(VKEY, JSON.stringify(VS)); } catch {}
    toast("Voice typing: " + vname() + (VS.engine === "private" ? " – nothing leaves the phone" : "")); if (vsess) { stopVoice(); startVoice(); }
  };
  $("#bPhoto").onmousedown = e => e.preventDefault();
  $("#bPhoto").onclick = async () => addPhotoFiles(await pickFiles($("#filePick")));
  /* 3b: 📅 Day's photos - asks the DSR Day Photos app (Android) for the photos taken on this day. It looks them
     up in the phone's own photo index, so it's instant however many photos the phone holds (2p handed the
     whole camera folder to the page and filtered it here - hopeless with hundreds of thousands). The ticked
     photos come back through "share" (manifest share_target -> #sharedphotos) and go into this day's notes.
     If DSR Day Photos isn't installed the page stays in front, so after a moment we say so. */
  $("#bDayPhotos").onmousedown = e => e.preventDefault();
  $("#bDayPhotos").onclick = async () => {
    const date = $("#date").value || d.date;
    if (!date) return toast("Set this day's date first", 3000);
    try { await autoSave?.(); } catch (e) {}
    try { localStorage.setItem(DAYPICK_KEY, JSON.stringify({ trip: t.id, day: d.id, date, at: Date.now() })); } catch (e) {}
    const out = $("#photoMsg");
    out.style.display = "block"; out.onclick = null;
    out.innerHTML = `Opening DSR Day Photos for ${esc(fmtDate(date))}…`;
    let left = false; const away = () => { if (document.visibilityState === "hidden") left = true; };
    document.addEventListener("visibilitychange", away);
    /* 3c: if it isn't installed Chrome would open the Play Store ("Item not found") - browser_fallback_url
       brings it back to this day instead, with #.../nodp to say so */
    const back = location.href.split("#")[0] + "#day/" + t.id + "/" + d.id + "/nodp";
    location.href = "intent://pick?date=" + date + "#Intent;scheme=dsrdayphotos;package=com.dsr.dayphotos;S.browser_fallback_url=" + encodeURIComponent(back) + ";end";
    setTimeout(() => {
      document.removeEventListener("visibilitychange", away);
      if (left) { out.style.display = "none"; return; }
      noDayPhotosApp();
    }, 2500);
  };
  function noDayPhotosApp() {
    const out = $("#photoMsg"); if (!out) return;
    out.style.display = "block"; out.onclick = null;
    out.innerHTML = `DSR Day Photos isn't installed on this phone - it finds a day's photos instantly. Meanwhile: <button class="sm" id="dpInstead">Choose photos instead</button> <button class="sm" id="dpFolder">Search a folder</button>`;
    $("#dpInstead").onclick = async () => dayPhotosFrom(await pickFiles($("#filePick")), true);
    $("#dpFolder").onclick = async () => { out.textContent = "Pick a folder - a big one takes the phone a while to hand over."; const got = await pickFiles($("#dirPick")); dayPhotosFrom(got, false); };
  }
  if (flag === "nodp") { history.replaceState(null, "", location.pathname + "#day/" + t.id + "/" + d.id); try { localStorage.removeItem(DAYPICK_KEY); } catch (e) {} setTimeout(noDayPhotosApp, 300); }
  /* 3b: photos handed back by DSR Day Photos (via #sharedphotos) - added once the day screen is ready */
  if (pendingDayPhotos && pendingDayPhotos.day === d.id) { const files = pendingDayPhotos.files; pendingDayPhotos = null; setTimeout(() => addPhotoFiles(files), 300); }   // no caret after the reload - they go at the end of the notes
  /* 2q: the day filter for a folder, or for photos picked one by one from the phone's photo picker */
  async function dayPhotosFrom(files, fromPicker) {
    const date = $("#date").value || d.date, out = $("#photoMsg");
    out.style.display = "block";
    const all = files.filter(f => /^image\//.test(f.type) || /\.(jpe?g|heic|heif|png|webp)$/i.test(f.name));
    if (!all.length) {
      out.innerHTML = (fromPicker ? "No photos were picked." : `No photos came back from that folder (${files.length} file${files.length === 1 ? "" : "s"}). Your photos may be kept in Google Photos / the cloud rather than on the phone. `) +
        ` <button class="sm" id="dpInstead2">Choose photos instead</button>`;
      $("#dpInstead2").onclick = async () => dayPhotosFrom(await pickFiles($("#filePick")), true);
      return;
    }
    out.onclick = () => out.style.display = "none";
    const found = [];
    for (let i = 0; i < all.length; i++) {
      if (i % 50 === 0) { out.textContent = `Looking through ${all.length} photos for ${fmtDate(date)}… ${i}`; await new Promise(r => setTimeout(r)); }
      const when = await photoTakenAt(all[i], date, fromPicker || all.length <= 400);   // a small folder: read every photo's own date (copied photos have new file dates)
      if (when && when.slice(0, 10) === date) found.push({ f: all[i], when });
    }
    if (!found.length) {
      out.innerHTML = `No photos from ${fmtDate(date)} among the ${all.length} ${fromPicker ? "picked" : "in that folder"}.` + (fromPicker ? "" : ` <button class="sm" id="dpInstead3">Choose photos instead</button>`);
      if (!fromPicker) $("#dpInstead3").onclick = async () => dayPhotosFrom(await pickFiles($("#filePick")), true);
      return;
    }
    out.style.display = "none";
    found.sort((a, b) => a.when.localeCompare(b.when));
    const picked = new Set(), urls = [];
    const w = document.createElement("div"); w.className = "imgbar"; w.style.display = "block"; w.style.maxHeight = "80vh"; w.style.overflow = "auto";
    w.innerHTML = `<div style="color:var(--gold);margin-bottom:4px">Photos taken on ${esc(fmtDate(date))} (${found.length})</div>
      <div class="hint" style="margin-bottom:6px">Tap the ones to add.</div>
      <div id="dgrid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px"></div>
      <div class="row" style="margin-top:8px"><button class="sm" id="dall">Select all</button><div style="flex:1"></div><button class="sm" id="dx">Cancel</button><button class="sm pri" id="dadd" disabled>Add</button></div>`;
    document.body.appendChild(w);
    const grid = w.querySelector("#dgrid"), addBtn = w.querySelector("#dadd");
    const sync = () => { addBtn.disabled = !picked.size; addBtn.textContent = picked.size ? `Add ${picked.size}` : "Add";
      grid.querySelectorAll("[data-i]").forEach(c => c.style.outline = picked.has(+c.dataset.i) ? "3px solid var(--gold)" : "none"); };
    found.forEach((x, i) => {
      const c = document.createElement("div"); c.dataset.i = i; c.style.cssText = "cursor:pointer;border-radius:6px;overflow:hidden";
      const heic = /\.(heic|heif)$/i.test(x.f.name) || /hei[cf]/i.test(x.f.type), u = heic ? "" : URL.createObjectURL(x.f); if (u) urls.push(u);
      c.innerHTML = (heic ? `<div style="width:100%;aspect-ratio:1;display:grid;place-items:center;background:#222;color:var(--gold);font-size:12px">HEIC photo</div>`
        : `<img src="${u}" loading="lazy" style="width:100%;aspect-ratio:1;object-fit:cover;display:block">`) +
        `<div class="hint" style="text-align:center;font-size:11px">${x.when.length > 10 ? x.when.slice(11, 16) : ""}</div>`;
      c.onclick = () => { picked.has(i) ? picked.delete(i) : picked.add(i); sync(); };
      grid.appendChild(c);
    });
    const close = () => { w.remove(); urls.forEach(u => URL.revokeObjectURL(u)); };
    w.querySelector("#dall").onclick = () => { found.forEach((_, i) => picked.add(i)); sync(); };
    w.querySelector("#dx").onclick = close;
    addBtn.onclick = () => { const files = found.filter((_, i) => picked.has(i)).map(x => x.f); close(); addPhotoFiles(files); };
  }
  async function addPhotoFiles(files) {
    if (!files.length) return;
    /* 2a: progress + a result line that stays, so a picker that hands over fewer photos than were
       ticked, or photos that fail, are visible */
    /* 2n: the message sits in the sticky toolbar, so it stays in view however far down the notes the
       photos go in; tap it to hide it */
    const out = $("#photoMsg"); out.style.display = "block"; out.onclick = () => out.style.display = "none";
    let added = 0; const failed = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      out.textContent = `Adding photo ${i + 1} of ${files.length}…`;
      try { const pid = await withTimeout(importPhoto(f), 60000, "took over a minute - is it still downloading from Google Photos?"); const img = document.createElement("img"); img.dataset.pid = pid; img.style.width = "45%"; img.style.float = "right"; img.src = await photoURL(pid); insertNode(img); added++; kickAutoSave(); }
      catch (e) { failed.push(`${f.name || "photo"}: ${e.message}`); }
      await new Promise(r => setTimeout(r, 150));   // let the phone free the last photo's memory
    }
    out.textContent = `The phone handed over ${files.length} photo${files.length === 1 ? "" : "s"}: ${added} added` + (failed.length ? `, ${failed.length} couldn't be read (${failed.join("; ")})` : "") + ".";
    toast(failed.length ? `Couldn't add ${failed.length} photo${failed.length > 1 ? "s" : ""}` : added > 1 ? `${added} photos added` : "Photo added", 4000);
    kickAutoSave();
  }
  /* ℹ Info (1n): highlight a place / sight in the notes (or type one), pick the Wikipedia article,
     and a short paragraph about it goes in on the line below the highlighted text */
  $("#bInfo").onmousedown = e => e.preventDefault();   // keep the highlighted text selected
  $("#bInfo").onclick = () => {
    const picked = savedRange && notes.contains(savedRange.startContainer) && !savedRange.collapsed ? savedRange.toString().trim() : "";
    const anchor = savedRange && notes.contains(savedRange.endContainer) ? savedRange.cloneRange() : null;
    infoPicker(picked, [to?.name, from?.name].filter(Boolean), text => {
      const p = document.createElement("p"); p.textContent = text;
      let blk = anchor ? anchor.endContainer : null;
      while (blk && blk.parentNode !== notes) blk = blk.parentNode;
      if (blk && blk.parentNode === notes) blk.after(p); else notes.appendChild(p);
      const r = document.createRange(); r.selectNodeContents(p); r.collapse(false);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); savedRange = r.cloneRange();
      p.scrollIntoView({ block: "nearest", behavior: "instant" });
      kickAutoSave(); toast("Paragraph added – edit it like any other text");
    });
  };
  $("#bMap").onmousedown = e => e.preventDefault();
  const placeNoteMap = async box => {
    sizeNoteMap(box, 100); alignNoteMap(box, "center");
    insertNode(box); await hydrate(notes, true);
    // carry on typing on the line below the new map
    const after = roomAfterMaps().get(box);
    if (after) { const r = document.createRange(); r.setStart(after, 0); r.collapse(true); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); savedRange = r.cloneRange(); notes.focus(); }
    kickAutoSave();
  };
  $("#bMap").onclick = () => mapPicker(async p => {
    const box = document.createElement("div"); box.className = "nmap mapframe"; box.contentEditable = "false";
    box.dataset.lat = box.dataset.plat = p.lat; box.dataset.lon = box.dataset.plon = p.lon; box.dataset.z = 12; box.dataset.name = p.name;
    await placeNoteMap(box);
  }, async (from, to) => {
    // 2h: the path actually travelled, from the trip's Google Timeline (whole day or between two times)
    const date = $("#date").value;
    if (!date) { toast("Set the day's date first", 3000); return false; }
    await ensureTL(t);
    let c = timelinePart(t, date, from, to);
    if (c.length < 2 && !t.timeline && confirm("No Google Timeline loaded for this trip yet.\n\nPick your Timeline export file now?")) {
      if (await importTimelineHere()) c = timelinePart(t, date, from, to);
    }
    if (c.length < 2) { toast(t.timeline ? "No Timeline points for that day" + (from || to ? " / those times" : "") : "No Timeline loaded", 3500); return false; }
    const box = document.createElement("div"); box.className = "nmap mapframe"; box.contentEditable = "false";
    box.dataset.path = c.map(([la, lo]) => (+la).toFixed(5) + "," + (+lo).toFixed(5)).join(";");
    box.dataset.plat = c[0][0]; box.dataset.plon = c[0][1];
    box.dataset.name = "My path" + (from || to ? ` ${from || "start"}–${to || "end"}` : "");
    box.dataset.fit = "1";   // first draw: fit the whole path, then remember that view
    await placeNoteMap(box);
    return true;
  });
  /* A map is a non-editable block: with nothing after it (map at the end of the notes, or two maps in
     a row) there was nowhere to put the cursor below it. Keep an empty line after each such map;
     serializeNotes() drops trailing empty lines again so nothing is added to the printed page. */
  function roomAfterMaps() {
    const made = new Map();
    notes.querySelectorAll(".nmap").forEach(m => {
      let blk = m; while (blk.parentNode && blk.parentNode !== notes) blk = blk.parentNode;   // top-level block holding the map
      if (blk.parentNode !== notes) return;
      const endsWithMap = blk === m || [...blk.childNodes].filter(n => !(n.nodeType === 3 && !n.textContent.trim())).pop() === m;
      if (!endsWithMap) return;
      let next = blk.nextSibling; while (next && next.nodeType === 3 && !next.textContent.trim()) next = next.nextSibling;
      /* 2m: the empty typing line kept under a map that WAS last stays behind once photos / text are added
         after it - a big gap below the map, a small one above (user). Drop it when real content follows
         (unless the cursor is in it). */
      const isEmptyLine = n => n?.nodeType === 1 && n.tagName === "P" && !n.textContent.trim() && !n.querySelector("img,.nmap");
      if (isEmptyLine(next)) {
        let after = next.nextSibling; while (after && after.nodeType === 3 && !after.textContent.trim()) after = after.nextSibling;
        const sel = getSelection(), caretIn = sel.rangeCount && next.contains(sel.getRangeAt(0).startContainer);
        if (after && !isEmptyLine(after) && !(after.classList?.contains("nmap") || after.querySelector?.(".nmap")) && !caretIn) { next.remove(); next = after; }
      }
      if (next && !(next.nodeType === 1 && next.querySelector?.(".nmap") || next.classList?.contains("nmap"))) { made.set(m, next); return; }
      const p = document.createElement("p"); p.innerHTML = "<br>"; blk.after(p); made.set(m, p);
    });
    return made;
  }
  roomAfterMaps();
  /* A tap on empty space (beside a centred map, below a map, the notes' bottom margin) isn't on any
     text, so the phone put the cursor back at the top. Send it to the line under the nearest map
     above the tap instead, or the end of the notes. */
  const caretInto = (el, atEnd = true) => {
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(!atEnd);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); savedRange = r.cloneRange(); notes.focus();
  };
  const onEmptyTap = e => {
    if (e.target !== notes) return;                       // a real tap on text / photo / map: leave it
    const y = e.clientY ?? e.changedTouches?.[0]?.clientY; if (y == null) return;
    const room = roomAfterMaps();
    const blocks = [...notes.children];
    const hit = blocks.find(b => { const r = b.getBoundingClientRect(); return y >= r.top && y <= r.bottom; });
    const mapOf = b => b && (b.classList.contains("nmap") ? b : b.querySelector(".nmap"));
    let target = null;
    if (hit && mapOf(hit)) target = room.get(mapOf(hit));              // beside a map: line below it
    else if (!hit) {                                                    // in a gap / below everything
      const above = blocks.filter(b => b.getBoundingClientRect().bottom <= y).pop();
      target = above && mapOf(above) ? room.get(mapOf(above)) : (above || blocks[blocks.length - 1]);
    }
    if (!target) return;
    e.preventDefault(); caretInto(target, true);
  };
  notes.addEventListener("click", onEmptyTap);
  // resize/align bar - photos and maps. Tap a photo, or tap a map (not its +/- buttons)
  const bar = $("#imgbar"); let selImg = null;
  const isMap = el => el?.classList?.contains("nmap");
  const showBar = el => {
    /* 3f: tapping a photo / map also put the text cursor in the notes, so the keyboard came up over this bar -
       take the cursor out (keyboard closes), and place the item above the bar again once it has gone */
    const ae = document.activeElement;
    if (ae && (ae === notes || notes.contains(ae))) { ae.blur(); getSelection().removeAllRanges(); setTimeout(() => { if (selImg === el) { keepAboveBar(el); setTimeout(placeHandle, 60); } }, 450); }
    selImg?.classList.remove("sel"); selImg = el; selImg.classList.add("sel");
    const pct = isMap(el) ? (+el.dataset.w || 100) : (parseInt(el.style.width) || 45);
    $("#imgbarTitle").textContent = isMap(el) ? "Map size" : "Photo size";
    $("#imgRecentre").style.display = isMap(el) ? "" : "none";
    $("#imgsize").min = isMap(el) ? 25 : 15;
    $("#imgsize").value = pct; $("#imgpct").textContent = pct + "% of the page width"; bar.style.display = "block";
    lockUI();
    keepAboveBar(el);
    setTimeout(placeHandle, 60);   // 2i: after keepAboveBar's scroll
  };
  /* 1j: the bar is fixed to the bottom of the screen and covered the photo/map being edited -
     give the page room below and scroll the item so it sits just above the bar */
  const keepAboveBar = el => {
    document.body.style.paddingBottom = (bar.offsetHeight + 16) + "px";
    setTimeout(() => {   // after the bar has laid out
      const r = el.getBoundingClientRect(), barTop = window.innerHeight - bar.offsetHeight - 12;
      if (r.bottom > barTop) window.scrollBy({ top: Math.min(r.bottom - barTop, r.top - 70), behavior: "instant" });
      else if (r.top < 60) window.scrollBy({ top: r.top - 70, behavior: "instant" });
    }, 30);
  };
  /* Lock (1g): freezes a photo's / map's size, alignment and (maps) the view - the map stops taking
     drags and pinches, so scrolling past it on the phone can't move it. Unlock from the same bar. */
  const lockUI = () => {
    const locked = !!selImg?.dataset.lock;
    $("#imgLock").textContent = locked ? "🔓 Unlock" : "🔒 Lock";
    $("#imgpct").textContent = locked ? "Locked" : ($("#imgsize").value + "% of the page width");
    for (const el of [$("#imgsize"), $("#imgRecentre"), $("#imgdel"), ...bar.querySelectorAll("[data-al]")]) el.disabled = locked;
  };
  $("#imgLock").onclick = async () => {
    const el = selImg; if (!el) return;
    if (el.dataset.lock) delete el.dataset.lock; else el.dataset.lock = "1";
    if (isMap(el)) { el._map?.remove(); el._map = null; el.innerHTML = ""; await hydrate(el.parentNode, true); el.classList.add("sel"); }
    lockUI(); placeHandle(); toast(el.dataset.lock ? (isMap(el) ? "Map locked – it won't move now" : "Photo locked") : "Unlocked");
  };
  notes.addEventListener("click", e => {
    if (e.target.tagName === "IMG" && !e.target.closest(".nmap")) return showBar(e.target);
    const m = e.target.closest?.(".nmap");
    if (m && !e.target.closest(".leaflet-control")) showBar(m);
  });
  $("#imgsize").oninput = e => {
    if (!selImg) return;
    if (isMap(selImg)) { sizeNoteMap(selImg, +e.target.value); setTimeout(() => selImg?._map?.invalidateSize(), 50); }
    else selImg.style.width = e.target.value + "%";
    $("#imgpct").textContent = e.target.value + "% of the page width";
    clearTimeout(keepAboveBar.t); keepAboveBar.t = setTimeout(() => { if (selImg) { keepAboveBar(selImg); setTimeout(placeHandle, 60); } }, 250);
  };
  bar.querySelectorAll("[data-al]").forEach(b => b.onclick = () => { if (!selImg) return; const a = b.dataset.al;
    if (isMap(selImg)) { alignNoteMap(selImg, a); setTimeout(() => selImg?._map?.invalidateSize(), 50); return; }
    selImg.style.float = a === "center" ? "none" : a; selImg.style.display = a === "center" ? "block" : ""; selImg.style.margin = a === "center" ? "4px auto" : ""; });
  /* Re-centre a note map on its place. Maps that drifted before 1e have lost their place, so if the
     pin isn't in view the place name is looked up again first. */
  $("#imgRecentre").onclick = async () => {
    const m = selImg; if (!isMap(m)) return;
    if (m.dataset.path) {   // 2h: a Timeline path map: fit the whole path again
      m.dataset.fit = "1"; m._map?.remove(); m._map = null; m.innerHTML = ""; await hydrate(m.parentNode, true);
      m.classList.add("sel"); toast("Map re-fitted to the whole path"); return;
    }
    let lat = +m.dataset.plat, lon = +m.dataset.plon;
    const drifted = m._map && !m._map.getBounds().contains([lat, lon]);
    if (m.dataset.name && (drifted || !m.dataset.placeChecked)) {
      try { const [hit] = await geoSearch(m.dataset.name);
        if (hit && kmBetween({ lat, lon }, hit) > 5) { lat = hit.lat; lon = hit.lon; m.dataset.plat = lat; m.dataset.plon = lon; }
        m.dataset.placeChecked = "1"; } catch {}
    }
    m.dataset.lat = lat; m.dataset.lon = lon; m.dataset.z = 12;
    m._map?.remove(); m._map = null; m.innerHTML = ""; await hydrate(m.parentNode, true);
    m.classList.add("sel"); toast("Map re-centred on " + (m.dataset.name || "its place"));
  };
  const closeBar = () => { selImg?.classList.remove("sel"); selImg = null; bar.style.display = "none"; document.body.style.paddingBottom = ""; placeHandle(); kickAutoSave(); };
  /* 2i/2j: move a photo / map to another place in the notes - hold the gold ✥ handle on the selected item and
     drag: a dashed outline follows the finger, a gold bar shows where it will land, the page scrolls near
     the top / bottom. (Ordinary drag-and-drop inside phone text editing is unreliable, and a map's own
     drag pans it.) Locked items don't move. */
  const handle = document.createElement("div");
  handle.className = "movehandle noprint"; handle.textContent = "✥"; handle.title = "Hold and drag to move";
  handle.style.cssText = "position:fixed;z-index:1500;width:44px;height:44px;border-radius:50%;background:var(--gold);color:#000;display:none;align-items:center;justify-content:center;font-size:26px;line-height:1;touch-action:none;user-select:none;box-shadow:0 1px 6px rgba(0,0,0,.8);cursor:grab";
  document.body.appendChild(handle);
  function placeHandle() {
    if (!selImg || selImg.dataset.lock || !document.body.contains(selImg) || drag) { if (!drag) handle.style.display = "none"; return; }
    const r = selImg.getBoundingClientRect();
    handle.style.display = "flex"; handle.style.left = Math.max(4, r.left - 8) + "px"; handle.style.top = Math.max(56, r.top - 8) + "px";
  }
  window.addEventListener("scroll", placeHandle, { passive: true });
  let drag = null;
  /* 2j: where a drop would go - NEVER "nowhere" (2i refused drops over other maps/photos, the header or the
     scroll zone, so dragging up failed again and again):
       over text   -> that exact spot in the text (small gold bar)
       anywhere else -> the nearest gap between the notes' paragraphs / maps / photos (gold line across) */
  const targetAt = (x, y) => {
    let r = null;
    if (document.caretRangeFromPoint) r = document.caretRangeFromPoint(x, y);
    else if (document.caretPositionFromPoint) { const cp = document.caretPositionFromPoint(x, y); if (cp) { r = document.createRange(); r.setStart(cp.offsetNode, cp.offset); } }
    if (r) {
      const n = r.startContainer, elx = n.nodeType === 1 ? n : n.parentElement;
      if (n.nodeType === 3 && notes.contains(n) && !selImg.contains(n) && !elx?.closest(".nmap")) {
        r.collapse(true);
        const rc = r.getClientRects()[0] || elx.getBoundingClientRect();
        return { range: r, mark: { left: rc.left - 1, top: rc.top, width: 3, height: Math.max(18, rc.height || 18) } };
      }
    }
    // the nearest gap between top-level blocks (the dragged item itself doesn't count)
    const blocks = [...notes.children].filter(b => b !== selImg && !(b.contains(selImg) && !b.textContent.trim()));
    const nr = notes.getBoundingClientRect();
    /* 2k: in the empty space BELOW the end of the notes: add blank lines down to the finger, so the photo /
       map lands where it was dropped (room to type above it later) */
    const lastBottom = blocks.length ? blocks[blocks.length - 1].getBoundingClientRect().bottom : nr.top;
    const lh = parseFloat(getComputedStyle(notes).lineHeight) || parseFloat(getComputedStyle(notes).fontSize) * 1.4 || 22;
    if (y > lastBottom + lh * 0.9) {
      const extra = Math.min(40, Math.round((y - lastBottom) / lh));
      const range = document.createRange(); range.selectNodeContents(notes); range.collapse(false);
      return { range, extra, mark: { left: nr.left + 4, top: Math.min(lastBottom + extra * lh, innerHeight - 8), width: nr.width - 8, height: 4, label: `+${extra} line${extra === 1 ? "" : "s"}` } };
    }
    let before = blocks.find(b => { const br = b.getBoundingClientRect(); return y < br.top + br.height / 2; }) || null;
    const range = document.createRange();
    if (before) range.setStartBefore(before); else { range.selectNodeContents(notes); range.collapse(false); }
    const lineY = before ? before.getBoundingClientRect().top - 2 : (blocks.length ? blocks[blocks.length - 1].getBoundingClientRect().bottom + 1 : nr.top + 4);
    return { range, mark: { left: nr.left + 4, top: Math.min(Math.max(lineY, 4), innerHeight - 8), width: nr.width - 8, height: 4 } };
  };
  const moveDrag = e => {
    if (!drag) return;
    if (e) { drag.x = e.clientX; drag.y = e.clientY; }
    drag.ghost.style.left = (drag.x - 24) + "px"; drag.ghost.style.top = (drag.y - 24) + "px";
    const tg = targetAt(drag.x, drag.y);
    // 2l: the side follows the finger - left third = left, middle = centre, right third = right
    const nr = notes.getBoundingClientRect(), fx = (drag.x - nr.left) / (nr.width || 1);
    drag.side = fx < 1 / 3 ? "left" : fx > 2 / 3 ? "right" : "center";
    const sideTxt = { left: "◀ left", center: "centre", right: "right ▶" }[drag.side];
    if (tg) { drag.range = tg.range; drag.extra = tg.extra || 0; const c = drag.caret.style, m = tg.mark;
      c.display = "block"; c.left = m.left + "px"; c.top = m.top + "px"; c.width = m.width + "px"; c.height = m.height + "px";
      drag.caret.textContent = (m.label ? m.label + " · " : "") + sideTxt; }
    if (!e) return;   // (a scroll tick only refreshes the target)
    clearInterval(drag.scroll);   // near the top / bottom: keep scrolling the page, and keep updating the target
    const dir = drag.y < 90 ? -1 : drag.y > innerHeight - (bar.offsetHeight || 0) - 60 ? 1 : 0;
    if (dir) drag.scroll = setInterval(() => { window.scrollBy(0, dir * 16); moveDrag(null); }, 30);
  };
  handle.addEventListener("pointerdown", e => {
    if (!selImg || selImg.dataset.lock) return;
    e.preventDefault(); try { handle.setPointerCapture(e.pointerId); } catch {}
    const r = selImg.getBoundingClientRect();
    const ghost = document.createElement("div"), caret = document.createElement("div");
    ghost.style.cssText = `position:fixed;z-index:1499;pointer-events:none;border:2px dashed var(--gold);border-radius:6px;background:rgba(255,215,0,.15);width:${Math.min(r.width, 150)}px;height:${Math.min(r.height, 100)}px`;
    caret.style.cssText = "position:fixed;z-index:1499;pointer-events:none;width:3px;border-radius:2px;background:#e0b400;box-shadow:0 0 4px #e0b400;display:none;color:#ffd700;text-shadow:0 0 3px #000,0 0 3px #000;font:bold 12px sans-serif;line-height:4px;white-space:nowrap;text-indent:6px;overflow:visible";
    document.body.append(ghost, caret);
    drag = { ghost, caret, range: null, scroll: 0, x: e.clientX, y: e.clientY };
    selImg.style.opacity = ".35"; handle.style.cursor = "grabbing";
    moveDrag(e);
  });
  handle.addEventListener("pointermove", moveDrag);
  const endDrag = e => {
    if (!drag) return;
    const { ghost, caret, extra, side } = drag; let range = drag.range; clearInterval(drag.scroll); ghost.remove(); caret.remove(); drag = null;
    const el = selImg; handle.style.cursor = "grab"; if (!el) return;
    el.style.opacity = "";
    if (range) {   // 2j: a cancelled touch (the phone took the gesture) still drops at the last spot shown
      let oldBlock = el.parentNode; while (oldBlock && oldBlock !== notes && oldBlock.parentNode !== notes) oldBlock = oldBlock.parentNode;
      if (extra > 0) {   // 2k: dropped below the notes - blank lines down to where it was let go
        for (let k = 0; k < extra; k++) { const pl = document.createElement("p"); pl.innerHTML = "<br>"; notes.appendChild(pl); }
        range = document.createRange(); range.selectNodeContents(notes); range.collapse(false);
      }
      range.insertNode(el);
      if (side) {   // 2l: snap to the side it was dropped on (same as the bar's align buttons)
        if (isMap(el)) alignNoteMap(el, side);
        else { el.style.float = side === "center" ? "none" : side; el.style.display = side === "center" ? "block" : ""; el.style.margin = side === "center" ? "4px auto" : ""; }
      }
      // the line it left behind, now empty, goes too (roomAfterMaps puts back any typing room a map needs)
      if (oldBlock && oldBlock !== notes && oldBlock.isConnected && !oldBlock.contains(el) && !oldBlock.textContent.trim() && !oldBlock.querySelector("img,.nmap")) oldBlock.remove();
      roomAfterMaps();
      if (isMap(el)) setTimeout(() => el._map?.invalidateSize(), 60);
      kickAutoSave(); toast((isMap(el) ? "Map" : "Photo") + " moved" + (side ? " – " + { left: "left", center: "centre", right: "right" }[side] : ""));
    }
    keepAboveBar(el); setTimeout(placeHandle, 80);
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
  $("#imgdone").onclick = closeBar;
  $("#imgdel").onclick = () => { if (isMap(selImg)) selImg._map?.remove(); selImg?.remove(); closeBar(); };

  const collect = () => {
    d.title = $("#title").value.trim(); d.date = $("#date").value; d.from = from; d.to = to;
    d.motel = $("#motel").value.trim(); d.room = $("#room").value.trim(); d.roomDesc = $("#roomDesc").value.trim();
    if (!$("#wx").value.trim()) d.weather = null; else if (!d.weather || $("#wx").value !== `${d.weather.min}–${d.weather.max}°C ${d.weather.summary || ""}`) d.weather = { text: $("#wx").value.trim() };
    d.notes = serializeNotes(notes);
    d.highlight = $("#hl").value.trim(); d.rating = rating;
    d.spend = readSpend(); if (d.spend.length) t.lastCur = d.spend[d.spend.length - 1].cur;
  };
  let deleted = false, lastSig = "";
  // 4a: only written when something actually changed (autosave runs after every pause in typing)
  const quickSave = async () => { if (deleted) return; collect(); const sig = JSON.stringify(d); if (sig === lastSig) return; lastSig = sig; await putTrip(t); };
  const save = async (quiet) => {
    collect();
    if (!d.weather && d.date && (d.to || d.from)) { try { d.weather = await dayWeather(d.date, d.to || d.from); } catch {} }
    await putTrip(t); if (!quiet) toast("Day saved");
  };
  /* 1l: leaving the day by ANY route (phone Back, the ‹ button, app switched away) saves it first -
     straight away, without waiting on the weather lookup; the weather is filled in afterwards on a
     fresh copy of the trip so nothing edited in the meantime is overwritten */
  leaveHook = async reason => {
    if (deleted) return;
    if (reason !== "hidden") { stopVoice(); closeBar(); document.removeEventListener("selectionchange", onSelChange); window.removeEventListener("scroll", placeHandle); handle.remove(); }
    await quickSave();
    if (reason !== "hidden" && !d.weather && d.date && (d.to || d.from)) {
      dayWeather(d.date, d.to || d.from).then(async w => {
        const fresh = await getTrip(tripId); const fd = fresh?.days.find(x => x.id === dayId);
        if (fd && !fd.weather) { fd.weather = w; await putTrip(fresh); }
      }).catch(() => {});
    }
  };
  autoSave = quickSave;
  $("#save").onclick = () => save();
  $("#back").onclick = () => go("trip", tripId);   // leaving saves (leaveHook)
  // 2g: just this day's A5 pages -> the Pages screen's Share box (PDF or pictures -> Messenger etc.); leaving saves the day
  $("#shareDay").onclick = () => go("layout", tripId, "pages", dayId);
  $("#delDay").onclick = async () => { if (confirm("Delete this day?")) { deleted = true; leaveHook = autoSave = null; stopVoice(); closeBar(); document.removeEventListener("selectionchange", onSelChange); t.days = t.days.filter(x => x.id !== dayId); await putTrip(t); go("trip", tripId); } };
};

/* note maps: width as % of the page like photos; the height follows the width (a full-width map is a
   wide strip, a half-width one closer to 3:2), floats left/right or centres */
function sizeNoteMap(m, pct) {
  pct = Math.max(25, Math.min(100, Math.round(pct)));
  m.dataset.w = pct;
  m.style.width = pct + "%";
  m.style.height = "";
  m.style.aspectRatio = String(+(1.5 + (pct - 45) / 55 * 0.9).toFixed(2));   // 45% -> 1.5, 100% -> 2.4
}
function alignNoteMap(m, a) {
  m.dataset.al = a;
  m.style.float = a === "center" ? "none" : a;
  m.style.margin = a === "center" ? "4px auto" : a === "left" ? "4px 8px 4px 0" : "4px 0 4px 8px";
}
/* notes <-> storage: photos saved as <img data-pid>, maps as <div class="nmap" data-lat.. data-z> */
function serializeNotes(el) {
  const c = el.cloneNode(true);
  c.querySelectorAll("img").forEach(i => { i.removeAttribute("src"); i.classList.remove("sel"); });
  c.querySelectorAll(".nmap").forEach(m => { m.innerHTML = ""; m.className = "nmap mapframe"; delete m.dataset.placeChecked; });   // drop Leaflet's own classes
  // trailing empty lines (e.g. the typing room kept below a final map) aren't saved
  let last = c.lastChild;
  // 2n: a photo/map that is itself the last node (not wrapped in a line) is content too - before, saving
  // dropped every such photo from the end of the notes
  while (last && ((last.nodeType === 3 && !last.textContent.trim()) || (last.nodeType === 1 && last.tagName !== "DIV" && !last.matches("img,.nmap") && !last.textContent.trim() && !last.querySelector("img,.nmap")))) { const prev = last.previousSibling; last.remove(); last = prev; }
  return c.innerHTML;
}
async function hydrate(root, interactive) {
  for (const img of root.querySelectorAll("img[data-pid]")) img.src = await photoURL(img.dataset.pid);
  for (const m of root.querySelectorAll(".nmap")) {
    if (m._map) continue;
    sizeNoteMap(m, +m.dataset.w || 100); alignNoteMap(m, m.dataset.al || "center");
    // data-plat/plon = the PLACE (the pin); data-lat/lon/z = the VIEW. Before 1e panning moved both, so
    // the pin wandered off with the view - older maps start with place = their last saved view.
    if (m.dataset.plat == null) {
      m.dataset.plat = m.dataset.lat; m.dataset.plon = m.dataset.lon;
      // one-off repair of a map whose pin drifted (pre-1e): look the place name up, move pin + view back
      if (interactive && m.dataset.name) geoSearch(m.dataset.name).then(([hit]) => {
        if (!hit || kmBetween({ lat: +m.dataset.plat, lon: +m.dataset.plon }, hit) < 5) return;
        m.dataset.plat = m.dataset.lat = hit.lat; m.dataset.plon = m.dataset.lon = hit.lon; m.dataset.z = 12;
        m._map?.remove(); m._map = null; m.innerHTML = ""; hydrate(m.parentNode, true);
      }).catch(() => {});
    }
    const live = interactive && !m.dataset.lock;   // a locked map can't be dragged/zoomed (1g)
    // 2h: a Google Timeline path map (data-path = "lat,lon;lat,lon;…"): the track with start/end dots
    const path = m.dataset.path ? m.dataset.path.split(";").map(x => x.split(",").map(Number)) : null;
    const fit = path && (m.dataset.fit || m.dataset.lat == null);
    m._map = drawMap(m, path
      ? { routes: [{ kind: "timeline", coords: path }], points: [{ lat: path[0][0], lon: path[0][1] }, { lat: path[path.length - 1][0], lon: path[path.length - 1][1] }],
          view: fit ? null : { c: [+m.dataset.lat, +m.dataset.lon], z: +m.dataset.z || 12 }, interactive: live,
          onView: live ? v => { m.dataset.lat = v.c[0]; m.dataset.lon = v.c[1]; m.dataset.z = v.z; delete m.dataset.fit; } : null, caption: m.dataset.name }
      : { points: [{ lat: +m.dataset.plat, lon: +m.dataset.plon, name: m.dataset.name, label: true }], view: { c: [+m.dataset.lat, +m.dataset.lon], z: +m.dataset.z || 12 }, interactive: live,
          onView: live ? v => { m.dataset.lat = v.c[0]; m.dataset.lon = v.c[1]; m.dataset.z = v.z; } : null, caption: m.dataset.name });
    if (fit && m._map) { const c = m._map.getCenter(); m.dataset.lat = c.lat; m.dataset.lon = c.lng; m.dataset.z = m._map.getZoom(); }
  }
}
/* ℹ Info panel (1n): Wikipedia search -> preview -> Insert. [near] = the day's places, used to
   prefer the right article (e.g. "the castle" near Inverness) and shown as a search hint. */
const WIKI = "https://en.wikipedia.org";
async function wikiSearch(q) {
  const r = await fetch(`${WIKI}/w/api.php?action=query&list=search&srlimit=6&srinfo=suggestion&format=json&origin=*&srsearch=${encodeURIComponent(q)}`);
  const j = (await r.json()).query || {};
  const hits = (j.search || []).map(x => ({ title: x.title, snip: x.snippet.replace(/<[^>]+>/g, "") }));
  hits.suggestion = j.searchinfo?.suggestion || "";   // Wikipedia's spelling correction, e.g. "urquhart castle"
  return hits;
}
/* how alike two names are spelt, 0..1 (1 = identical, ignoring case / punctuation / a "(...)" suffix) */
function spellSim(a, b) {
  const n = x => x.toLowerCase().replace(/\s*\(.*\)$/, "").replace(/[^a-z0-9 ]+/g, "").trim();
  a = n(a); b = n(b); if (!a || !b) return 0; if (a === b) return 1;
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) { let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; } }
  return 1 - d[b.length] / Math.max(a.length, b.length);
}
/* 1o: spelling-tolerant lookup - as typed; else Wikipedia's suggested spelling; else a fuzzy search
   ("word~" = up to two letters different per word). Returns the hits and what was actually searched. */
async function wikiSearchTolerant(term) {
  let hits = await wikiSearch(term);
  const suggestion = hits.suggestion;
  if (hits.length) return { hits, used: term, suggestion };
  if (suggestion) { const h = await wikiSearch(suggestion); if (h.length) return { hits: h, used: suggestion, suggestion }; }
  const fuzzy = term.split(/\s+/).map(w => w.length > 3 ? w.replace(/[~"]/g, "") + "~" : w).join(" ");
  if (fuzzy !== term) { const h = await wikiSearch(fuzzy); if (h.length) return { hits: h, used: fuzzy.replace(/~/g, ""), suggestion }; }
  return { hits: [], used: term, suggestion };
}
async function wikiExtract(title) {
  const r = await fetch(`${WIKI}/w/api.php?action=query&prop=extracts&explaintext=1&exintro=1&redirects=1&format=json&origin=*&titles=${encodeURIComponent(title)}`);
  const pg = Object.values((await r.json()).query?.pages || {})[0];
  return cleanWiki(pg?.extract || "");
}
/* Wikipedia's first sentence opens with brackets of pronunciation / other-language names
   ("The Taj Mahal ( TAHJ mə-HAHL; Hindustani: [...]; lit. 'Crown of the Palace') is...") - not
   journal material: drop every bracket in the FIRST sentence (nesting-aware), and any IPA later on */
function cleanWiki(text) {
  let t = text.replace(/\s*\[[^\]]*[ˈˌːɔəɪʊʃʒθðŋæɑɛɒʌɜɐɾɫ̪ˠ][^\]]*\]/g, "");
  const end = (() => { const m = /[.!?](\s|$)/.exec(t.replace(/\([^()]*\)/g, m => " ".repeat(m.length))); return m ? m.index + 1 : t.length; })();
  let head = "", depth = 0;
  for (const ch of t.slice(0, end)) { if (ch === "(") depth++; else if (ch === ")") { if (depth) depth--; } else if (!depth) head += ch; }
  t = head + t.slice(end);
  return t.replace(/\s*\(\s*\)/g, "").replace(/\s+([,.;:])/g, "$1").replace(/[ 	]{2,}/g, " ").trim();
}
const firstSentences = (text, n) => { const parts = text.replace(/\n+/g, " ").match(/[^.!?]+[.!?]+(\s|$)/g) || [text]; return parts.slice(0, n).join("").trim(); };
function infoPicker(initial, near, onInsert) {
  const w = document.createElement("div"); w.className = "imgbar"; w.style.display = "block"; w.style.maxHeight = "70vh"; w.style.overflow = "auto";
  w.innerHTML = `<div style="color:var(--gold);margin-bottom:6px">Add a paragraph about…</div>
    <div class="row" style="flex-wrap:nowrap"><input id="iq" placeholder="a place, castle, loch, museum…"><button class="sm" id="igo">Search</button></div>
    <div id="ires" style="margin-top:6px"></div>
    <div class="row" style="margin-top:8px;justify-content:flex-end"><button class="sm" id="ix">Cancel</button></div>`;
  document.body.appendChild(w);
  const q = w.querySelector("#iq"), res = w.querySelector("#ires");
  q.value = initial || "";
  w.querySelector("#ix").onclick = () => w.remove();
  const show = async title => {
    res.innerHTML = `<div class="hint">Loading “${esc(title)}”…</div>`;
    let full = ""; try { full = await wikiExtract(title); } catch { res.innerHTML = `<div class="hint">Couldn't reach Wikipedia – are you online?</div>`; return; }
    if (!full) { res.innerHTML = `<div class="hint">No text for that article.</div>`; return; }
    const variants = { short: firstSentences(full, 3), long: firstSentences(full, 8) };
    let pick = "short";
    const draw = () => {
      res.innerHTML = `<div style="color:var(--gold);font-weight:600">${esc(title)}</div>
        <div class="row" style="margin:6px 0"><button class="sm ${pick === "short" ? "pri" : ""}" data-k="short">Short</button><button class="sm ${pick === "long" ? "pri" : ""}" data-k="long">Longer</button><div style="flex:1"></div><button class="sm" id="iback">‹ Results</button></div>
        <div style="background:var(--paper);color:var(--ink);border-radius:6px;padding:8px;font-size:14px;line-height:1.45">${esc(variants[pick])}</div>
        <div class="hint" style="margin-top:4px">From Wikipedia. You can edit it after it's inserted.</div>
        <div class="row" style="margin-top:8px;justify-content:flex-end"><button class="pri" id="iins">Insert</button></div>`;
      res.querySelectorAll("[data-k]").forEach(b => b.onclick = () => { pick = b.dataset.k; draw(); });
      res.querySelector("#iback").onclick = search;
      res.querySelector("#iins").onclick = () => { w.remove(); onInsert(variants[pick]); };
    };
    draw();
  };
  async function search() {
    const term = q.value.trim(); if (!term) { res.innerHTML = `<div class="hint">Type what to look up${near.length ? " (this day: " + esc(near.join(", ")) + ")" : ""}.</div>`; return; }
    res.innerHTML = `<div class="hint">Searching…</div>`;
    let hits = [], used = term, suggestion = "";
    try {
      ({ hits, used, suggestion } = await wikiSearchTolerant(term));
      // a short name ("the castle", "Loch Ness") near the day's place: try the place-qualified search too, put its hits first
      if (near.length && term.split(/\s+/).length <= 3) {
        const extra = await wikiSearch(used + " " + near[0]).catch(() => []);
        hits = [...extra.filter(h => !hits.some(x => x.title === h.title)).slice(0, 2), ...hits];
      }
      // 1o: best spelling match first - the exact title, then titles spelt most like what was typed
      // ("Dunnotar Castle" -> "Dunnottar Castle"), then Wikipedia's own order
      const closeness = h => Math.max(spellSim(h.title, term), spellSim(h.title, used));
      hits = hits.map((h, i) => [h, i, closeness(h)])
        .sort((a, b) => (b[2] >= 0.75) - (a[2] >= 0.75) || (a[2] >= 0.75 && b[2] >= 0.75 ? b[2] - a[2] : 0) || a[1] - b[1]).map(x => x[0]);
    } catch { res.innerHTML = `<div class="hint">Couldn't reach Wikipedia – are you online?</div>`; return; }
    if (!hits.length) { res.innerHTML = `<div class="hint">Nothing found for “${esc(term)}”.</div>`; return; }
    const corrected = used.toLowerCase() !== term.toLowerCase();
    const dym = !corrected && suggestion && suggestion.toLowerCase() !== term.toLowerCase();
    res.innerHTML = (corrected ? `<div class="hint" style="color:var(--gold)">No exact match for “${esc(term)}” – showing the closest spellings.</div>` : "")
      + (dym ? `<div class="hint">Did you mean <a href="#" id="idym" style="color:var(--gold)">${esc(suggestion)}</a>?</div>` : "")
      + `<div class="hint">Tap the right one:</div>` + hits.map((h, i) => `<div class="card" data-i="${i}" style="padding:8px;margin:4px 0;cursor:pointer"><div class="ttl" style="font-size:14px">${esc(h.title)}</div><div class="sub">${esc(h.snip.slice(0, 110))}…</div></div>`).join("");
    res.querySelectorAll("[data-i]").forEach(c => c.onclick = () => show(hits[+c.dataset.i].title));
    const d = res.querySelector("#idym"); if (d) d.onclick = e => { e.preventDefault(); q.value = suggestion; search(); };
  }
  w.querySelector("#igo").onclick = search;
  q.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); search(); } };
  if (initial) search(); else setTimeout(() => q.focus(), 50);
}
function mapPicker(onPick, onPath) {
  const w = document.createElement("div"); w.className = "imgbar"; w.style.display = "block";
  w.innerHTML = `<div style="color:var(--gold);margin-bottom:6px">Insert a map of…</div><div id="mp"></div>
    ${onPath ? `<div style="color:var(--gold);margin:10px 0 4px">…or the path I actually took (Google Timeline)</div>
    <div class="row" style="flex-wrap:nowrap;align-items:center"><span class="hint" style="margin:0">From</span><input type="time" id="mpFrom" style="width:auto">
      <span class="hint" style="margin:0">to</span><input type="time" id="mpTo" style="width:auto"><button class="sm pri" id="mpPath">🧭 Insert my path</button></div>
    <div class="hint">Leave the times blank for the whole day.</div>` : ""}
    <div class="row" style="margin-top:8px;justify-content:flex-end"><button class="sm" id="mpx">Cancel</button></div>`;
  document.body.appendChild(w);
  geoField(w.querySelector("#mp"), null, p => { w.remove(); onPick(p); });
  w.querySelector("#mpx").onclick = () => w.remove();
  if (onPath) w.querySelector("#mpPath").onclick = async () => { if (await onPath(w.querySelector("#mpFrom").value, w.querySelector("#mpTo").value)) w.remove(); };
  setTimeout(() => w.querySelector("input").focus(), 50);
}

/* ======================= A5 page layout ======================= */
const A5W = 148, A5H = 210, MM = 96 / 25.4;
function pageShell(cls, hdr, ftrLeft) {
  const p = document.createElement("div"); p.className = "page " + (cls || "");
  p.innerHTML = `<div class="hdr">${esc(hdr || "")}</div><div class="body"></div><div class="ftr"><span>${esc(ftrLeft || "")}</span><span class="pno"></span></div>`;
  return p;
}
/* segments for the whole-trip maps: flights on one map, ground travel grouped by country */
function tripMapGroups(t) {
  const flights = [], byCountry = new Map();
  for (const d of t.days) {
    if (!d.route?.coords?.length) continue;
    if (d.route.kind === "flight") { flights.push(d); continue; }
    const c = d.to?.country || d.from?.country || "Trip";
    if (!byCountry.has(c)) byCountry.set(c, []); byCountry.get(c).push(d);
  }
  const groups = [];
  if (flights.length) groups.push({ title: "Flights", days: flights });
  for (const [c, days] of byCountry) groups.push({ title: flights.length || byCountry.size > 1 ? "Travel in " + c : "Our route", days });
  return groups;
}
async function buildPages(t) {
  t.days.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const foot = [t.name, t.description].filter(Boolean).join(" — ");
  const specs = [];
  specs.push({ type: "cover" });
  const groups = tripMapGroups(t);
  for (let i = 0; i < groups.length; i += 2) specs.push({ type: "maps", groups: groups.slice(i, i + 2) });
  specs.push({ type: "index" });
  // paginate each day: blocks are measured in an off-screen A5 page
  const meas = pageShell("", "", ""); meas.style.cssText = "position:absolute;left:-9999px;top:0;" + fontVars(t);   // measure in the journal's font
  document.body.appendChild(meas); const mb = meas.querySelector(".body");
  for (const [i, d] of t.days.entries()) {
    const blocks = [];
    blocks.push({ kind: "head", html: dayHeadHtml(d, i, t) });
    if (d.route?.coords?.length || d.from || d.to) blocks.push({ kind: "map" });
    const tmp = document.createElement("div"); tmp.innerHTML = d.notes || "";
    /* 4f: the printed / shared pages copy the day screen's layout. Lines go onto the page exactly as they are in
       the notes - photos keep their own size and left / centre / right side - and the note lines on a page share
       one flow (blk notes is NOT flow-root any more), so photos sit beside and below each other just as in the
       editor. (4c-4e rearranged photo runs into a two-across grid; the user wants the page to match the editor.)
       Only blank lines at the very start or end are dropped, and repeated blank lines between text collapse. */
    const blank = n => n.nodeType === 1 && !n.querySelector("img,.nmap,iframe") && !n.textContent.replace(/ /g, " ").trim() && n.tagName !== "HR";
    const nodes = [...tmp.childNodes].filter(n => n.nodeType === 1 || n.textContent.trim());
    while (nodes.length && blank(nodes[0])) nodes.shift();
    while (nodes.length && blank(nodes[nodes.length - 1])) nodes.pop();
    nodes.forEach((n, k) => {
      if (blank(n) && k && blank(nodes[k - 1])) return;   // repeated blank lines
      blocks.push({ kind: "note", html: n.nodeType === 1 ? n.outerHTML : `<p>${esc(n.textContent)}</p>` });
    });
    let pageBlocks = [];
    const flush = () => { if (pageBlocks.length) specs.push({ type: "day", day: d, dayNo: i + 1, blocks: pageBlocks, cont: specs.some(s => s.type === "day" && s.day === d) }); pageBlocks = []; mb.innerHTML = ""; };
    mb.innerHTML = "";
    const overflow = () => mb.scrollHeight > mb.clientHeight + 1;
    const queue = blocks.slice();
    while (queue.length) {
      const b = queue.shift();
      const el = blockEl(b, d, true); mb.appendChild(el);
      await Promise.all([...el.querySelectorAll("img")].map(im => im.complete ? 0 : new Promise(r => { im.onload = im.onerror = r; })));
      if (overflow()) {
        el.remove();
        // a long paragraph: keep as many words as fit on this page, carry the rest over
        const parts = b.kind === "note" ? splitToFit(b, d, mb, overflow) : null;
        if (parts) { pageBlocks.push(parts[0]); flush(); queue.unshift(parts[1]); continue; }
        if (pageBlocks.length) { flush(); queue.unshift(b); continue; }
        mb.appendChild(blockEl(b, d, true));   // taller than a whole page on its own - place it anyway (clipped)
      }
      pageBlocks.push(b);
    }
    flush();
  }
  meas.remove();
  specs.push({ type: "collage" });
  specs.forEach((s, i) => s.no = i + 1);
  return { specs, foot };
}
/* split a notes block (paragraph/list item text + inline photos) at the last word that still fits */
function splitToFit(b, d, mb, overflow) {
  const tmp = document.createElement("div"); tmp.innerHTML = b.html;
  const root = tmp.firstElementChild; if (!root || /^(IMG|DIV)$/.test(root.tagName)) return null;
  // tokens: each word of each text node, or a whole element (photo, bold run...)
  const tokens = [];
  for (const n of [...root.childNodes]) {
    if (n.nodeType === 3) n.textContent.split(/(?<=\s)/).forEach(w => w && tokens.push(w));
    else tokens.push(n.outerHTML);
  }
  if (tokens.length < 2) return null;
  const shell = (from, to) => { const c = root.cloneNode(false); c.innerHTML = tokens.slice(from, to).map(t => t.startsWith("<") ? t : esc(t)).join(""); return c.outerHTML; };
  let lo = 0, hi = tokens.length;                 // largest k whose first-k tokens fit
  while (lo < hi) {
    const k = Math.ceil((lo + hi) / 2);
    const el = blockEl({ kind: "note", html: shell(0, k) }, d, true); mb.appendChild(el);
    const bad = overflow(); el.remove();
    if (bad) hi = k - 1; else lo = k;
  }
  if (lo === 0) return null;
  return [{ kind: "note", html: shell(0, lo) }, { kind: "note", html: shell(lo, tokens.length) }];
}
function dayHeadHtml(d, i, t) {
  const route = [d.from?.name, d.to?.name].filter(Boolean).join(" → ");
  const w = d.weather ? (d.weather.text || `${d.weather.min}–${d.weather.max}°C · ${d.weather.summary || ""}`) : "";
  const home = t?.homeCur || guessHome(), spent = t?.showSpend && spendOf(d).length ? moneySum(spendOf(d), home, fxCached(home)) : "";
  const facts = [["Travel", route], ["Weather", w], ["Stay", [d.motel, d.room && "room " + d.room].filter(Boolean).join(", ")], ["Room", d.roomDesc], ["Highlight", d.highlight], ["Spent", spent]].filter(f => f[1]);
  const km = routeKm(d.route);
  return `<div class="dtitle">Day ${i + 1}${d.title ? " · " + esc(d.title) : ""}</div><div class="dmeta">${fmtDate(d.date)}${km ? " · " + nf(km) + " km" : ""}${d.rating ? ` · <span class="pstars">${stars(d.rating)}</span>` : ""}</div>
    ${facts.length ? `<div class="facts">${facts.map(f => `<b>${f[0]}</b><span>${esc(f[1])}</span>`).join("")}</div>` : ""}`;
}
function blockEl(b, d, measuring) {
  const el = document.createElement("div"); el.className = "blk";
  if (b.kind === "head") el.innerHTML = b.html;
  else if (b.kind === "map") { el.innerHTML = `<div class="mapframe dmapf"></div>`; }
  else { el.className = "blk notes"; el.innerHTML = b.html; el.querySelectorAll("img[data-pid]").forEach(im => { if (photoUrls[im.dataset.pid]) im.src = photoUrls[im.dataset.pid]; }); el.querySelectorAll(".nmap").forEach(m => { sizeNoteMap(m, +m.dataset.w || 100); alignNoteMap(m, m.dataset.al || "center"); }); }
  return el;
}
async function renderPage(spec, t, ctx) {
  const d = spec.day;
  const hdr = spec.type === "day" ? `${fmtDate(d.date)}${d.title ? " · " + d.title : ""}${spec.cont ? " (continued)" : ""}` : t.name;
  const p = pageShell(spec.type === "cover" ? "cover" : spec.type === "blank" ? "blankpage" : "", spec.type === "cover" || spec.type === "blank" ? "" : hdr, spec.type === "cover" || spec.type === "blank" ? "" : ctx.foot);
  const body = p.querySelector(".body");
  if (spec.no && spec.type !== "cover" && spec.type !== "blank") p.querySelector(".pno").textContent = spec.no;
  const after = [];
  if (spec.type === "cover") {
    const n = t.cover.length, cols = n <= 1 ? 1 : n <= 4 ? 2 : 3, rows = Math.ceil(n / cols) || 1;
    body.innerHTML = `<div class="ctitle">${esc(t.name)}</div><div class="cdesc">${esc(t.description || "")}</div><div class="cdates">${fmtDate(t.start)}${t.end ? " – " + fmtDate(t.end) : ""}</div>
      <div class="cphotos" style="grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},${Math.min(80, 120 / rows)}mm)"></div>`;
    for (const pid of t.cover) { const im = document.createElement("img"); im.src = await photoURL(pid); body.querySelector(".cphotos").appendChild(im); }
  } else if (spec.type === "maps") {
    const h = spec.groups.length === 1 ? 170 : 84;
    body.innerHTML = spec.groups.map((g, i) => `<div class="ptitle">${esc(g.title)}</div><div class="mapframe" data-g="${i}" style="height:${h}mm;margin-bottom:3mm"></div>`).join("");
    spec.groups.forEach((g, i) => after.push(() => drawMap(body.querySelector(`[data-g="${i}"]`), {
      routes: g.days.map(d => ({ kind: d.route.kind, coords: d.route.coords })),
      points: g.days.flatMap(d => [d.from, d.to]).filter(Boolean).filter((x, j, a) => a.findIndex(y => y.name === x.name) === j).map(x => ({ ...x, label: true })), interactive: ctx.interactive })));
    if (!spec.groups.length) body.innerHTML = `<div class="ptitle">Trip map</div><div class="hint" style="color:#999">Build a travel map on each day and the whole trip is drawn here.</div>`;
  } else if (spec.type === "index") {
    const firstPage = new Map(); ctx.specs.forEach(s => { if (s.type === "day" && !firstPage.has(s.day)) firstPage.set(s.day, s.no); });
    body.innerHTML = `<div class="ptitle">Contents</div><div class="idx">${t.days.map((d, i) => `<div><span class="d">${shortDate(d.date)}</span><span class="t">Day ${i + 1}${d.title ? " · " + esc(d.title) : ""}</span><span class="p">${firstPage.get(d) || ""}</span></div>`).join("")}
      <div><span class="d"></span><span class="t">Photo collage</span><span class="p">${ctx.specs.find(s => s.type === "collage")?.no || ""}</span></div></div>
      ${t.days.length ? `<div class="tnum"><b>Trip in numbers</b><br>${esc(statLine(tripStats(t)))}</div>` : ""}`;
  } else if (spec.type === "day") {
    for (const b of spec.blocks) {
      const el = blockEl(b, d, false); body.appendChild(el);
      if (b.kind === "map") { const f = el.querySelector(".dmapf"); after.push(() => drawMap(f, { routes: dayRoutes(d), points: dayPoints(d), view: d.mapView, interactive: ctx.interactive })); }
      if (b.kind === "note") after.push(() => hydrate(el, false));
    }
  } else if (spec.type === "collage") {
    const ids = [...t.cover, ...t.days.flatMap(d => [...(d.notes || "").matchAll(/data-pid="([^"]+)"/g)].map(m => m[1]))].filter((x, i, a) => a.indexOf(x) === i);
    const n = ids.length, cols = n <= 4 ? 2 : n <= 9 ? 3 : n <= 20 ? 4 : 5, rows = Math.max(1, Math.ceil(n / cols));
    body.innerHTML = `<div class="ptitle">Photo collage</div><div class="collage" style="grid-template-columns:repeat(${cols},1fr);grid-auto-rows:${Math.min(60, 176 / rows)}mm"></div>`;
    for (const pid of ids.slice(0, 60)) { const im = document.createElement("img"); im.src = await photoURL(pid); body.querySelector(".collage").appendChild(im); }
    if (!n) body.querySelector(".collage").outerHTML = `<div class="hint" style="color:#999">Photos from the trip appear here.</div>`;
  } else body.textContent = "";
  return { el: p, after };
}

/* booklet order: pad to a multiple of 4 (blanks go before the collage so it stays on the back),
   sheet s: front = [N-2s, 2s+1], back = [2s+2, N-2s-1]  (1-based page numbers) */
function bookletSheets(specs) {
  const list = specs.slice(); const col = list.pop();
  while ((list.length + 1) % 4) list.push({ type: "blank" });
  list.push(col); const N = list.length, sheets = [];
  for (let s = 0; s < N / 4; s++) sheets.push({ front: [list[N - 1 - 2 * s], list[2 * s]], back: [list[2 * s + 1], list[N - 2 - 2 * s]] });
  return sheets;
}

views.layout = async (tripId, mode = "pages", dayId = "") => {
  const t = await getTrip(tripId); if (!t) return go("home");
  await leafletReady().catch(e => toast(e.message, 4000));
  // 2g: one day only (from the day screen's "Share this day"): its A5 pages, Share box already open
  const dayIdx = dayId ? [...t.days].sort((a, b) => (a.date || "").localeCompare(b.date || "")).findIndex(d => d.id === dayId) : -1;
  const oneDay = dayIdx >= 0 ? t.days.find(d => d.id === dayId) : null;
  if (oneDay) mode = "pages";
  for (const pid of [...t.cover, ...t.days.flatMap(d => [...(d.notes || "").matchAll(/data-pid="([^"]+)"/g)].map(m => m[1]))]) await photoURL(pid);
  main.innerHTML = `<div class="noprint">
      <div class="row"><button class="sm" id="back">‹ ${esc(oneDay ? "Day " + (dayIdx + 1) : t.name)}</button></div>
      <h2>${oneDay ? `Share Day ${dayIdx + 1}${oneDay.title ? " · " + esc(oneDay.title) : ""}` : "Pages"}</h2>
      <div class="row"${oneDay ? ' style="display:none"' : ""}><select id="mode" style="flex:1">
        <option value="pages">A5 pages, in order (print on A5 paper)</option>
        <option value="duplex">A4 booklet – double-sided (flip on short edge)</option>
        <option value="single">A4 booklet – single-sided (all fronts, then all backs)</option></select>
        <button class="pri" id="print">Print</button><button class="pri" id="share">Share</button></div>
      <p class="hint" id="modehint"></p>
      <div class="card" id="sharebox" style="display:${oneDay ? "block" : "none"}">
        <div class="hint" style="margin-bottom:6px">Share these pages with Facebook Messenger, WhatsApp, email…</div>
        <div class="row"><button class="sm" id="sharePics">As pictures (best for Messenger)</button><button class="sm" id="sharePdf">As a PDF (for printing)</button></div>
        <p class="hint" id="shareMsg"></p>
        <div class="row"><button class="pri" id="shareNow" style="display:none">Share now</button></div></div></div>
    <div class="pages" id="pages" style="${esc(fontVars(t))}"><div class="hint">Laying out pages…</div></div>`;
  $("#mode").value = mode;
  $("#back").onclick = () => oneDay ? go("day", tripId, dayId) : go("trip", tripId);
  $("#mode").onchange = () => go("layout", tripId, $("#mode").value);
  $("#print").onclick = async () => { const b = $("#print"); b.disabled = true; b.textContent = "Drawing the maps…"; try { await layoutDrawAll?.(); } finally { b.disabled = false; b.textContent = "Print"; } window.print(); };
  $("#share").onclick = () => { const b = $("#sharebox"); b.style.display = b.style.display === "none" ? "block" : "none"; };
  const shareName = oneDay ? `${t.name} - Day ${dayIdx + 1}${oneDay.title ? " - " + oneDay.title : ""}` : t.name;
  $("#sharePics").onclick = () => prepareShare(t, mode, "pics", shareName);
  $("#sharePdf").onclick = () => prepareShare(t, mode, "pdf", shareName);
  const hints = { pages: "Each page is A5 (148 × 210 mm). Print at 100% / actual size.",
    duplex: "Two A5 pages per A4 landscape sheet, in booklet order. Print double-sided, flip on SHORT edge, then fold the stack in half.",
    single: "Two A5 pages per A4 sheet. Print the FRONTS, put the stack back in the tray (turned over as your printer needs), then print the BACKS. Fold in half." };
  $("#modehint").textContent = hints[mode];
  let { specs, foot } = await buildPages(t);
  if (oneDay) specs = specs.filter(sp => sp.type === "day" && sp.day.id === dayId);   // 2g: just this day (page numbers stay as in the full journal)
  const ctx = { specs, foot, interactive: false };   // print view: maps fixed, no drag/zoom buttons (1i)
  const box = $("#pages"); box.innerHTML = "";
  const st = document.createElement("style"); st.id = "pagestyle";
  st.textContent = mode === "pages" ? "@page{size:148mm 210mm;margin:0}" : "@page{size:297mm 210mm;margin:0}";
  document.head.appendChild(st);
  const avail = Math.min(box.clientWidth || innerWidth, innerWidth) - 8;
  const place = (el, wmm) => { const w = wmm * MM, k = Math.min(1, avail / w); const wrap = document.createElement("div"); wrap.className = "pagewrap";
    const sb = document.createElement("div"); sb.className = "scalebox"; sb.style.transform = `scale(${k})`; sb.style.height = (A5H * MM * k) + "px"; sb.style.width = w + "px";
    sb.appendChild(el); wrap.appendChild(sb); box.appendChild(wrap); return wrap; };
  /* 4a: each page's maps are drawn when it scrolls near the screen - a long trip used to draw 40+ maps (and
     fetch all their tiles) at once. Print / Share draw any that are left first (layoutDrawAll). */
  const jobs = [], later = (wrap, fns) => { if (fns.length) jobs.push({ wrap, fns, done: null }); };
  if (mode === "pages") {
    for (const s of specs) { const r = await renderPage(s, t, ctx); later(place(r.el, A5W), r.after); }
  } else {
    const sheets = bookletSheets(specs);
    const sides = mode === "duplex" ? sheets.flatMap(s => [s.front, s.back]) : [...sheets.map(s => s.front), ...sheets.map(s => s.back)];
    for (const side of sides) { const sh = document.createElement("div"); sh.className = "sheet", fns = [];
      for (const s of side) { const r = await renderPage(s, t, ctx); sh.appendChild(r.el); fns.push(...r.after); }
      later(place(sh, 297), fns); }
  }
  const runJob = j => j.done ||= (async () => { for (const f of j.fns) await f(); })();
  const io = "IntersectionObserver" in window ? new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return; io.unobserve(e.target); const j = jobs.find(x => x.wrap === e.target); if (j) runJob(j); }), { rootMargin: "800px 0px" }) : null;
  if (io) jobs.forEach(j => io.observe(j.wrap)); else for (const j of jobs) await runJob(j);
  layoutDrawAll = async () => { io?.disconnect(); for (const j of jobs) await runJob(j); await tilesSettled(box); };
};
/* until the map pictures on the pages have arrived (or 8 s) */
const tilesSettled = (root, ms = 8000) => new Promise(res => { const t0 = Date.now();
  (function chk() { if (![...root.querySelectorAll("img.leaflet-tile")].some(i => !i.complete) || Date.now() - t0 > ms) return res(); setTimeout(chk, 200); })(); });

/* ======================= share the print version (1p) =======================
   The pages on screen are drawn to JPEGs (html2canvas) and handed to the phone's share sheet
   (Messenger, WhatsApp, email…) as pictures or as one PDF (jsPDF). Both libraries load only
   when first used and are then cached by the service worker, like Leaflet.
   Sharing is a second tap ("Share now"): Android only opens the share sheet straight after a tap,
   and drawing a long trip takes longer than that allows. */
const loadScript = src => new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)) return res();
  const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("couldn't load " + src.split("/")[4] + " - are you online?")); document.head.appendChild(s); });
async function prepareShare(t, mode, kind, title = t.name) {
  const msg = $("#shareMsg"), now = $("#shareNow"), btns = [$("#sharePics"), $("#sharePdf"), $("#print"), $("#share")];
  now.style.display = "none"; btns.forEach(b => b.disabled = true);
  try {
    msg.textContent = "Drawing the maps…";
    await layoutDrawAll?.();
    msg.textContent = "Getting ready…";
    await loadScript("https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js");
    if (kind === "pdf") await loadScript("https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js");
    const els = [...document.querySelectorAll(mode === "pages" ? "#pages .page" : "#pages .sheet")];
    const name = (title || "trip").replace(/[^\w\- ]+/g, "").trim() || "trip", jpgs = [];
    for (let i = 0; i < els.length; i++) {
      msg.textContent = `Drawing page ${i + 1} of ${els.length}…`;
      const c = await html2canvas(els[i], { scale: 2, useCORS: true, backgroundColor: "#ffffff", logging: false, windowWidth: 1200,
        onclone: doc => {   // draw at full size, without shadows (html2canvas paints them as grey boxes)
          doc.querySelectorAll(".scalebox").forEach(b => { b.style.transform = "none"; b.style.height = "auto"; });
          const st = doc.createElement("style"); st.textContent = "*{box-shadow:none !important}"; doc.head.appendChild(st); } });
      jpgs.push(await new Promise(r => c.toBlob(r, "image/jpeg", 0.85)));
    }
    let files;
    if (kind === "pdf") {
      msg.textContent = "Making the PDF…";
      const wmm = mode === "pages" ? A5W : 297, pdf = new jspdf.jsPDF({ unit: "mm", format: [wmm, A5H].sort((a, b) => a - b), orientation: mode === "pages" ? "portrait" : "landscape" });
      for (let i = 0; i < jpgs.length; i++) { if (i) pdf.addPage(); pdf.addImage(new Uint8Array(await jpgs[i].arrayBuffer()), "JPEG", 0, 0, wmm, A5H); }
      files = [new File([pdf.output("blob")], name + ".pdf", { type: "application/pdf" })];
    } else files = jpgs.map((b, i) => new File([b], `${name} - page ${String(i + 1).padStart(2, "0")}.jpg`, { type: "image/jpeg" }));
    const what = kind === "pdf" ? "the PDF" : `${files.length} picture${files.length > 1 ? "s" : ""}`;
    /* 1w: Chrome on Android refuses more than 10 files (or ~50 MB) in one share ("Permission denied"),
       so pictures go in batches of up to 10 / 40 MB - one tap per batch */
    const batches = [];
    for (const f of files) { const b = batches[batches.length - 1];
      if (b && b.length < 10 && b.reduce((n, x) => n + x.size, 0) + f.size < 40e6) b.push(f); else batches.push([f]); }
    if (navigator.canShare?.({ files: batches[0] })) {
      let i = 0, start = 1;
      const label = () => { const b = batches[i], end = start + b.length - 1;
        return kind === "pdf" ? "Share now (the PDF)" : batches.length === 1 ? `Share now (${what})` : `Share pictures ${start}–${end} of ${files.length}`; };
      msg.textContent = batches.length === 1 ? `Ready: ${what}. Tap Share now, then pick Messenger.`
        : `Ready: ${what}. Messenger takes up to 10 at a time, so they go in ${batches.length} lots - tap the button, pick Messenger, then come back and tap it again.`;
      now.textContent = label(); now.style.display = "";
      now.onclick = () => navigator.share({ files: batches[i], title: t.name }).then(() => {
        start += batches[i].length; i++;
        if (i < batches.length) { now.textContent = label(); msg.textContent = `Sent ${start - 1} of ${files.length}. Tap the button for the next lot.`; }
        else { now.textContent = batches.length === 1 ? label() : "Share all again"; msg.textContent = `All ${what} shared.`; i = 0; start = 1; }
      }).catch(e => { if (e.name !== "AbortError") toast("Share failed: " + e.message, 3500); });
    } else {   // no share sheet (e.g. desktop browser): save the files instead
      msg.textContent = `This browser can't share files, so ${what} ${kind === "pdf" ? "was" : "were"} saved to Downloads - send ${kind === "pdf" ? "it" : "them"} from there.`;
      for (const f of files) { const a = document.createElement("a"); a.href = URL.createObjectURL(f); a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
    }
  } catch (e) { msg.textContent = "Couldn't prepare the pages: " + e.message; }
  btns.forEach(b => b.disabled = false);
}

/* ======================= backup ======================= */
/* 1v: what goes to other people - without the raw Google Timeline (the whole location history, often
   100 000s of points); each day's map keeps its own route, so nothing visible is lost */
/* 4a: shared copies also leave out the spending and the packing list (yours, not for the people you share with) */
const sharedCopy = t => ({ ...t, timeline: null, _tlStored: undefined, packing: undefined, homeCur: undefined, showSpend: undefined, lastCur: undefined,
  days: t.days.map(d => d.spend ? { ...d, spend: undefined } : d) });
/* 4a: built in pieces - the same file as before, but no longer one giant string of every photo in memory
   (a trip with a few hundred photos could run the phone out of memory) */
async function backupBlob(t) {
  const trip = { ...t }; delete trip._tlStored;
  const parts = ['{"app":"DSR Travel Journal","version":1,"trip":', JSON.stringify(trip), ',"photos":{'];
  let first = true;
  for (const id of photoIdsOf(t)) {
    const b = await getPhoto(id); if (!b) continue;
    const url = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
    parts.push((first ? "" : ",") + JSON.stringify(id) + ":" + JSON.stringify(url)); first = false;
  }
  parts.push("}}");
  return new Blob(parts, { type: "application/json" });
}
const backupName = t => (t.name || "trip").replace(/[^\w\- ]+/g, "").trim() || "trip";
async function exportTrip(t) {
  await ensureTL(t);   // your own backup keeps the Google Timeline
  const blob = await backupBlob(t);
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = backupName(t) + ".dsrtrip.json"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
/* 1q: the whole trip to the share sheet (Messenger, WhatsApp, email…). Android only lets a web app share
   a few file types, and Messenger silently dropped the .txt that 1p sent - so the trip goes as a PDF:
   one readable page ("open this in DSR Travel Journal") with the backup JSON inside it as a data stream.
   Import backup finds the JSON in the PDF (and still reads .json / .txt backups).
   If packing the photos takes too long for Android's "straight after a tap" rule, the button
   turns into "Share now" for a second tap. */
const PDF_MARK = "/DSRTrip true >>";
function tripPdf(t, json) {
  const txt = s => String(s ?? "").replace(/[^\x20-\x7e]/g, c => ({ "–": "-", "—": "-", "‘": "'", "’": "'", "“": '"', "”": '"', "é": "e", "è": "e", "à": "a", "ü": "u", "ö": "o" })[c] || "?").replace(/[\\()]/g, "\\$&");
  const photos = new Set([...t.cover, ...t.days.flatMap(d => [...(d.notes || "").matchAll(/data-pid="([^"]+)"/g)].map(m => m[1]))]).size;
  const lines = [[18, t.name || "Trip"], [10, fmtDate(t.start) + (t.end ? " - " + fmtDate(t.end) : "")], [10, ""],
    [10, `A DSR Travel Journal trip: ${t.days.length} day${t.days.length === 1 ? "" : "s"}, ${photos} photo${photos === 1 ? "" : "s"}.`], [10, ""],
    [10, "To open it: tap the menu (3 dots) > Send file... (or Share)"], [10, "and pick DSR Travel Journal (the app must be installed - see the link below)."], [10, ""],
    [10, "Or tap Download, then in DSR Travel Journal tap Open a shared trip"], [10, "on the home screen and pick this file (it's in Downloads)."], [10, ""],
    [9, "Get the app: " + location.origin + location.pathname]];
  let y = 540; const content = lines.map(([sz, l]) => { const r = `BT /F1 ${sz} Tf 40 ${y} Td (${txt(l)}) Tj ET\n`; y -= sz + 8; return r; }).join("");
  const parts = [], offs = []; let pos = 0;
  const add = x => { parts.push(x); pos += typeof x === "string" ? x.length : x.size; };
  const obj = (n, body) => { offs[n] = pos; add(`${n} 0 obj\n${body}\nendobj\n`); };
  add("%PDF-1.4\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 595] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>");
  obj(4, `<< /Length ${content.length} >>\nstream\n${content}endstream`);
  obj(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  offs[6] = pos; add(`6 0 obj\n<< /Length ${json.size} ${PDF_MARK}\nstream\n`); add(json); add("\nendstream\nendobj\n");
  const xref = pos;
  add(`xref\n0 7\n0000000000 65535 f \n${offs.slice(1).map(o => String(o).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: "application/pdf" });
}
async function shareTrip(t, btn) {
  const label = btn.textContent; btn.disabled = true; btn.textContent = "Packing the trip…";
  try {
    const file = new File([tripPdf(t, await backupBlob(sharedCopy(t)))], backupName(t) + " - DSR trip.pdf", { type: "application/pdf" });
    const mb = (file.size / 1048576).toFixed(1);
    if (!navigator.canShare?.({ files: [file] })) { btn.textContent = label; btn.disabled = false; toast("This browser can't share files - saving it instead; send it from Downloads", 4000); return exportTrip(t); }
    const send = () => navigator.share({ files: [file], title: t.name }).then(() => { btn.textContent = label; btn.onclick = () => shareTrip(t, btn); })
      .catch(e => { if (e.name === "NotAllowedError") { btn.textContent = `Share now (${mb} MB)`; btn.onclick = send; }
        else if (e.name !== "AbortError") toast("Share failed: " + e.message + (file.size > 25 * 1048576 ? ` - the file is ${mb} MB, which may be too big for Messenger` : ""), 5000); });
    btn.disabled = false; btn.textContent = label;
    if (file.size > 25 * 1048576) toast(`This trip is ${mb} MB - Messenger may refuse files that big; email or Google Drive will work`, 5000);
    await send();
  } catch (e) { btn.disabled = false; btn.textContent = label; toast("Couldn't pack the trip: " + e.message, 4000); }
}
async function importBackup() {
  const [f] = await pickFiles($("#jsonPick"), false); if (f) await importBackupFile(f);
}
/* 3b: photos shared in - from DSR Day Photos (📅 Day's photos) or Gallery › Share. They go into the day that asked
   for them (DAYPICK_KEY, set by 📅 Day's photos, good for an hour); otherwise you choose the trip and day. */
const DAYPICK_KEY = "dsr-travel-daypick";
let pendingDayPhotos = null;
views.sharedphotos = async () => {
  main.innerHTML = `<div class="hint">Bringing in the photos…</div>`;
  const c = await caches.open("dsr-travel-shared"), n = +(await (await c.match("./shared-photo-count"))?.text() || 0), files = [];
  for (let i = 0; i < n; i++) { const r = await c.match("./shared-photo-" + i); if (r) files.push(new File([await r.blob()], decodeURIComponent(r.headers.get("X-Name") || "") || `photo-${i + 1}.jpg`, { type: r.headers.get("Content-Type") || "image/jpeg" })); }
  for (const k of await c.keys()) if (/shared-photo-/.test(k.url)) await c.delete(k);
  history.replaceState(null, "", location.pathname);
  if (!files.length) return render();
  return photosArrived(files);
};
/* 3d: DSR Day Photos' other route - when this installed app can't take shared photos (Chrome refreshes an installed
   app's share settings only every day or so), it leaves them on dsr-move-relay under a one-time code and opens
   #dayphotosin/<code>. Collect them, delete them from the relay, then the same as a share. */
const RELAY = "https://dsr-move-relay.100dsr100.workers.dev/p/";
views.dayphotosin = async code => {
  history.replaceState(null, "", location.pathname);
  if (!/^[0-9a-f]{32}$/.test(code || "")) return render();
  main.innerHTML = `<div class="hint" id="dpin">Collecting the photos…</div>`;
  const get = async (k, bin) => { for (let i = 0; i < 8; i++) { try { const r = await fetch(RELAY + code + "/" + k, { cache: "no-store" }); if (r.ok) return bin ? r.arrayBuffer() : r.text(); } catch (e) {} await new Promise(r => setTimeout(r, 1500)); } throw new Error("they weren't there (they're kept for an hour) - add them again from DSR Day Photos"); };
  try {
    const meta = JSON.parse(await get("meta")), files = [];
    for (let i = 0; i < meta.parts; i++) {
      $("#dpin").textContent = `Collecting the photos… ${i + 1} of ${meta.parts}`;
      let a;
      if (meta.bin) a = new Uint8Array(await get(i, true));   // 3e: Day Photos 1c sends the JPEG itself
      else { const b64 = await get(i), bin = atob(b64); a = new Uint8Array(bin.length); for (let j = 0; j < bin.length; j++) a[j] = bin.charCodeAt(j); }
      files.push(new File([a], (meta.names && meta.names[i]) || `photo-${i + 1}.jpg`, { type: "image/jpeg" }));
    }
    fetch(RELAY + code, { method: "DELETE" }).catch(() => {});
    return photosArrived(files);
  } catch (e) { main.innerHTML = `<div class="card">Couldn't collect the photos: ${esc(e.message)}</div><button onclick="location.hash=''">Home</button>`; }
};
async function photosArrived(files) {
  let want = null; try { want = JSON.parse(localStorage.getItem(DAYPICK_KEY) || "null"); } catch (e) {}
  localStorage.removeItem(DAYPICK_KEY);
  const t = want && Date.now() - want.at < 3600000 ? await getTrip(want.trip) : null;
  if (t && t.days.some(x => x.id === want.day)) { pendingDayPhotos = { day: want.day, files }; return go("day", t.id, want.day); }
  /* no day asked for them: choose one */
  const trips = (await allTrips()).sort((a, b) => (b.start || "").localeCompare(a.start || ""));
  main.innerHTML = `<h2>${files.length} photo${files.length > 1 ? "s" : ""} to add</h2><div class="hint">Choose the day they go in.</div><div id="spl"></div><div class="row" style="margin-top:10px"><button class="sm" onclick="location.hash=''">Cancel</button></div>`;
  const box = $("#spl");
  for (const tr of trips) {
    const h = document.createElement("h3"); h.textContent = tr.name; box.appendChild(h);
    for (const dy of tr.days) {
      const b = document.createElement("button"); b.className = "sm"; b.style.cssText = "display:block;width:100%;text-align:left;margin:4px 0";
      b.textContent = (dy.date ? fmtDate(dy.date) + " – " : "") + (dy.title || "Day");
      b.onclick = () => { pendingDayPhotos = { day: dy.id, files }; go("day", tr.id, dy.id); };
      box.appendChild(b);
    }
  }
};

/* 1r: a file shared to the app (Messenger › Share › DSR Travel Journal) - the service worker
   parks it in a cache and opens #shared */
views.shared = async () => {
  main.innerHTML = `<div class="hint">Opening the shared trip…</div>`;
  const c = await caches.open("dsr-travel-shared"), r = await c.match("./shared-file");
  await c.delete("./shared-file");
  history.replaceState(null, "", location.pathname);
  if (!r) return render();
  await importBackupFile(new File([await r.blob()], decodeURIComponent(r.headers.get("X-Name") || "") || "shared trip"));
  render();
};
async function importBackupFile(f) {
  try {
    let text = await f.text();
    if (text.startsWith("%PDF")) {   // 1q: a shared trip - the backup JSON sits inside the PDF
      const i = text.indexOf(PDF_MARK + "\nstream\n"), e = text.lastIndexOf("\nendstream");
      if (i < 0 || e < i) throw new Error("that PDF isn't a shared DSR trip (use the Share whole trip file, not the printed pages)");
      text = text.slice(i + PDF_MARK.length + 8, e);
    }
    const j = JSON.parse(text); if (!j.trip) throw new Error("not a DSR Travel Journal backup");
    if (!await saveImportedTrip(j.trip, Object.entries(j.photos || {}).map(([id, url]) => [id, async () => (await fetch(url)).blob()]))) return;
    render();
  } catch (e) { toast("Import failed: " + e.message, 3500); }
}
/* photos: [[id, async () => blob], …]; false if the person kept the copy they already had */
async function saveImportedTrip(trip, photos) {
  if (await getTrip(trip.id) && !confirm(`“${trip.name}” is already here – replace it with this copy?`)) return false;
  for (const [id, get] of photos) await putPhoto(id, await get());
  await putTrip(trip); toast("Imported " + trip.name, 3500); return true;
}

/* ======================= share as a link (1u) =======================
   The sender's GitHub repo (e.g. DSRTrips, public, GitHub Pages on) gets trips/<shareId>/trip.json plus
   one .jpg per photo, in one commit through the GitHub API, using a fine-grained key that can only
   write to that repo. It is served on the same github.io origin as this app, so the link
   (…/DSRTravelJournal/#get/<repo>/<shareId>) just fetches it - the receiver needs no key.
   The key and repo live only on the sender's device (localStorage). */
const GH_KEY = "dsr-travel-github";
const ghConf = () => { try { return JSON.parse(localStorage.getItem(GH_KEY)) || null; } catch { return null; } };
async function gh(conf, path, opt = {}) {
  const r = await fetch("https://api.github.com/repos/" + conf.repo + path, { ...opt, cache: "no-store",
    headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + conf.token, ...(opt.body ? { "Content-Type": "application/json" } : {}) } });
  if (r.status === 404 && opt.ok404) return null;
  if (!r.ok) { let m = ""; try { m = (await r.json()).message; } catch {}
    const reading = (opt.method || "GET") === "GET";
    throw new Error(r.status === 401 ? "GitHub didn't accept the key - it may be mistyped, deleted or expired. Tap change key and paste it again."
      : path === "" && r.status === 404 ? `the key can't see ${conf.repo}. On GitHub open the key and check Repository access lists DSRTrips (Only select repositories).`
      : !reading && (r.status === 403 || r.status === 404) ? `the key can see ${conf.repo} but may not write to it. On GitHub open the key and set Repository permissions › Contents to Read and write.`
      : `GitHub said ${r.status}${m ? " (" + m + ")" : ""} at ${(opt.method || "GET") + " " + (path || "/")}`); }
  return r.status === 204 ? null : r.json();
}
const b64 = blob => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result.slice(fr.result.indexOf(",") + 1)); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
async function gitSha(blob) {   // git's blob id, to skip photos that are already uploaded
  const head = new TextEncoder().encode(`blob ${blob.size}\0`), body = new Uint8Array(await blob.arrayBuffer()), all = new Uint8Array(head.length + body.length);
  all.set(head); all.set(body, head.length);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", all))].map(b => b.toString(16).padStart(2, "0")).join("");
}
/* 2e: the link carries the share's version (…/<id>/<ver>) so the receiver can tell GitHub is still
   publishing a newer copy, instead of silently opening the previous one */
const shareUrl = (conf, id, ver) => location.origin + location.pathname.replace(/[^/]*$/, "") + "#get/" + conf.repo.split("/")[1] + "/" + id + (ver ? "/" + ver : "");
async function publishTrip(t, conf, say) {
  if (!t.shareId) { t.shareId = uid() + uid(); await putTrip(t); }
  const dir = "trips/" + t.shareId, ids = [...new Set([...t.cover, ...t.days.flatMap(d => [...(d.notes || "").matchAll(/data-pid="([^"]+)"/g)].map(m => m[1]))])];
  say("Connecting to GitHub…");
  const repo = await gh(conf, "");
  const branch = repo.default_branch || "main";
  let ref = await gh(conf, "/git/ref/heads/" + branch, { ok404: true }).catch(e => { if (/409/.test(e.message)) return null; throw e; });
  if (!ref) {   // brand-new empty repo: git needs one first commit
    await gh(conf, "/contents/README.md", { method: "PUT", body: JSON.stringify({ message: "Start DSR trips", content: btoa("Trips shared from DSR Travel Journal.\n") }) });
    ref = await gh(conf, "/git/ref/heads/" + branch);
  }
  const old = new Map(((await gh(conf, "/contents/" + dir, { ok404: true })) || []).map(f => [f.name, f.sha]));
  const tree = [], keep = new Set(["trip.json", "index.html"]);
  for (let i = 0; i < ids.length; i++) {
    const b = await getPhoto(ids[i]); if (!b) continue;
    const name = ids[i] + ".jpg", sha = await gitSha(b); keep.add(name);
    if (old.get(name) === sha) continue;
    say(`Uploading photo ${i + 1} of ${ids.length}…`);
    const blob = await gh(conf, "/git/blobs", { method: "POST", body: JSON.stringify({ content: await b64(b), encoding: "base64" }) });
    tree.push({ path: dir + "/" + name, mode: "100644", type: "blob", sha: blob.sha });
  }
  for (const name of old.keys()) if (!keep.has(name)) tree.push({ path: dir + "/" + name, mode: "100644", type: "blob", sha: null });
  say("Uploading the journal…");
  const sharedAt = new Date();
  const json = JSON.stringify({ app: "DSR Travel Journal", version: 2, trip: sharedCopy(t), photos: ids, shared: sharedAt.toISOString(),
    appUrl: appBase(), repo: conf.repo.split("/")[1] });
  const jb = await gh(conf, "/git/blobs", { method: "POST", body: JSON.stringify({ content: json, encoding: "utf-8" }) });
  tree.push({ path: dir + "/trip.json", mode: "100644", type: "blob", sha: jb.sha });
  /* 2f: the website - the viewer (from this app's site/ folder) at the root, and a page per trip whose
     title/description/cover also give Messenger & co. a proper link preview */
  say("Updating the website…");
  const site = pagesBase(conf), textBlob = async (path, text, oldSha) => {
    if (oldSha && oldSha === await gitSha(new Blob([text]))) return;
    const b = await gh(conf, "/git/blobs", { method: "POST", body: JSON.stringify({ content: text, encoding: "utf-8" }) });
    tree.push({ path, mode: "100644", type: "blob", sha: b.sha });
  };
  const rootOld = new Map(((await gh(conf, "/contents/", { ok404: true })) || []).map(f => [f.name, f.sha]));
  for (const [from, to] of [["viewer.js", "viewer.js"], ["viewer.css", "viewer.css"], ["home.html", "index.html"]]) {
    const r = await fetch(appBase() + "site/" + from, { cache: "no-store" }); if (!r.ok) throw new Error("couldn't read the website files from the app (" + r.status + ")");
    await textBlob(to, await r.text(), rootOld.get(to));
  }
  const coverId = t.cover.find(p => ids.includes(p)) || ids[0];
  const firstDay = [...t.days].sort((a, b) => (a.date || "").localeCompare(b.date || ""))[0];
  const tpl = await (await fetch(appBase() + "site/trip.html", { cache: "no-store" })).text();
  const desc = [t.description && t.description !== t.name ? t.description : "", `${t.days.length} day${t.days.length === 1 ? "" : "s"}`, t.start ? fmtDate(t.start) + (t.end ? " – " + fmtDate(t.end) : "") : ""].filter(Boolean).join(" · ");
  await textBlob(dir + "/index.html", tpl.replaceAll("{{TITLE}}", esc(t.name || "Trip")).replaceAll("{{DESC}}", esc(desc))
    .replace("{{OGIMAGE}}", coverId ? `<meta property="og:image" content="${esc(site + dir + "/" + coverId + ".jpg")}">` : ""), old.get("index.html"));
  const entry = { id: t.shareId, name: t.name, description: t.description || "", start: t.start || firstDay?.date || "", end: t.end || "", days: t.days.length, cover: coverId || "", updated: sharedAt.toISOString() };
  const withIndex = async sha => {   // trips/index.json (the home page's list) as it is on this commit, plus this trip
    const cur = await gh(conf, "/contents/trips/index.json?ref=" + sha, { ok404: true });
    let list = []; try { list = cur ? JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(cur.content.replace(/\s/g, "")), c => c.charCodeAt(0)))) : []; } catch {}
    list = [...list.filter(x => x.id !== t.shareId), entry];
    const b = await gh(conf, "/git/blobs", { method: "POST", body: JSON.stringify({ content: JSON.stringify(list, null, 1), encoding: "utf-8" }) });
    return [...tree, { path: "trips/index.json", mode: "100644", type: "blob", sha: b.sha }];
  };
  /* 2d: commit on top of whatever main is now; if main moved meanwhile (another share, or GitHub's
     read copy lagging) GitHub answers 422 "not a fast forward" - re-read main and commit again */
  for (let attempt = 1; ; attempt++) {
    if (attempt > 1) { say(`GitHub was busy - saving again (${attempt} of 4)…`); await new Promise(r => setTimeout(r, 1500 * attempt)); ref = await gh(conf, "/git/ref/heads/" + branch); }
    const head = await gh(conf, "/git/commits/" + ref.object.sha);
    const full = await withIndex(ref.object.sha);
    const nt = await gh(conf, "/git/trees", { method: "POST", body: JSON.stringify({ base_tree: head.tree.sha, tree: attempt > 1 ? full.filter(e => e.sha !== null) : full }) });
    const c = await gh(conf, "/git/commits", { method: "POST", body: JSON.stringify({ message: "Share " + (t.name || "trip"), tree: nt.sha, parents: [ref.object.sha] }) });
    try { await gh(conf, "/git/refs/heads/" + branch, { method: "PATCH", body: JSON.stringify({ sha: c.sha }) }); break; }
    catch (e) { if (attempt >= 4 || !/422|fast.forward/i.test(e.message)) throw e; }
  }
  return site + dir + "/?v=" + sharedAt.getTime().toString(36);
}
const appBase = () => location.origin + location.pathname.replace(/[^/]*$/, "");
const pagesBase = conf => { const [o, r] = conf.repo.split("/"); return `https://${o.toLowerCase()}.github.io/${r}/`; };
let publishing = false;
function shareLinkUI(t) {
  const box = $("#linkbox"); box.style.display = "block";
  const conf = ghConf();
  if (!conf) {
    box.innerHTML = `<b>One-time setup</b>
      <div class="hint">Needs a public GitHub repository with Pages switched on, and a key that can write to it (see the steps Claude gave you). The key is kept only on this device.</div>
      <label>Repository (owner/name)</label><input id="ghRepo" value="100dsr100-sketch/DSRTrips">
      <label>GitHub key (fine-grained token)</label><input id="ghTok" type="password" placeholder="github_pat_…">
      <div class="row" style="margin-top:8px"><button class="pri" id="ghSave">Save and share</button></div>`;
    $("#ghSave").onclick = () => {
      const repo = $("#ghRepo").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, ""), token = $("#ghTok").value.trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) return toast("Fill in both - repository as owner/name", 3000);
      try { localStorage.setItem(GH_KEY, JSON.stringify({ repo, token })); } catch { return toast("This browser won't save the key", 3000); }
      shareLinkUI(t);
    };
    return;
  }
  box.innerHTML = `<div class="hint" id="lmsg">Starting…</div><div class="row" id="lbtns" style="margin-top:6px"></div>
    <div class="hint" style="margin-top:6px">Sharing to ${esc(conf.repo)} · <a href="#" id="ghForget" style="color:var(--gold)">change key / repository</a></div>`;
  $("#ghForget").onclick = e => { e.preventDefault(); try { localStorage.removeItem(GH_KEY); } catch {} shareLinkUI(t); };
  const say = m => $("#lmsg") && ($("#lmsg").textContent = m);
  if (publishing) { say("Already sharing - one moment…"); return; }   // 2d: a second tap mustn't start a second share
  publishing = true; $("#shareLink").disabled = true;
  const done = () => { publishing = false; const b = $("#shareLink"); if (b) b.disabled = false; };
  publishTrip(t, conf, say).finally(done).then(url => {
    say("Done. The website updates in about a minute (GitHub is publishing it). Tap Send link and pick Messenger.");
    const text = `${t.name} – my travel journal:`;
    $("#lbtns").innerHTML = `<button class="pri" id="lsend">Send link</button><button class="sm" id="lcopy">Copy link</button><button class="sm" id="lopen">Open website</button>`;
    $("#lopen").onclick = () => window.open(url, "_blank");
    $("#lsend").onclick = () => navigator.share ? navigator.share({ title: t.name, text, url }).catch(() => {}) : (location.href = "mailto:?subject=" + encodeURIComponent(t.name) + "&body=" + encodeURIComponent(text + " " + url));
    $("#lcopy").onclick = () => navigator.clipboard.writeText(url).then(() => toast("Link copied"), () => prompt("Copy this link:", url));
  }).catch(e => { say("Couldn't share: " + e.message); $("#lbtns").innerHTML = `<button class="sm" id="lretry">Try again</button>`; $("#lretry").onclick = () => shareLinkUI(t); });
}

/* the receiving end: #get/<repo>/<shareId>. Messenger/Facebook open links in their own browser, whose
   storage is separate from Chrome - so there, first offer to open the link in Chrome (Android intent). */
views.get = async (repo, id, ver) => {
  const inApp = /FBAN|FBAV|FB_IAB|FBIOS|Messenger|Instagram/i.test(navigator.userAgent), android = /Android/i.test(navigator.userAgent);
  const base = location.origin + "/" + repo + "/trips/" + id + "/";
  /* 2e: GitHub Pages lets its servers keep a copy for up to 10 minutes - a unique ?t= asks for a fresh one */
  const fresh = u => fetch(u + (u.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
  const want = ver ? parseInt(ver, 36) : 0;
  let waited = 0;
  const doImport = async () => {
    main.innerHTML = `<div class="card"><div class="hint" id="gmsg">Fetching the trip…</div></div>`;
    try {
      const r = await fresh(base + "trip.json");
      if (r.status === 404) throw new Error("not published yet - GitHub takes about a minute after sharing. Try again shortly.");
      if (!r.ok) throw new Error("the server said " + r.status);
      const j = await r.json(); if (!j.trip) throw new Error("that link isn't a DSR trip");
      if (want && Date.parse(j.shared || 0) < want - 2000) {   // an older copy - the new one is still being published
        if (waited < 180) { $("#gmsg").textContent = `GitHub is still publishing the newest version (usually about a minute) – checking again in 15 s…`; waited += 15; setTimeout(doImport, 15000); return; }
        throw new Error("GitHub still has the previous version after 3 minutes. Try again in a few minutes.");
      }
      let n = 0;
      const ok = await saveImportedTrip(j.trip, (j.photos || []).map(pid => [pid, async () => {
        $("#gmsg") && ($("#gmsg").textContent = `Fetching photo ${++n} of ${j.photos.length}…`);
        const pr = await fresh(base + pid + ".jpg"); if (!pr.ok) throw new Error("a photo is missing (" + pr.status + ")"); return pr.blob(); }]));
      history.replaceState(null, "", location.pathname);
      if (ok) go("trip", j.trip.id); else render();
    } catch (e) {
      main.innerHTML = `<div class="card"><b>Couldn't open the shared trip</b><div class="hint">${esc(e.message)}</div><div class="row" style="margin-top:8px"><button class="pri" id="gretry">Try again</button><button class="sm" onclick="location.hash=''">Home</button></div></div>`;
      $("#gretry").onclick = () => { waited = 0; doImport(); };
    }
  };
  if (!inApp) return doImport();
  const intent = "intent://" + location.host + location.pathname + "?get=" + encodeURIComponent(repo + "/" + id + (ver ? "/" + ver : "")) + "#Intent;scheme=https;package=com.android.chrome;end";
  main.innerHTML = `<div class="card"><h2 style="margin-top:0">A shared trip</h2>
    <p class="hint">You opened this inside ${/Instagram/i.test(navigator.userAgent) ? "Instagram" : "Messenger / Facebook"}. Open it in ${android ? "Chrome" : "Safari"} so the trip is saved in your DSR Travel Journal.</p>
    ${android ? `<a class="btn" style="background:var(--gold);color:#000;display:block;text-align:center;text-decoration:none;padding:14px;font-size:17px" href="${esc(intent)}">Open in Chrome</a>` : `<p class="hint"><b>Tap ⋯ (top right) › Open in browser.</b></p>`}
    <div class="row" style="margin-top:10px"><button class="sm" id="here">Open it here anyway</button></div></div>`;
  $("#here").onclick = doImport;
};

/* ======================= unused photos (4b) =======================
   Photos taken out of a day's notes stay stored (so nothing is lost by a slip). Here: tick some, then put them into
   a day (they go at the end of its notes) or delete them for good to free the space. */
views.unused = async () => {
  const list = await unusedPhotos();
  if (!list.length) { toast("No unused photos"); return go("home"); }
  const sizes = {}; let total = 0;
  for (const { id } of list) { const b = await getPhoto(id); sizes[id] = b?.size || 0; total += sizes[id]; }
  const mb = n => (n / 1048576).toFixed(1) + " MB";
  const picked = new Set();
  main.innerHTML = `<div class="row"><button class="sm" onclick="location.hash=''">‹ Trips</button></div>
    <h2>🧩 Unused photos</h2>
    <div class="hint">${list.length} photo${list.length === 1 ? "" : "s"} (${mb(total)}) that aren't in any day – usually ones taken out of the notes. Tap the ones you want, then put them into a day or delete them.</div>
    <div class="row" style="margin:8px 0"><button class="sm" id="uAll">Select all</button><button class="sm" id="uNone">Select none</button><span class="hint" id="uSel"></span></div>
    <div id="ugrid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px"></div>
    <div class="row" style="margin-top:10px;position:sticky;bottom:8px;background:#000;padding:6px 0"><button class="pri" id="uPut" disabled>Put into a day…</button><button class="danger" id="uDel" disabled>Delete for good</button></div>
    <div id="upick"></div>`;
  const grid = $("#ugrid");
  const sync = () => { const n = picked.size, sz = [...picked].reduce((a, id) => a + sizes[id], 0);
    $("#uSel").textContent = n ? `${n} ticked (${mb(sz)})` : ""; $("#uPut").disabled = $("#uDel").disabled = !n;
    grid.querySelectorAll("[data-id]").forEach(c => c.classList.toggle("picked", picked.has(c.dataset.id))); };
  for (const { id, when } of list) {
    const c = document.createElement("div"); c.className = "uph"; c.dataset.id = id;
    c.innerHTML = `<img src="${await photoURL(id)}" loading="lazy"><div class="hint">${when ? new Date(when).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : ""}</div>`;
    c.onclick = () => { picked.has(id) ? picked.delete(id) : picked.add(id); sync(); };
    grid.appendChild(c);
  }
  $("#uAll").onclick = () => { list.forEach(x => picked.add(x.id)); sync(); };
  $("#uNone").onclick = () => { picked.clear(); sync(); };
  $("#uDel").onclick = async () => {
    const n = picked.size; if (!n || !confirm(`Delete ${n} photo${n === 1 ? "" : "s"} for good?\n\nThey aren't in any day, so nothing in your journals changes - but they can't be brought back.`)) return;
    const st = tx("photos", "readwrite");
    for (const id of picked) { st.delete(id); if (photoUrls[id]) { URL.revokeObjectURL(photoUrls[id]); delete photoUrls[id]; } }
    await new Promise(r => { st.transaction.oncomplete = st.transaction.onerror = r; });
    toast(`Deleted ${n} photo${n === 1 ? "" : "s"}`); views.unused();
  };
  $("#uPut").onclick = async () => {
    const trips = (await allTrips()).sort((a, b) => (b.start || "").localeCompare(a.start || ""));
    const box = $("#upick");
    box.innerHTML = `<h3>Which day?</h3>` + trips.map(t => `<div class="hint" style="color:var(--gold);margin-top:8px">${esc(t.name)}</div>` +
      [...t.days].sort((a, b) => (a.date || "").localeCompare(b.date || "")).map((d, i) => `<button class="sm" data-t="${t.id}" data-d="${d.id}" style="display:block;width:100%;text-align:left;margin:4px 0">Day ${i + 1}${d.date ? " · " + fmtDate(d.date) : ""}${d.title ? " · " + esc(d.title) : ""}</button>`).join("")).join("");
    box.scrollIntoView({ behavior: "instant" });
    box.querySelectorAll("[data-d]").forEach(b => b.onclick = async () => {
      const t = await getTrip(b.dataset.t), d = t?.days.find(x => x.id === b.dataset.d); if (!d) return;
      const ids = list.map(x => x.id).filter(id => picked.has(id)).reverse();   // in the order they were first added
      d.notes = (d.notes || "") + `<p>${ids.map(id => `<img data-pid="${id}" style="width: 45%; float: right;">`).join("")}</p>`;
      await putTrip(t);
      toast(`${ids.length} photo${ids.length === 1 ? "" : "s"} put at the end of that day – tap one to move or resize it`, 4000);
      go("day", t.id, d.id);
    });
  };
  sync();
};

/* ======================= packing list (4a) ======================= */
const PACK_STD = ["Passport / ID", "Tickets & bookings", "Travel insurance", "Wallet & cards", "Some cash", "Phone + charger", "Power adapter", "Headphones",
  "Medication", "Glasses / sunglasses", "Toiletries", "Clothes", "Jacket", "Comfortable shoes", "Swimwear", "Hat & sunscreen", "Camera", "House keys", "Snacks for the journey"];
views.packing = async id => {
  const t = await getTrip(id); if (!t) return go("home");
  t.packing ||= [];
  const save = () => putTrip(t);
  const draw = () => {
    const done = t.packing.filter(x => x.done).length;
    main.innerHTML = `<div class="row"><button class="sm" id="back">‹ ${esc(t.name)}</button></div>
      <h2>🧳 Packing list</h2><div class="hint">${t.packing.length ? `${done} of ${t.packing.length} packed` : "Nothing on the list yet."}</div>
      <div id="plist" style="margin:8px 0">${t.packing.map((x, i) => `<div class="pk${x.done ? " done" : ""}" data-i="${i}"><input type="checkbox"${x.done ? " checked" : ""}><span>${esc(x.text)}</span><button class="sm danger" title="Remove">✕</button></div>`).join("")}</div>
      <div class="row" style="flex-wrap:nowrap"><input id="pnew" placeholder="Add something to pack…"><button class="sm pri" id="padd">Add</button></div>
      <div class="row" style="margin-top:10px"><button class="sm" id="pstd">+ The usual things</button>${done ? `<button class="sm" id="punt">Untick all</button>` : ""}${t.packing.length ? `<button class="sm danger" id="pclr">Clear the list</button>` : ""}</div>`;
    $("#back").onclick = () => go("trip", id);
    main.querySelectorAll(".pk").forEach(r => { const i = +r.dataset.i;
      r.querySelector("input").onchange = e => { t.packing[i].done = e.target.checked; save(); draw(); };
      r.querySelector("span").onclick = () => { t.packing[i].done = !t.packing[i].done; save(); draw(); };
      r.querySelector("button").onclick = () => { t.packing.splice(i, 1); save(); draw(); }; });
    const add = () => { const v = $("#pnew").value.trim(); if (!v) return; t.packing.push({ text: v, done: false }); save(); draw(); $("#pnew").focus(); };
    $("#padd").onclick = add; $("#pnew").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); add(); } };
    $("#pstd").onclick = () => { const have = new Set(t.packing.map(x => x.text.toLowerCase())); PACK_STD.forEach(x => { if (!have.has(x.toLowerCase())) t.packing.push({ text: x, done: false }); }); save(); draw(); };
    if ($("#punt")) $("#punt").onclick = () => { t.packing.forEach(x => x.done = false); save(); draw(); };
    if ($("#pclr")) $("#pclr").onclick = () => { if (confirm("Clear the whole packing list?")) { t.packing = []; save(); draw(); } };
  };
  draw();
};
/* ======================= my travel map (4a): every trip on one map ======================= */
views.world = async () => {
  await leafletReady().catch(e => toast(e.message, 4000));
  const trips = (await allTrips()).sort((a, b) => (a.start || "").localeCompare(b.start || ""));
  const routes = [], pts = new Map(), countries = new Map();
  let km = 0, flyKm = 0, days = 0;
  for (const t of trips) for (const d of t.days) {
    days++;
    if (d.route?.coords?.length) { routes.push({ kind: d.route.kind, coords: d.route.coords }); const k = routeKm(d.route); if (d.route.kind === "flight") flyKm += k; else km += k; }
    for (const p of [d.from, d.to]) if (p?.lat != null) {
      pts.set(p.name + "|" + (+p.lat).toFixed(2), { lat: p.lat, lon: p.lon, name: p.name });
      if (p.country) { const c = countries.get(p.country) || { cc: p.cc, trips: new Set() }; c.trips.add(t.name); countries.set(p.country, c); }
    }
  }
  main.innerHTML = `<div class="row"><button class="sm" onclick="location.hash=''">‹ Trips</button></div>
    <h2>🌍 My travel map</h2>
    <div class="tnums"><span>${trips.length} trip${trips.length === 1 ? "" : "s"}</span><span>${days} day${days === 1 ? "" : "s"}</span>${km ? `<span>${nf(km)} km on the ground</span>` : ""}${flyKm ? `<span>${nf(flyKm)} km flown</span>` : ""}<span>${countries.size} countr${countries.size === 1 ? "y" : "ies"}</span><span>${pts.size} place${pts.size === 1 ? "" : "s"}</span></div>
    <div class="mapframe" id="wmap" style="height:58vh;margin:8px 0"></div>
    <h3>Countries</h3>
    <div>${[...countries].sort((a, b) => a[0].localeCompare(b[0])).map(([n, c]) => `<div class="card" style="padding:8px 12px;margin-bottom:6px"><span style="font-size:20px">${flag(c.cc)}</span> <b style="color:var(--gold)">${esc(n)}</b> <span class="hint">${esc([...c.trips].join(", "))}</span></div>`).join("") || `<div class="hint">Add From / To places to your days.</div>`}</div>`;
  drawMap($("#wmap"), { routes, points: [...pts.values()] });
};

/* ======================= start ======================= */
/* 1l: ask the browser to keep this app's storage permanently - without it Chrome may clear it when
   the phone runs low on space (an installed app is normally granted this without a prompt) */
navigator.storage?.persist?.().catch(() => {});
{ const g = new URLSearchParams(location.search).get("get");   // 1u: "Open in Chrome" from Messenger arrives as ?get=<repo>/<id>
  if (g) history.replaceState(null, "", location.pathname + "#get/" + g); }
openDB().then(render).catch(e => main.innerHTML = `<div class="card">Storage unavailable: ${esc(e.message)}</div>`);
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("service-worker.js").catch(() => {}));
