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
    const r = indexedDB.open("dsr-travel-journal", 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("trips", { keyPath: "id" }); r.result.createObjectStore("photos"); };
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
}
const tx = (store, mode = "readonly") => db.transaction(store, mode).objectStore(store);
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const allTrips = () => req(tx("trips").getAll());
const getTrip = id => req(tx("trips").get(id));
const putTrip = t => { t.updated = Date.now(); return req(tx("trips", "readwrite").put(t)); };
const delTrip = id => req(tx("trips", "readwrite").delete(id));
const putPhoto = (id, blob) => req(tx("photos", "readwrite").put(blob, id));
const getPhoto = id => req(tx("photos").get(id));
const photoUrls = {};
async function photoURL(id) {
  if (photoUrls[id]) return photoUrls[id];
  const b = await getPhoto(id); if (!b) return "";
  return (photoUrls[id] = URL.createObjectURL(b));
}

/* photos: downscale on the way in (a phone photo is 3-8 MB; 1600px JPEG is plenty for A5) */
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
 *    so they're converted with heic2any (loaded from the CDN only when needed);
 *  - huge images (108 MP on an S22 Ultra) - a full-size decode can run out of memory, so a
 *    downscaled decode is tried next;
 *  - anything else odd - a plain <img> decode as the last resort.
 * Before 1b a failed decode threw silently and the 📷 button looked dead.
 */
