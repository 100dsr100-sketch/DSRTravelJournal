/* DSR Travel Journal - published website (blog style). Copied to the DSRTrips site on every share.
   Home page (index.html at the site root): lists trips/index.json.
   Trip page (trips/<id>/index.html): reads trip.json + <photo id>.jpg from its own folder.
   Everything is fetched with a unique ?t= because GitHub Pages lets its servers keep copies for 10 minutes. */
"use strict";
(() => {
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fresh = u => fetch(u + (u.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
const fmtDate = iso => iso ? new Date(iso + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "";
const shortDate = iso => iso ? new Date(iso + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "";
const range = (a, b) => a ? (b && b !== a ? `${shortDate(a)} – ${new Date(b + "T12:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}` : fmtDate(a)) : "";
const FONTS = { classic: 'Georgia,"Times New Roman","Noto Serif",serif', clean: '"Segoe UI",Roboto,Arial,sans-serif', hand: '"Segoe Script","Bradley Hand","Dancing Script",cursive',
  casual: '"Comic Sans MS","Coming Soon",casual,cursive', type: '"Courier New","Cutive Mono",monospace' };
const SIZES = { small: 0.9, normal: 1, large: 1.15, xl: 1.3 };
const LOGO = `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"><rect x="4" y="4" width="56" height="56" rx="12"/><path d="M14 18l12-4 12 4 12-4v32l-12 4-12-4-12 4z"/><path d="M26 14v32M38 18v32"/></svg>`;
const band = (right = "") => `<div class="band"><div class="in"><a href="${esc(ROOT)}">${LOGO}</a><a class="grow" href="${esc(ROOT)}">DSR Travel Journal</a>${right}</div></div>`;
const page = document.body.dataset.page, ROOT = page === "trip" ? "../../" : "./";

/* ---------- notes: keep only formatting the app itself produces ---------- */
const OK_TAGS = new Set("P DIV SPAN B STRONG I EM U BR UL OL LI IMG H1 H2 H3 H4 A BLOCKQUOTE FONT SMALL SUB SUP HR".split(" "));
function clean(html, base) {
  const doc = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html"), root = doc.body.firstChild;
  const walk = el => {
    for (const c of [...el.children]) {
      if (!OK_TAGS.has(c.tagName)) { c.replaceWith(...(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED"].includes(c.tagName) ? [] : c.childNodes)); continue; }
      for (const a of [...c.attributes]) {
        const n = a.name.toLowerCase(), v = a.value;
        if (n.startsWith("on") || (n === "style" && /url\(|expression|javascript:/i.test(v)) || (n === "href" && !/^https?:/i.test(v)) || !(n === "style" || n === "class" || n === "href" || n.startsWith("data-") || n === "alt" || n === "title" || n === "face" || n === "size" || n === "color")) c.removeAttribute(a.name);
      }
      if (c.tagName === "A") { c.target = "_blank"; c.rel = "noopener"; }
      if (c.tagName === "IMG") { const pid = c.dataset.pid; if (pid && /^[\w-]+$/.test(pid)) { c.src = base + pid + ".jpg"; c.loading = "lazy"; c.alt ||= ""; } else c.remove(); }
      walk(c);
    }
  };
  walk(root);
  return root.innerHTML;
}

/* ---------- maps ---------- */
const TILE = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const touch = matchMedia("(pointer:coarse)").matches;
function makeMap(el, { routes = [], points = [], view = null, caption = "" }) {
  if (!window.L) return;
  // on phones a one-finger drag scrolls the page; tap the map once to move it
  const m = L.map(el, { zoomSnap: 0.25, zoomDelta: 0.5, scrollWheelZoom: false, dragging: !touch, tap: false, attributionControl: true });
  L.tileLayer(TILE, { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(m);
  const all = [];
  for (const r of routes) {
    if (!r.coords || r.coords.length < 2) continue;
    L.polyline(r.coords, { color: r.kind === "flight" ? "#1f5fbf" : "#b3261e", weight: r.kind === "flight" ? 2.5 : 4, dashArray: r.kind === "flight" ? "6 6" : null, opacity: .9 }).addTo(m);
    all.push(...r.coords);
  }
  const seen = new Set();
  for (const p of points) {
    if (p?.lat == null || seen.has(p.name)) continue; seen.add(p.name);
    L.circleMarker([p.lat, p.lon], { radius: 6, color: "#3b2b05", fillColor: "#FFD700", fillOpacity: 1, weight: 2 }).addTo(m).bindTooltip(esc(p.name || ""), { permanent: !!p.label, direction: "top", offset: [0, -6] });
    all.push([p.lat, p.lon]);
  }
  if (view?.c) m.setView(view.c, view.z);
  else if (all.length) m.fitBounds(L.latLngBounds(all).pad(0.12), { maxZoom: 13 });
  else m.setView([30, 0], 2);
  if (caption) { const c = document.createElement("div"); c.className = "cap"; c.textContent = caption; el.appendChild(c); }
  if (touch) {
    const h = document.createElement("div"); h.className = "maphint"; h.textContent = "Tap to move the map"; el.appendChild(h);
    el.addEventListener("click", () => { m.dragging.enable(); h.remove(); }, { once: true });
  }
  return m;
}
const lazyMaps = [];
const io = "IntersectionObserver" in window ? new IntersectionObserver(es => es.forEach(e => {
  if (!e.isIntersecting) return; io.unobserve(e.target); const f = lazyMaps.find(x => x.el === e.target); f && f.draw();
}), { rootMargin: "300px" }) : null;
function mapLater(el, opts) { const job = { el, draw: () => makeMap(el, opts) }; lazyMaps.push(job); io ? io.observe(el) : job.draw(); }

/* ---------- lightbox ---------- */
/* the overlay is created on first use (drawing a page replaces <body>); one set of listeners for the page */
let lb = null, lbList = [], lbI = 0;
const lbShow = i => { lbI = (i + lbList.length) % lbList.length; $("img", lb).src = lbList[lbI]; $(".count", lb).textContent = `${lbI + 1} / ${lbList.length}`; };
const lbClose = () => lb?.classList.remove("on");
function lbMake() {
  lb = document.createElement("div"); lb.className = "lb";
  lb.innerHTML = `<img alt=""><button class="x" aria-label="Close">×</button><button class="pv" aria-label="Previous">‹</button><button class="nx" aria-label="Next">›</button><div class="count"></div>`;
  document.body.appendChild(lb);
  $(".x", lb).onclick = lbClose; $(".pv", lb).onclick = e => { e.stopPropagation(); lbShow(lbI - 1); }; $(".nx", lb).onclick = e => { e.stopPropagation(); lbShow(lbI + 1); };
  lb.onclick = e => { if (e.target === lb) lbClose(); };
  let x0 = null; lb.addEventListener("touchstart", e => x0 = e.touches[0].clientX, { passive: true });
  lb.addEventListener("touchend", e => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 50) lbShow(lbI + (dx < 0 ? 1 : -1)); x0 = null; });
}
function lightbox() {
  addEventListener("keydown", e => { if (!lb?.isConnected || !lb.classList.contains("on")) return;
    if (e.key === "Escape") lbClose(); if (e.key === "ArrowLeft") lbShow(lbI - 1); if (e.key === "ArrowRight") lbShow(lbI + 1); });
  document.addEventListener("click", e => {
    const im = e.target.closest?.("img[data-full]"); if (!im) return;
    if (!lb?.isConnected) lbMake();
    lbList = [...document.querySelectorAll("img[data-full]")].map(i => i.dataset.full).filter((u, i, a) => a.indexOf(u) === i);
    lbShow(lbList.indexOf(im.dataset.full)); lb.classList.add("on");
  });
}

/* ---------- home page ---------- */
async function home() {
  document.body.innerHTML = band() + `<main class="wrap"><div class="home-head"><h1>Our travels</h1><div class="muted ui">Journals from DSR Travel Journal</div></div><div id="list" class="ui muted">Loading…</div></main><footer>Made with DSR Travel Journal</footer>`;
  let list = [];
  try { const r = await fresh("trips/index.json"); if (r.ok) list = await r.json(); } catch {}
  list.sort((a, b) => (b.start || "").localeCompare(a.start || ""));
  $("#list").className = "";
  $("#list").innerHTML = list.length ? `<div class="cards">${list.map(t => `<a class="card" href="trips/${esc(t.id)}/">
      <div class="ph" style="${t.cover ? `background-image:url('trips/${esc(t.id)}/${esc(t.cover)}.jpg')` : ""}"></div>
      <div class="tx"><h3>${esc(t.name)}</h3><div class="d">${esc(range(t.start, t.end))}${t.days ? ` · ${t.days} day${t.days === 1 ? "" : "s"}` : ""}</div>${t.description && t.description !== t.name ? `<div class="ds">${esc(t.description)}</div>` : ""}</div></a>`).join("")}</div>`
    : `<div class="notice">No trips published yet. In DSR Travel Journal: Edit trip › Share whole trip (link).</div>`;
  document.title = "Our travels – DSR Travel Journal";
}

/* ---------- trip page ---------- */
async function trip() {
  const want = parseInt(new URLSearchParams(location.search).get("v") || "0", 36);
  document.body.innerHTML = band() + `<main class="wrap"><div class="notice" id="msg">Loading the journal…</div></main>`;
  let j, waited = 0;
  for (;;) {
    try {
      const r = await fresh("trip.json");
      if (r.status === 404) throw new Error("This journal isn't published yet – GitHub takes about a minute after sharing.");
      if (!r.ok) throw new Error("The website said " + r.status);
      j = await r.json();
    } catch (e) { if (waited < 180) { $("#msg").textContent = e.message + " Checking again…"; waited += 15; await new Promise(r => setTimeout(r, 15000)); continue; } $("#msg").textContent = e.message; return; }
    if (want && Date.parse(j.shared || 0) < want - 2000 && waited < 180) {
      $("#msg").textContent = "GitHub is still publishing the newest version (usually about a minute) – checking again in 15 s…";
      waited += 15; await new Promise(r => setTimeout(r, 15000)); continue;
    }
    break;
  }
  const t = j.trip, days = [...t.days].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const id = location.pathname.replace(/\/(index\.html)?$/, "").split("/").pop();
  const cover = (t.cover || []).filter(p => /^[\w-]+$/.test(p));
  const km = days.reduce((n, d) => n + (+d.route?.km || 0), 0);
  const allPhotos = (j.photos || []).filter(p => /^[\w-]+$/.test(p));
  const app = j.appUrl ? `${j.appUrl}#get/${encodeURIComponent(j.repo || "DSRTrips")}/${encodeURIComponent(id)}${j.shared ? "/" + Date.parse(j.shared).toString(36) : ""}` : "";
  document.title = `${t.name} – DSR Travel Journal`;
  document.documentElement.style.setProperty("--jf", FONTS[t.font?.family] || FONTS.classic);
  document.documentElement.style.setProperty("--js", SIZES[t.font?.size] || 1);

  const dayHtml = (d, i) => {
    const route = [d.from?.name, d.to?.name].filter(Boolean).join(" → ");
    const w = d.weather ? (d.weather.text || `${d.weather.min}–${d.weather.max}°C ${d.weather.summary || ""}`) : "";
    const facts = [["Travel", route + (d.route?.km ? ` · ${d.route.km} km` : "")], ["Weather", w], ["Stay", [d.motel, d.room && "room " + d.room].filter(Boolean).join(", ")], ["Room", d.roomDesc], ["Highlight", d.highlight],
      ["Rating", d.rating ? "★".repeat(d.rating) + "☆".repeat(5 - d.rating) : ""]].filter(f => f[1]?.trim());
    const hasMap = d.route?.coords?.length > 1 || d.from?.lat != null || d.to?.lat != null;
    return `<section class="day" id="day-${i + 1}">
      <div class="eyebrow">Day ${i + 1}</div><h2>${esc(d.title || fmtDate(d.date))}</h2><div class="date">${esc(fmtDate(d.date))}</div>
      ${facts.length ? `<ul class="facts">${facts.map(f => `<li><b>${f[0]}</b>${esc(f[1])}</li>`).join("")}</ul>` : ""}
      ${hasMap ? `<div class="map" data-day="${i}"></div>` : ""}
      <div class="notes">${clean(d.notes, "")}</div></section>`;
  };
  document.body.innerHTML = band(app ? `<a class="small" href="${esc(app)}">+ Add to my journal</a>` : "") + `
    <header class="hero${cover.length ? "" : " plain"}" style="${cover.length ? `background-image:url('${esc(cover[0])}.jpg')` : ""}"><div class="in">
      <h1>${esc(t.name)}</h1>${t.description && t.description !== t.name ? `<p class="sub">${esc(t.description)}</p>` : ""}
      <div class="meta">${esc(range(t.start || days[0]?.date, t.end || days[days.length - 1]?.date))} · ${days.length} day${days.length === 1 ? "" : "s"}${km ? ` · ${Math.round(km).toLocaleString()} km` : ""}${allPhotos.length ? ` · ${allPhotos.length} photo${allPhotos.length === 1 ? "" : "s"}` : ""}</div>
      ${cover.length > 1 ? `<div class="strip">${cover.map(p => `<img src="${esc(p)}.jpg" data-full="${esc(p)}.jpg" alt="">`).join("")}</div>` : ""}
    </div></header>
    <main class="wrap">
      <nav class="toc"><h2>The journey</h2><ol>${days.map((d, i) => `<li><a href="#day-${i + 1}"><span class="n">Day ${i + 1} · ${esc(shortDate(d.date))}</span><span>${esc(d.title || "")}</span></a></li>`).join("")}</ol></nav>
      ${days.some(d => d.route?.coords?.length > 1) ? `<h2 class="sec-title" style="margin-top:30px">The whole trip</h2><div class="map big" id="tripmap"></div>` : ""}
      ${days.map(dayHtml).join('<hr class="sep">')}
      ${allPhotos.length ? `<hr class="sep"><h2 class="sec-title" id="photos">All photos</h2><div class="gallery">${allPhotos.map(p => `<img src="${esc(p)}.jpg" data-full="${esc(p)}.jpg" loading="lazy" alt="">`).join("")}</div>` : ""}
      ${app ? `<div class="actions"><a class="btn solid" href="${esc(app)}">+ Add this trip to my DSR Travel Journal</a><a class="btn" href="${esc(ROOT)}">All our trips</a></div>` : ""}
    </main>
    <footer>Made with DSR Travel Journal${j.shared ? ` · updated ${esc(new Date(j.shared).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }))}` : ""}</footer>`;

  // photos in the notes open full screen too
  document.querySelectorAll(".notes img[data-pid]").forEach(im => im.dataset.full = im.getAttribute("src"));
  // note maps (a place the author pinned), sized like in the app
  document.querySelectorAll(".notes .nmap").forEach(m => {
    const pct = Math.max(25, Math.min(100, +m.dataset.w || 100)), al = m.dataset.al || "center";
    m.innerHTML = ""; m.style.width = pct + "%"; m.style.aspectRatio = String(+(1.5 + (pct - 45) / 55 * 0.9).toFixed(2));
    m.style.float = al === "center" ? "none" : al; m.style.margin = al === "center" ? "8px auto" : al === "left" ? "6px 14px 10px 0" : "6px 0 10px 14px";
    const plat = +(m.dataset.plat ?? m.dataset.lat), plon = +(m.dataset.plon ?? m.dataset.lon);
    if (!isNaN(plat)) mapLater(m, { points: [{ lat: plat, lon: plon, name: m.dataset.name, label: true }], view: { c: [+m.dataset.lat, +m.dataset.lon], z: +m.dataset.z || 12 } });   // the pin's label names the place
  });
  // day maps - the author's framing when they set one, otherwise fitted to the route
  document.querySelectorAll(".map[data-day]").forEach(el => {
    const d = days[+el.dataset.day];
    mapLater(el, { routes: d.route?.coords?.length > 1 ? [{ kind: d.route.kind, coords: d.route.coords }] : [], points: [d.from, d.to].filter(p => p?.lat != null).map(p => ({ ...p, label: true })), view: d.mapView });
  });
  if ($("#tripmap")) mapLater($("#tripmap"), {
    routes: days.filter(d => d.route?.coords?.length > 1).map(d => ({ kind: d.route.kind, coords: d.route.coords })),
    points: days.flatMap(d => [d.from, d.to]).filter(p => p?.lat != null).map(p => ({ ...p, label: false })) });
  if (location.hash) setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView(), 300);
}

lightbox();
(page === "trip" ? trip : home)().catch(e => { document.body.innerHTML = band() + `<main class="wrap"><div class="notice">Something went wrong: ${esc(e.message)}</div></main>`; });
})();