let heicLib = null;
function loadHeic() {
  return heicLib ||= new Promise((ok, bad) => {
    const sc = document.createElement("script");
    sc.src = "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js";
    sc.onload = () => ok(window.heic2any); sc.onerror = () => { heicLib = null; bad(new Error("couldn't load the HEIC converter (offline?)")); };
    document.head.appendChild(sc);
  });
}
async function heicToJpeg(file) {
  const conv = await loadHeic();
  const out = await conv({ blob: file, toType: "image/jpeg", quality: 0.9 });
  return Array.isArray(out) ? out[0] : out;
}
async function decodeImage(file) {
  const heic = /\.hei[cf]$/i.test(file.name || "") || /hei[cf]/i.test(file.type || "");
  const src = heic ? await heicToJpeg(file) : file;
  const big = src.size > 12 * 1024 * 1024;
  const tries = [
    () => createImageBitmap(src, big ? { resizeWidth: 1600, resizeQuality: "high" } : undefined),
    () => createImageBitmap(src, { resizeWidth: 1600, resizeQuality: "high" }),
    async () => { const url = URL.createObjectURL(src); const im = new Image(); im.src = url; await im.decode(); setTimeout(() => URL.revokeObjectURL(url), 5000); return im; },
    ...(heic ? [] : [async () => createImageBitmap(await heicToJpeg(file))]),   // a HEIC with a misleading name/type
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

/* long-press (or right-click) on an element; movement cancels, so panning a map never triggers it */
function onLongPress(el, fn, ms = 650) {
  let timer = null, x0 = 0, y0 = 0, fired = false;
  const cancel = () => { clearTimeout(timer); timer = null; el.classList.remove("lp-arm"); };
  el.addEventListener("pointerdown", e => {
    fired = false; x0 = e.clientX; y0 = e.clientY; cancel();
    el.classList.add("lp-arm");
    timer = setTimeout(() => { timer = null; fired = true; el.classList.remove("lp-arm"); navigator.vibrate?.(30); fn(); }, ms);
  }, true);
  el.addEventListener("pointermove", e => { if (timer && Math.hypot(e.clientX - x0, e.clientY - y0) > 12) cancel(); }, true);
  ["pointerup", "pointercancel", "pointerleave"].forEach(ev => el.addEventListener(ev, cancel, true));
  el.addEventListener("contextmenu", e => { e.preventDefault(); e.stopPropagation(); if (!fired) { cancel(); fn(); } fired = false; }, true);
}

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
  const today = new Date().toISOString().slice(0, 10);
  const base = date < today ? "https://archive-api.open-meteo.com/v1/archive" : "https://api.open-meteo.com/v1/forecast";
  const r = await fetch(`${base}?latitude=${place.lat}&longitude=${place.lon}&start_date=${date}&end_date=${date}&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto`);
  const j = await r.json(); const d = j.daily;
  if (!d || d.temperature_2m_max[0] == null) throw new Error("No weather for that date yet");
  return { min: Math.round(d.temperature_2m_min[0]), max: Math.round(d.temperature_2m_max[0]), summary: WMO(d.weather_code[0]) };
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
function drawMap(el, { routes = [], points = [], view = null, interactive = true, onView = null, caption = "" }) {
  el.innerHTML = "";
  const m = L.map(el, { zoomControl: interactive, attributionControl: false, dragging: interactive, scrollWheelZoom: interactive, doubleClickZoom: interactive, touchZoom: interactive, boxZoom: false, keyboard: false });
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
  setTimeout(() => m.invalidateSize(), 60);
  return m;
}
function dayRoutes(day) { return day.route?.coords?.length ? [{ kind: day.route.kind, coords: day.route.coords }] : []; }
function dayPoints(day) { return [day.from, day.to].filter(p => p && p.lat != null).map(p => ({ ...p, label: true })); }

/* ======================= router ======================= */
const views = {};
let current = null;
function go(name, ...args) { current = { name, args }; location.hash = [name, ...args].join("/"); }
window.addEventListener("hashchange", render);
async function render() {
  const [name = "home", ...args] = location.hash.replace(/^#/, "").split("/").filter(Boolean);
  document.getElementById("pagestyle")?.remove();
  window.scrollTo(0, 0);
  try { await (views[name] || views.home)(...args); } catch (e) { console.error(e); main.innerHTML = `<div class="card">Something went wrong: ${esc(e.message)}</div><button onclick="location.hash=''">Home</button>`; }
}

/* ======================= views ======================= */
views.home = async () => {
  const trips = (await allTrips()).sort((a, b) => (b.start || "").localeCompare(a.start || ""));
  main.innerHTML = `
    <div class="row" style="justify-content:space-between"><h2>My trips</h2><button class="pri" id="newTrip">+ New trip</button></div>
    ${trips.length ? "" : `<div class="card"><div class="ttl">No trips yet</div><div class="sub">Tap “New trip”, give it a name, then add a page for each day of travel.</div></div>`}
    ${trips.map(t => `<div class="card tripcard" data-id="${t.id}"><div class="ttl">${esc(t.name)}</div>
      <div class="sub">${esc(t.description || "")}</div><div class="sub">${fmtDate(t.start)}${t.end ? " – " + fmtDate(t.end) : ""} · ${t.days.length} day${t.days.length === 1 ? "" : "s"}</div></div>`).join("")}
    <h3>Backup</h3><div class="row"><button class="sm" id="impAll">Import backup file</button></div>
    <p class="hint">Journals are saved on this device. Use Export on a trip to back it up or move it to another phone/PC.</p>`;
  main.querySelectorAll(".tripcard").forEach(c => c.onclick = () => go("trip", c.dataset.id));
  $("#newTrip").onclick = async () => {
    const t = { id: uid(), name: "New trip", description: "", start: new Date().toISOString().slice(0, 10), end: "", cover: [], days: [], timeline: null };
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
    <div class="row" style="margin:10px 0"><button id="addDay" class="pri">+ Add day</button><button id="editTrip">Edit trip</button><button id="layout">A5 pages / print</button></div>
    ${t.days.map((d, i) => `<div class="card tripcard" data-d="${d.id}"><div class="ttl">Day ${i + 1} · ${esc(d.title || "Untitled day")}</div>
      <div class="sub">${fmtDate(d.date)}${d.from?.name || d.to?.name ? " · " + esc([d.from?.name, d.to?.name].filter(Boolean).join(" → ")) : ""}</div></div>`).join("") || `<div class="card"><div class="sub">No days yet – tap “Add day”.</div></div>`}`;
  main.querySelectorAll("[data-d]").forEach(c => c.onclick = () => go("day", id, c.dataset.d));
  $("#addDay").onclick = async () => {
    const last = t.days[t.days.length - 1];
    const next = last?.date ? new Date(new Date(last.date + "T12:00:00").getTime() + 864e5).toISOString().slice(0, 10) : (t.start || new Date().toISOString().slice(0, 10));
    const d = { id: uid(), date: next, title: "", from: last?.to || null, to: null, weather: null, motel: "", room: "", roomDesc: "", notes: "", route: null, mapView: null };
    t.days.push(d); await putTrip(t); go("day", id, d.id);
  };
  $("#editTrip").onclick = () => go("tripEdit", id);
  $("#layout").onclick = () => go("layout", id);
};

views.tripEdit = async id => {
  const t = await getTrip(id); if (!t) return go("home");
  main.innerHTML = `
    <div class="row"><button class="sm" id="back">‹ Back</button></div>
    <h2>Edit trip</h2>
    <label>Trip name</label><input id="name" value="${esc(t.name)}">
    <label>Trip description (shown small in every page footer)</label><input id="desc" value="${esc(t.description)}">
    <div class="two"><div><label>Start date</label><input type="date" id="start" value="${t.start || ""}"></div><div><label>End date</label><input type="date" id="end" value="${t.end || ""}"></div></div>
    <h3>Cover photos</h3><div class="row" id="covers"></div>
    <div class="row" style="margin-top:6px"><button class="sm" id="addCover">+ Add cover photos</button></div>
    <h3>Google Timeline</h3>
    <div class="hint">${t.timeline ? `Imported: ${t.timeline.length} location points. Days with a timeline track can use it as their travel map.` : "Not imported."}<br>
      On your phone: Settings › Location › Location services › Timeline › Export Timeline data, then pick that file here.</div>
    <div class="row" style="margin-top:6px"><button class="sm" id="impTl">Import Timeline file</button>${t.timeline ? `<button class="sm" id="useTl">Use timeline for every day</button>` : ""}</div>
    <h3>Save / share</h3>
    <div class="row"><button class="pri" id="save">Save</button><button class="sm" id="export">Export backup file</button><button class="sm danger" id="del">Delete trip</button></div>`;
  const drawCovers = async () => {
    $("#covers").innerHTML = "";
    for (const pid of t.cover) {
      const w = document.createElement("div"); w.style.cssText = "position:relative";
      w.innerHTML = `<img src="${await photoURL(pid)}" style="width:80px;height:80px;object-fit:cover;border-radius:6px;border:1px solid var(--gold-deep)"><button class="sm danger" style="position:absolute;top:2px;right:2px;padding:1px 6px">×</button>`;
      w.querySelector("button").onclick = () => { t.cover = t.cover.filter(x => x !== pid); drawCovers(); };
      $("#covers").appendChild(w);
    }
  };
  drawCovers();
  const collect = () => { t.name = $("#name").value.trim() || "Untitled trip"; t.description = $("#desc").value.trim(); t.start = $("#start").value; t.end = $("#end").value; };
  $("#addCover").onclick = async () => {
    const failed = [];
    for (const f of (await pickFiles($("#filePick"))).slice(0, 6)) { try { t.cover.push(await importPhoto(f)); } catch (e) { failed.push(`${f.name || "photo"}: ${e.message}`); } }
    t.cover = t.cover.slice(0, 6); drawCovers();
    if (failed.length) toast(`Couldn't add ${failed.length} photo${failed.length > 1 ? "s" : ""} – ${failed[0]}`, 6000);
  };
  $("#save").onclick = async () => { collect(); await putTrip(t); toast("Trip saved"); go("trip", id); };
  $("#back").onclick = async () => { collect(); await putTrip(t); go("trip", id); };
  $("#del").onclick = async () => { if (confirm(`Delete “${t.name}” and all its days?`)) { await delTrip(id); go("home"); } };
  $("#export").onclick = () => exportTrip(t);
  $("#impTl").onclick = async () => {
    const [f] = await pickFiles($("#jsonPick"), false); if (!f) return;
    try {
      let pts = parseTimeline(JSON.parse(await f.text()));
      if (t.start) { const s = new Date(t.start + "T00:00:00").getTime() - 864e5, e = (t.end ? new Date(t.end + "T23:59:59").getTime() : Date.now()) + 864e5; pts = pts.filter(p => p.t >= s && p.t <= e); }
      if (!pts.length) return toast("No timeline points found for this trip's dates", 3500);
      t.timeline = pts.map(p => [p.t, +p.lat.toFixed(5), +p.lon.toFixed(5)]);
      collect(); await putTrip(t); toast(`Imported ${pts.length} points`); views.tripEdit(id);
    } catch (e) { toast("That file isn't a Timeline export: " + e.message, 4000); }
  };
  const useTl = $("#useTl"); if (useTl) useTl.onclick = async () => {
    let n = 0;
    for (const d of t.days) { const c = timelineFor(t, d.date); if (c.length > 1) { d.route = { kind: "timeline", coords: c }; d.mapView = null; n++; } }
    collect(); await putTrip(t); toast(`Timeline track added to ${n} day${n === 1 ? "" : "s"}`);
  };
};
const timelineFor = (t, date) => thin((t.timeline || []).filter(p => localDay(p[0]) === date).map(p => [p[1], p[2]]));

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

views.day = async (tripId, dayId) => {
  const t = await getTrip(tripId); const d = t?.days.find(x => x.id === dayId); if (!d) return go("trip", tripId);
  main.innerHTML = `
    <div class="row"><button class="sm" id="back">‹ ${esc(t.name)}</button><div style="flex:1"></div><button class="sm danger" id="delDay">Delete day</button></div>
    <h2>Edit day</h2>
    <label>Travel day description</label><input id="title" value="${esc(d.title)}" placeholder="e.g. Drive to Sydney, fly to New Delhi">
    <label>Date</label><input type="date" id="date" value="${d.date || ""}">
    <label>From</label><div id="from"></div>
    <label>To</label><div id="to"></div>
    <label>Weather for the day</label>
    <div class="row" style="flex-wrap:nowrap"><input id="wx" value="${esc(d.weather ? `${d.weather.min}–${d.weather.max}°C ${d.weather.summary || ""}` : "")}" placeholder="auto-fills from the date + place"><button class="sm" id="getWx">Get</button></div>
    <div class="two"><div><label>Motel / hotel</label><input id="motel" value="${esc(d.motel)}"></div><div><label>Room number</label><input id="room" value="${esc(d.room)}"></div></div>
    <label>Room description</label><textarea id="roomDesc">${esc(d.roomDesc)}</textarea>
    <h3>Day's travel map</h3>
    <div class="row"><select id="rkind" style="flex:1">
      <option value="">No travel map</option><option value="road">Road route (from → to)</option><option value="flight">Flight (from → to)</option>
      <option value="timeline">Google Timeline track for this date</option></select><button class="sm" id="build">Build map</button></div>
    <div class="hint" id="rinfo"></div>
    <div class="mapframe" id="dmap" style="height:260px;margin-top:6px"></div>
    <div class="hint">Pinch/drag the map to frame it – the page uses exactly this view. <button class="sm" id="refit">Re-fit</button></div>
    <h3>Travel notes</h3>
    <div class="etb"><button class="sm" id="bPhoto">📷 Photo</button><button class="sm" id="bMap">🗺 Map</button><button class="sm" data-cmd="bold"><b>B</b></button><button class="sm" data-cmd="italic"><i>I</i></button><button class="sm" data-cmd="insertUnorderedList">• List</button><div style="flex:1"></div><button class="sm pri" id="save">Save</button></div>
    <div class="notes-edit" id="notes" contenteditable="true"></div>
    <p class="hint">Tap in the text where you want a photo, then 📷. Tap a photo to resize or align it. Long-press a map to delete it.</p>`;
  let from = d.from, to = d.to;
  geoField($("#from"), from, p => { from = p; });
  geoField($("#to"), to, p => { to = p; });
  $("#rkind").value = d.route?.kind || "";
  // notes: stored with data-pid only; object URLs attached at load
  const notes = $("#notes"); notes.innerHTML = d.notes || "<p><br></p>";
  await hydrate(notes, true);
  let map = null;
  const drawDayMap = (view = d.mapView) => { map?.remove(); map = drawMap($("#dmap"), { routes: dayRoutes(d), points: dayPoints({ from, to }), view, onView: v => d.mapView = v }); };
  drawDayMap();
  const info = () => $("#rinfo").textContent = d.route ? `${d.route.kind === "timeline" ? "Timeline track" : d.route.kind === "flight" ? "Flight" : "Road"}${d.route.km ? " · about " + d.route.km + " km" : ""}` : "";
  info();
  $("#refit").onclick = () => { d.mapView = null; drawDayMap(null); };
  $("#build").onclick = async () => {
    const k = $("#rkind").value;
    try {
      if (!k) d.route = null;
      else if (k === "timeline") { const c = timelineFor(t, $("#date").value); if (c.length < 2) throw new Error(t.timeline ? "No timeline points on this date" : "Import your Google Timeline file first (Edit trip)"); d.route = { kind: "timeline", coords: c }; }
      else { if (!from || !to) throw new Error("Choose From and To first");
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
  $("#bPhoto").onmousedown = e => e.preventDefault();
  $("#bPhoto").onclick = async () => {
    const files = await pickFiles($("#filePick")); if (!files.length) return;
    toast("Adding photo" + (files.length > 1 ? "s" : "") + "…");
    let added = 0; const failed = [];
    for (const f of files) {
      try { const pid = await importPhoto(f); const img = document.createElement("img"); img.dataset.pid = pid; img.style.width = "45%"; img.style.float = "right"; img.src = await photoURL(pid); insertNode(img); added++; }
      catch (e) { failed.push(`${f.name || "photo"}: ${e.message}`); }
    }
    if (failed.length) toast(`Couldn't add ${failed.length} photo${failed.length > 1 ? "s" : ""} – ${failed[0]}`, 6000);
    else if (added) toast(added > 1 ? `${added} photos added` : "Photo added");
  };
  $("#bMap").onmousedown = e => e.preventDefault();
  $("#bMap").onclick = () => mapPicker(async p => {
    const box = document.createElement("div"); box.className = "nmap mapframe"; box.contentEditable = "false";
    box.dataset.lat = p.lat; box.dataset.lon = p.lon; box.dataset.z = 12; box.dataset.name = p.name; box.style.height = "180px"; box.style.margin = "4px 0";
    insertNode(box); await hydrate(notes, true); armMaps();
  });
  // long-press a map (right-click on a PC) to delete it
  function armMaps() {
    notes.querySelectorAll(".nmap").forEach(m => {
      if (m._lp) return; m._lp = true;
      onLongPress(m, () => { if (confirm(`Delete this map${m.dataset.name ? " of " + m.dataset.name : ""}?`)) { m._map?.remove(); m.remove(); keepRange(); toast("Map deleted"); } });
    });
  }
  armMaps();
  // photo resize/align bar
  const bar = $("#imgbar"); let selImg = null;
  notes.addEventListener("click", e => {
    if (e.target.tagName !== "IMG") return;
    selImg?.classList.remove("sel"); selImg = e.target; selImg.classList.add("sel");
    const pct = parseInt(selImg.style.width) || 45; $("#imgsize").value = pct; $("#imgpct").textContent = pct + "% of the page width"; bar.style.display = "block";
  });
  $("#imgsize").oninput = e => { if (selImg) { selImg.style.width = e.target.value + "%"; $("#imgpct").textContent = e.target.value + "% of the page width"; } };
  bar.querySelectorAll("[data-al]").forEach(b => b.onclick = () => { if (!selImg) return; const a = b.dataset.al;
    selImg.style.float = a === "center" ? "none" : a; selImg.style.display = a === "center" ? "block" : ""; selImg.style.margin = a === "center" ? "4px auto" : ""; });
  const closeBar = () => { selImg?.classList.remove("sel"); selImg = null; bar.style.display = "none"; };
  $("#imgdone").onclick = closeBar; $("#imgdel").onclick = () => { selImg?.remove(); closeBar(); };

  const collect = () => {
    d.title = $("#title").value.trim(); d.date = $("#date").value; d.from = from; d.to = to;
    d.motel = $("#motel").value.trim(); d.room = $("#room").value.trim(); d.roomDesc = $("#roomDesc").value.trim();
    if (!$("#wx").value.trim()) d.weather = null; else if (!d.weather || $("#wx").value !== `${d.weather.min}–${d.weather.max}°C ${d.weather.summary || ""}`) d.weather = { text: $("#wx").value.trim() };
    d.notes = serializeNotes(notes);
  };
  const save = async (quiet) => {
    collect();
    if (!d.weather && d.date && (d.to || d.from)) { try { d.weather = await dayWeather(d.date, d.to || d.from); } catch {} }
    await putTrip(t); if (!quiet) toast("Day saved");
  };
  $("#save").onclick = () => save();
  $("#back").onclick = async () => { closeBar(); await save(true); go("trip", tripId); };
  $("#delDay").onclick = async () => { if (confirm("Delete this day?")) { t.days = t.days.filter(x => x.id !== dayId); await putTrip(t); go("trip", tripId); } };
};

/* notes <-> storage: photos saved as <img data-pid>, maps as <div class="nmap" data-lat.. data-z> */
function serializeNotes(el) {
  const c = el.cloneNode(true);
  c.querySelectorAll("img").forEach(i => { i.removeAttribute("src"); i.classList.remove("sel"); });
  c.querySelectorAll(".nmap").forEach(m => m.innerHTML = "");
  return c.innerHTML;
}
async function hydrate(root, interactive) {
  for (const img of root.querySelectorAll("img[data-pid]")) img.src = await photoURL(img.dataset.pid);
  for (const m of root.querySelectorAll(".nmap")) {
    if (m._map) continue;
    m._map = drawMap(m, { points: [{ lat: +m.dataset.lat, lon: +m.dataset.lon, name: m.dataset.name, label: true }], view: { c: [+m.dataset.lat, +m.dataset.lon], z: +m.dataset.z || 12 }, interactive,
      onView: interactive ? v => { m.dataset.lat = v.c[0]; m.dataset.lon = v.c[1]; m.dataset.z = v.z; } : null, caption: m.dataset.name });
  }
}
function mapPicker(onPick) {
  const w = document.createElement("div"); w.className = "imgbar"; w.style.display = "block";
  w.innerHTML = `<div style="color:var(--gold);margin-bottom:6px">Insert a map of…</div><div id="mp"></div><div class="row" style="margin-top:8px;justify-content:flex-end"><button class="sm" id="mpx">Cancel</button></div>`;
  document.body.appendChild(w);
  geoField(w.querySelector("#mp"), null, p => { w.remove(); onPick(p); });
  w.querySelector("#mpx").onclick = () => w.remove();
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
  const meas = pageShell("", "", ""); meas.style.cssText = "position:absolute;left:-9999px;top:0";
  document.body.appendChild(meas); const mb = meas.querySelector(".body");
  for (const [i, d] of t.days.entries()) {
    const blocks = [];
    blocks.push({ kind: "head", html: dayHeadHtml(d, i) });
    if (d.route?.coords?.length || d.from || d.to) blocks.push({ kind: "map" });
    const tmp = document.createElement("div"); tmp.innerHTML = d.notes || "";
    [...tmp.childNodes].filter(n => n.nodeType === 1 || n.textContent.trim()).forEach(n => blocks.push({ kind: "note", html: n.nodeType === 1 ? n.outerHTML : `<p>${esc(n.textContent)}</p>` }));
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
function dayHeadHtml(d, i) {
  const route = [d.from?.name, d.to?.name].filter(Boolean).join(" → ");
  const w = d.weather ? (d.weather.text || `${d.weather.min}–${d.weather.max}°C · ${d.weather.summary || ""}`) : "";
  const facts = [["Travel", route], ["Weather", w], ["Stay", [d.motel, d.room && "room " + d.room].filter(Boolean).join(", ")], ["Room", d.roomDesc]].filter(f => f[1]);
  return `<div class="dtitle">Day ${i + 1} · ${esc(d.title || "")}</div><div class="dmeta">${fmtDate(d.date)}${d.route?.km ? " · " + d.route.km + " km" : ""}</div>
    ${facts.length ? `<div class="facts">${facts.map(f => `<b>${f[0]}</b><span>${esc(f[1])}</span>`).join("")}</div>` : ""}`;
}
function blockEl(b, d, measuring) {
  const el = document.createElement("div"); el.className = "blk";
  if (b.kind === "head") el.innerHTML = b.html;
  else if (b.kind === "map") { el.innerHTML = `<div class="mapframe dmapf"></div>`; }
  else { el.className = "blk notes"; el.innerHTML = b.html; el.querySelectorAll("img[data-pid]").forEach(im => { if (photoUrls[im.dataset.pid]) im.src = photoUrls[im.dataset.pid]; }); el.querySelectorAll(".nmap").forEach(m => m.style.height = "48mm"); }
  return el;
}
async function renderPage(spec, t, ctx) {
  const d = spec.day;
  const hdr = spec.type === "day" ? `${fmtDate(d.date)} · ${d.title || ""}${spec.cont ? " (continued)" : ""}` : t.name;
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
    body.innerHTML = `<div class="ptitle">Contents</div><div class="idx">${t.days.map((d, i) => `<div><span class="d">${shortDate(d.date)}</span><span class="t">Day ${i + 1} · ${esc(d.title || "")}</span><span class="p">${firstPage.get(d) || ""}</span></div>`).join("")}
      <div><span class="d"></span><span class="t">Photo collage</span><span class="p">${ctx.specs.find(s => s.type === "collage")?.no || ""}</span></div></div>`;
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

views.layout = async (tripId, mode = "pages") => {
  const t = await getTrip(tripId); if (!t) return go("home");
  for (const pid of [...t.cover, ...t.days.flatMap(d => [...(d.notes || "").matchAll(/data-pid="([^"]+)"/g)].map(m => m[1]))]) await photoURL(pid);
  main.innerHTML = `<div class="noprint">
      <div class="row"><button class="sm" id="back">‹ ${esc(t.name)}</button></div>
      <h2>Pages</h2>
      <div class="row"><select id="mode" style="flex:1">
        <option value="pages">A5 pages, in order (print on A5 paper)</option>
        <option value="duplex">A4 booklet – double-sided (flip on short edge)</option>
        <option value="single">A4 booklet – single-sided (all fronts, then all backs)</option></select>
        <button class="pri" id="print">Print</button></div>
      <p class="hint" id="modehint"></p></div>
    <div class="pages" id="pages"><div class="hint">Laying out pages…</div></div>`;
  $("#mode").value = mode;
  $("#back").onclick = () => go("trip", tripId);
  $("#mode").onchange = () => go("layout", tripId, $("#mode").value);
  $("#print").onclick = () => window.print();
  const hints = { pages: "Each page is A5 (148 × 210 mm). Print at 100% / actual size.",
    duplex: "Two A5 pages per A4 landscape sheet, in booklet order. Print double-sided, flip on SHORT edge, then fold the stack in half.",
    single: "Two A5 pages per A4 sheet. Print the FRONTS, put the stack back in the tray (turned over as your printer needs), then print the BACKS. Fold in half." };
  $("#modehint").textContent = hints[mode];
  const { specs, foot } = await buildPages(t);
  const ctx = { specs, foot, interactive: true };
  const box = $("#pages"); box.innerHTML = "";
  const st = document.createElement("style"); st.id = "pagestyle";
  st.textContent = mode === "pages" ? "@page{size:148mm 210mm;margin:0}" : "@page{size:297mm 210mm;margin:0}";
  document.head.appendChild(st);
  const avail = Math.min(box.clientWidth || innerWidth, innerWidth) - 8;
  const place = (el, wmm) => { const w = wmm * MM, k = Math.min(1, avail / w); const wrap = document.createElement("div"); wrap.className = "pagewrap";
    const sb = document.createElement("div"); sb.className = "scalebox"; sb.style.transform = `scale(${k})`; sb.style.height = (A5H * MM * k) + "px"; sb.style.width = w + "px";
    sb.appendChild(el); wrap.appendChild(sb); box.appendChild(wrap); };
  const afters = [];
  if (mode === "pages") {
    for (const s of specs) { const r = await renderPage(s, t, ctx); place(r.el, A5W); afters.push(...r.after); }
  } else {
    const sheets = bookletSheets(specs);
    const sides = mode === "duplex" ? sheets.flatMap(s => [s.front, s.back]) : [...sheets.map(s => s.front), ...sheets.map(s => s.back)];
    for (const side of sides) { const sh = document.createElement("div"); sh.className = "sheet";
      for (const s of side) { const r = await renderPage(s, t, ctx); sh.appendChild(r.el); afters.push(...r.after); }
      place(sh, 297); }
  }
  for (const f of afters) await f();
};

/* ======================= backup ======================= */
async function exportTrip(t) {
  const ids = [...new Set([...t.cover, ...t.days.flatMap(d => [...(d.notes || "").matchAll(/data-pid="([^"]+)"/g)].map(m => m[1]))])];
  const photos = {};
  for (const id of ids) { const b = await getPhoto(id); if (b) photos[id] = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); }); }
  const blob = new Blob([JSON.stringify({ app: "DSR Travel Journal", version: 1, trip: t, photos })], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = (t.name || "trip").replace(/[^\w\- ]+/g, "") + ".dsrtrip.json"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function importBackup() {
  const [f] = await pickFiles($("#jsonPick"), false); if (!f) return;
  try {
    const j = JSON.parse(await f.text()); if (!j.trip) throw new Error("not a DSR Travel Journal backup");
    for (const [id, url] of Object.entries(j.photos || {})) await putPhoto(id, await (await fetch(url)).blob());
    if (await getTrip(j.trip.id) && !confirm(`“${j.trip.name}” already exists here – replace it?`)) return;
    await putTrip(j.trip); toast("Imported " + j.trip.name); render();
  } catch (e) { toast("Import failed: " + e.message, 3500); }
}

/* ======================= start ======================= */
openDB().then(render).catch(e => main.innerHTML = `<div class="card">Storage unavailable: ${esc(e.message)}</div>`);
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("service-worker.js").catch(() => {}));
