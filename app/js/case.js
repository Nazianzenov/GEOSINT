/* GeOSINT Workbench — case engine (evidence log / chain-of-custody, dossier,
   case-file save/load, autosave, recent cases, sample case). Split from app.js
   per #31; classic <script> sharing global scope, loaded before the bootstrap. */

/* ═══════════════════════════ ARTIFACTS (case v2) ═══════════════════════════
   Append-only evidence log. Every item the analyst pulls in (an image, a logged
   observation) becomes an artifact with a timestamp and provenance, so the case
   can drive a timeline, a sourced dossier and a chain-of-custody
   view. Images store a SHA-256 of the ORIGINAL bytes + a small thumbnail
   — never the full image. All local: crypto.subtle and canvas, nothing uploaded.

   Artifact shape:
     { id, kind: 'image'|'note'|'point'|'obs',
       t: ISO8601 (observed/added time), source, sha256?, ll?, text?, thumb?,
       meta? }                                                                    */
let _artId = 0;
const _artPending = new Set();   // in-flight logImageArtifact() promises; saveCase awaits them

/* SHA-256 of a Blob/ArrayBuffer/string → lowercase hex. Uses the Web Crypto API
   (local, no network). */
async function sha256(input) {
  const buf = input instanceof Blob ? await input.arrayBuffer()
            : typeof input === "string" ? new TextEncoder().encode(input)
            : input;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* Render a small JPEG thumbnail (base64 data URL) from an image File, longest
   side `max` px. Returns null if the file can't be decoded. Drawn on a canvas
   entirely in-browser. */
function makeThumbnail(file, max = 160) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      try { resolve(cv.toDataURL("image/jpeg", 0.7)); }
      catch { resolve(null); }                 // tainted canvas etc.
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

/* Append an artifact; defaults id + time. Returns the stored artifact. */
function addArtifact(a) {
  const art = { id: ++_artId, t: a.t || new Date().toISOString(), ...a };
  state.artifacts.push(art);
  renderEvidenceLog();
  markDirty();
  return art;
}

/* Pull the first "lat, lng" pair out of arbitrary text/URL (so a pasted
   permalink like ".../@48.8584,2.2945,17z" or "view 48.8584, 2.2945" yields
   coords). Returns [lat,lng] or null. */
function coordsFromText(s) {
  if (!s) return null;
  // Require a decimal point in BOTH numbers — real GPS pairs have them, which
  // avoids false matches on incidental integer pairs (zoom levels, versions,
  // "1, 2"). Lat/lng must also be in range.
  const m = String(s).match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  if (!m) return null;
  const lat = +m[1], lng = +m[2];
  return (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) ? [lat, lng] : null;
}

/* Log an external/identified finding as an observation artifact (9A.1/9A.2/9A.4).
   `source` may be a URL or free text; coords are parsed from it when not given. */
function logObservation({ text, source, ll, t }) {
  if (!ll && source) ll = coordsFromText(source);   // lift coords out of the pasted text/URL
  if (!ll && text) ll = coordsFromText(text);
  // If the only "text" is a bare URL, keep the URL in `source` (which redaction
  // strips) and use a generic label as the text, so a redacted dossier doesn't
  // leak the URL through the finding's text.
  const isUrl = (v) => /^https?:\/\//i.test(String(v || ""));
  let label = text;
  if (!label || isUrl(label)) label = isUrl(source) || isUrl(text) ? "external finding" : (text || "observation");
  const realSource = source || (isUrl(text) ? text : undefined);
  const art = addArtifact({
    kind: "obs",
    t: t || new Date().toISOString(),
    text: label,
    source: realSource || undefined,
    ll: ll || undefined,
  });
  status(`logged to case: ${esc(art.text).slice(0, 40)}`, false, 3000);
  if (ll) state.imgLayer.addLayer(L.circleMarker(L.latLng(ll[0], ll[1]),
    { radius: 6, color: "#d2a8ff", fillColor: "#d2a8ff", fillOpacity: .6 }).bindTooltip(esc(art.text)));
  return art;
}

/* 9A.4 — pin a plotted overlay feature into the case as an observation. Called
   from the feature popup by registry index (no attacker-controlled string in an
   inline handler). */
function pinFeature(idx) {
  const f = (state._plotted || [])[idx];
  if (!f) return;
  const tagStr = Object.entries(f.tags || {}).slice(0, 4).map(([k, v]) => `${k}=${v}`).join(", ");
  logObservation({
    text: `${f.name}${tagStr ? ` (${tagStr})` : ""}`,
    source: `OSM ${f.type}/${f.id}`,
    ll: [f.lat, f.lon],
  });
}
window.pinFeature = pinFeature;

/* Build a plotted-feature popup as a DOM element with wired listeners — no inline
   onclick (which needed window.setPoint, that was never exported, so the "set
   active point" link silently did nothing) and no string-injection surface. */
function featurePopup({ lat, lon, name, type, id, idx }) {
  const el = document.createElement("div");
  el.innerHTML =
    `<b>${esc(name)}</b><br><span class="mono">${lat.toFixed(5)}, ${lon.toFixed(5)}</span><br>` +
    `<a href="https://www.openstreetmap.org/${esc(type)}/${esc(id)}" target="_blank" rel="noopener">OSM object</a> · ` +
    `<a href="#" class="fp-set">set active point</a> · ` +
    `<a href="#" class="fp-pin">📌 pin to case</a>`;
  el.querySelector(".fp-set").addEventListener("click", (e) => {
    e.preventDefault(); setPoint(L.latLng(lat, lon), { fly: true });
  });
  el.querySelector(".fp-pin").addEventListener("click", (e) => {
    e.preventDefault(); pinFeature(idx);
  });
  return el;
}

/* Minimal popup: a title, a subtitle, coords, and a wired "set active point". */
function setPointPopup(title, subtitle, lat, lng) {
  const el = document.createElement("div");
  el.innerHTML = `<b>${esc(title)}</b><br>${esc(subtitle)}` +
    `<br><span class="mono">${lat.toFixed(5)}, ${lng.toFixed(5)}</span>` +
    `<br><a href="#" class="fp-set">set active point</a>`;
  el.querySelector(".fp-set").addEventListener("click", (e) => {
    e.preventDefault(); setPoint(L.latLng(lat, lng), { fly: true });
  });
  return el;
}

/* Pick up a chronolocation finding sent from the Sun & Shadow Studio (separate
   tab) via a shared localStorage key. Called on load + when the workbench regains
   focus. Logs it as a sourced observation, sets the active point, and adopts the
   solver result so the dossier's "Chronolocation finding" reflects the Studio. */
const STUDIO_HANDOFF_KEY = "geosint:studio-finding";
function ingestStudioFinding() {
  let r;
  try {
    const raw = localStorage.getItem(STUDIO_HANDOFF_KEY);
    if (!raw) return;
    localStorage.removeItem(STUDIO_HANDOFF_KEY);   // consume once
    r = JSON.parse(raw);
  } catch { return; }
  if (!r || !r.loc) return;
  // Validate the (possibly tampered/malformed) handoff before it reaches setPoint/
  // .toFixed()/.join() downstream — a NaN coord or non-array windows would throw
  // and break the custody/timeline/dossier renders.
  const lat = +r.loc.lat, lng = +r.loc.lng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
  const windows = Array.isArray(r.windows) ? r.windows.map(String) : [];
  state.solverResult = {              // shape the dossier/buildDossier already reads
    status: r.status, confidence: r.confidence, why: r.why, tol: r.tol,
    windows, twoShadow: false,
  };
  const summary = r.status === "inconsistent"
    ? `Chronolocation: claim inconsistent (${r.confidence} confidence)`
    : `Chronolocation: ${windows.join(", ")} local (${r.confidence} confidence)`;
  logObservation({ text: summary, ll: [lat, lng], source: "Sun & Shadow Studio" });
  setPoint(L.latLng(lat, lng), { fly: true, zoom: 14 });
  status("chronolocation finding received from the Studio — logged to the case", false, 6000);
}

/* Evidence-log readout + chain-of-custody table in the notes drawer.
   Confirms capture is happening, originals are not stored, and gives a
   defensible, exportable provenance record. */
const ART_SYM = { image: "🖼", note: "📝", point: "📍", obs: "👁" };

function renderEvidenceLog() {
  const el = $("#evidence-log"), wrap = $("#custody-wrap");
  if (!el) return;
  const arts = state.artifacts;
  if (!arts.length) {
    el.textContent = "";
    if (wrap) wrap.hidden = true;
    return;
  }
  const imgs = arts.filter((a) => a.kind === "image").length;
  const withGps = arts.filter((a) => a.ll).length;
  el.textContent = `🔒 evidence log: ${arts.length} artifact(s) · ${imgs} image(s) · ${withGps} geotagged `
    + `— SHA-256 + thumbnail only, originals stay on disk`;
  renderCustodyTable();
  if (wrap) wrap.hidden = false;
}

/* Append-only custody table: observed time, kind, source, sha-256 (short), GPS.
   Sorted by observed time (the chronological provenance record). */
function renderCustodyTable() {
  const t = $("#custody-table");
  if (!t) return;
  const arts = [...state.artifacts].sort((a, b) => String(a.t).localeCompare(String(b.t)));
  const short = (h) => h ? `<span title="${esc(h)}" style="font-family:monospace">${esc(h.slice(0, 10))}…</span>` : "—";
  const nLinks = (a) => (a.links && a.links.length) ? ` <span class="muted">🔗${a.links.length}</span>` : "";
  t.innerHTML = `<tr><th>observed</th><th>kind</th><th>source</th><th>sha-256</th><th>GPS</th><th></th></tr>` +
    arts.map((a) => `<tr>
      <td>${esc(String(a.t).replace("T", " ").slice(0, 19))}</td>
      <td>${ART_SYM[a.kind] || "•"} ${esc(a.kind)}${nLinks(a)}</td>
      <td title="${esc(a.source || "")}">${esc((a.source || "—").slice(0, 28))}</td>
      <td>${short(a.sha256)}</td>
      <td>${a.ll ? `${a.ll[0].toFixed(4)}, ${a.ll[1].toFixed(4)}` : "—"}</td>
      <td class="art-link-cell"><a href="#" class="art-link" data-id="${a.id}" title="Link this artifact to another (builds the case relationship graph)">🔗</a></td>
    </tr>`).join("");
  t.querySelectorAll(".art-link").forEach((el) =>
    el.addEventListener("click", (e) => { e.preventDefault(); openLinkPicker(+el.dataset.id, el.closest(".art-link-cell")); }));
}

const artLabel = (a) => (a.text || a.source || a.kind || `#${a.id}`).slice(0, 40);

/* 9A.3 — link one artifact to another so the case becomes a graph (rendered as a
   Relationships section in the dossier). In-app inline picker (no blocking
   prompt): the action cell becomes a <select> of the other artifacts + confirm,
   so the analyst picks by label rather than typing an id. */
function openLinkPicker(fromId, cell) {
  const arts = state.artifacts;
  const from = arts.find((a) => a.id === fromId);
  if (!from || !cell) return;
  const others = arts.filter((a) => a.id !== fromId);
  if (!others.length) return status("Need a second artifact to link to.", true);
  cell.innerHTML =
    `<select class="art-link-sel" aria-label="Link to artifact">` +
    others.map((a) => `<option value="${a.id}">${esc(artLabel(a))}</option>`).join("") +
    `</select> <a href="#" class="art-link-ok" title="Confirm link">✓</a> ` +
    `<a href="#" class="art-link-cancel" title="Cancel">✕</a>`;
  const sel = cell.querySelector(".art-link-sel");
  sel.focus();
  cell.querySelector(".art-link-ok").addEventListener("click", (e) => {
    e.preventDefault();
    const toId = +sel.value;
    from.links = from.links || [];
    if (!from.links.includes(toId)) from.links.push(toId);
    renderCustodyTable();
    markDirty();
    status("artifacts linked");
  });
  cell.querySelector(".art-link-cancel").addEventListener("click", (e) => {
    e.preventDefault(); renderCustodyTable();
  });
}

/* Chain-of-custody serializers — pure (no DOM/download), so they're unit-testable.
   CSV = a flat provenance table for a report appendix; rows sorted by observed
   time, every field RFC-4180 quoted. */
/* custodyCsv / custodyJson are pure serializers and live in coreutils.js (#89),
   loaded before this file; they remain available as bare globals. */

function exportCustody(fmt) {
  const arts = state.artifacts;
  if (!arts.length) return status("evidence log is empty", true);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const csv = fmt === "csv";
  const body = csv ? custodyCsv(arts) : custodyJson(arts);
  const ext = csv ? "csv" : "json";
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type: csv ? "text/csv" : "application/json" }));
  a.download = `custody-${stamp}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  status(`exported ${arts.length} custody record(s) as ${ext.toUpperCase()}`);
}

/* ── timeline ──
   Chronological strip of every dated artifact plus case-context events (the
   weather date and the Sun module's date), so a sequence-of-events reads off
   one view. Each event carries an optional location → ⌖ jump-to-map. */
function timelineEvents() {
  const ev = [];
  for (const a of state.artifacts) {
    ev.push({ t: a.t, kind: a.kind, sym: ART_SYM[a.kind] || "•",
              label: a.source || a.text || a.kind,
              detail: a.kind === "image" ? (a.meta && a.meta.camera || "") : (a.text || ""),
              ll: a.ll || null, thumb: a.thumb || null,
              sha: a.sha256 || null });
  }
  // case-context events from module inputs (date-only → noon, for ordering)
  const sunDt = val("#sun-dt");
  if (sunDt) ev.push({ t: sunDt.length === 16 ? sunDt + ":00" : sunDt, kind: "context",
                       sym: "☀", label: "Sun & Shadow date", detail: "chronolocation reading",
                       ll: state.point ? [state.point.lat, state.point.lng] : null });
  const wxDate = val("#wx-date");
  if (wxDate) ev.push({ t: wxDate + "T12:00:00", kind: "context",
                        sym: "☁", label: "Weather date", detail: "meteorology lookup",
                        ll: state.point ? [state.point.lat, state.point.lng] : null });
  // sort ascending by parseable time; unparseable sink to the bottom
  const key = (e) => { const d = Date.parse(String(e.t).replace(" ", "T")); return isNaN(d) ? Infinity : d; };
  return ev.sort((a, b) => key(a) - key(b));
}

function openTimeline() {
  const panel = $("#timeline-panel"), body = $("#timeline-body");
  const ev = timelineEvents();
  $("#timeline-stats").textContent = ev.length ? `${ev.length} event(s)` : "";
  if (!ev.length) {
    body.innerHTML = `<p class="hint" style="padding:10px">No dated events yet — drop an image, or set the weather/sun dates.</p>`;
  } else {
    const fmtT = (t) => { const d = new Date(String(t).replace(" ", "T")); return isNaN(d) ? esc(String(t)) : d.toISOString().replace("T", " ").slice(0, 16); };
    body.innerHTML = `<div class="tl">${ev.map((e, i) => `
      <div class="tl-row" data-i="${i}">
        <div class="tl-time">${fmtT(e.t)}</div>
        <div class="tl-dot">${e.sym}</div>
        <div class="tl-card">
          <div class="tl-label"><b>${esc(e.label)}</b>${e.detail ? ` <span class="muted">· ${esc(e.detail)}</span>` : ""}</div>
          ${dataThumb(e.thumb) ? `<img src="${esc(dataThumb(e.thumb))}" alt="evidence thumbnail" style="max-width:120px;border-radius:3px;margin:4px 0">` : ""}
          ${e.sha ? `<div class="muted" style="font-family:monospace;font-size:11px">sha256 ${esc(e.sha.slice(0, 16))}…</div>` : ""}
          ${e.ll ? `<a href="#" class="tl-go" data-i="${i}">⌖ ${e.ll[0].toFixed(4)}, ${e.ll[1].toFixed(4)}</a>` : ""}
        </div>
      </div>`).join("")}</div>`;
    body.querySelectorAll(".tl-go").forEach((el) => el.onclick = (e) => {
      e.preventDefault();
      const ll = ev[+el.dataset.i].ll;
      if (ll) { setPoint(L.latLng(ll[0], ll[1]), { fly: true, zoom: 15 }); }
    });
  }
  panel.hidden = false;
}


/* Fire-and-forget capture that's still safe to SAVE against: the promise is
   tracked in _artPending and awaited by saveCase, so a case saved right after a
   drop never loses the just-dropped image. */
function captureImage(file, ex) {
  const p = logImageArtifact(file, ex).catch(() => null).finally(() => _artPending.delete(p));
  _artPending.add(p);
}

/* Record a dropped image as an evidence artifact (sha-256 of original bytes +
   thumbnail + the parsed EXIF facts we already have). Deduped by hash so the
   same file dropped twice doesn't double-log. `ex` is the exifr result (or null). */
async function logImageArtifact(file, ex) {
  let hash = null;
  try { hash = await sha256(file); } catch { /* crypto unavailable — log without */ }
  if (hash && state.artifacts.some((a) => a.kind === "image" && a.sha256 === hash)) return null;
  const thumb = await makeThumbnail(file);
  return addArtifact({
    kind: "image",
    t: ex && ex.DateTimeOriginal ? new Date(ex.DateTimeOriginal).toISOString() : new Date().toISOString(),
    source: file.name,
    sha256: hash,
    ll: (ex && ex.latitude != null && ex.longitude != null) ? [ex.latitude, ex.longitude] : undefined,
    thumb: thumb || undefined,
    meta: {
      added: new Date().toISOString(),
      size: file.size,
      camera: ex ? [ex.Make, ex.Model].filter(Boolean).join(" ") || undefined : undefined,
      taken: ex && ex.DateTimeOriginal ? new Date(ex.DateTimeOriginal).toISOString() : undefined,
    },
  });
}

/* ═══════════════════════════ CASE FILE ═════════════════════════ */
/* Save/restore the whole workspace to a local .geosint.json — point, map view,
   measure shapes, active data/GBIF layers, every module's inputs, notes, and
   the v2 artifacts evidence log.
   Pure client-side: the file never leaves the machine. */
const CASE_VERSION = 2;
const val = (sel) => { const el = $(sel); return el ? el.value : undefined; };
const setVal = (sel, v) => { const el = $(sel); if (el && v != null) el.value = v; };

function serializeCase() {
  const c = state.map.getCenter();
  return {
    app: "geosint-workbench", version: CASE_VERSION,
    saved: new Date().toISOString(),
    point: state.point ? { lat: state.point.lat, lng: state.point.lng } : null,
    view: { lat: c.lat, lng: c.lng, zoom: state.map.getZoom() },
    module: state.module || null,
    measure: state.measure.pts.map((p) => [p.lat, p.lng]),
    annos: (state.annos || []).map((a) => ({ type: a.type, ll: a.ll, ll2: a.ll2, text: a.text })),
    gbif: Object.entries(state.gbifLayers).map(([key, tl]) => ({ key: +key, name: tl._caseName || "" })),
    data: state.lastData ? { label: state.lastData.label } : null,
    notes: val("#case-notes") || "",
    artifacts: state.artifacts,

    inputs: {
      sunDt: val("#sun-dt"), sunOffset: val("#sun-offset"),
      solverAz: val("#solver-az"), solverRatio: val("#solver-ratio"), solverTol: val("#solver-tol"),
      solverAz2: val("#solver-az2"), solverRatio2: val("#solver-ratio2"), solverDt2: val("#solver-dt2"),
      wxDate: val("#wx-date"), imgUrl: val("#img-url"),
      dataPreset: val("#data-preset"), dataCustom: val("#data-custom"), gbifName: val("#gbif-name"),
    },
  };
}

async function saveCase() {
  // Let any in-flight image captures (hash + thumbnail) finish so a case saved
  // right after a drop includes the just-dropped evidence.
  if (_artPending.size) {
    status("finalizing evidence log…", false, 1500);
    await Promise.all([..._artPending]);
  }
  const caseObj = serializeCase();
  const data = JSON.stringify(caseObj, null, 1);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");  // second precision: distinct saves get distinct names
  const fname = `case-${stamp}.geosint.json`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  a.download = fname;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  clearAutosave();                                // durable copy exists; drop the snapshot
  recordRecent(caseObj, fname);                   // add to the in-app recent list
  status("case saved to your Downloads folder");
}

/* Validate + coerce an untrusted case object (hand-edited, truncated, or from a
   different version) into one applyCase can apply without producing NaN/half-
   applied state. A case file is the one place untrusted structured data enters
   the app, so every geometry field is range-checked here; malformed sections are
   dropped (not fatal — we load the valid parts) and counted so the user is told.
   Returns { case: cleaned, dropped: [reasons] }, or null if it isn't a case. */
function sanitizeCase(c) {
  if (!c || typeof c !== "object" || c.app !== "geosint-workbench") return null;
  const dropped = [];
  // Coerce only real numbers / non-empty numeric strings. Critically, reject
  // null/""/[]/booleans — unary + turns those into 0, which would sneak a bogus
  // 0,0 coordinate past the range checks below.
  const num = (v) => {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "") { const n = +v; return Number.isNaN(n) ? NaN : n; }
    return NaN;
  };
  const lat = (v) => { const n = num(v); return Number.isFinite(n) && Math.abs(n) <= 90 ? n : null; };
  const lng = (v) => { const n = num(v); return Number.isFinite(n) && Math.abs(n) <= 180 ? n : null; };
  const ll  = (a) => Array.isArray(a) && lat(a[0]) !== null && lng(a[1]) !== null ? [lat(a[0]), lng(a[1])] : null;

  const out = {
    app: c.app, version: c.version,
    saved: typeof c.saved === "string" ? c.saved : null,
    notes: typeof c.notes === "string" ? c.notes : "",
    module: typeof c.module === "string" ? c.module : null,
    inputs: (c.inputs && typeof c.inputs === "object") ? c.inputs : {},
    artifacts: Array.isArray(c.artifacts) ? c.artifacts : [],
  };

  // active point
  if (c.point != null) {
    const la = lat(c.point.lat), lo = lng(c.point.lng);
    if (la !== null && lo !== null) out.point = { lat: la, lng: lo };
    else dropped.push("active point (out of range)");
  }
  // map view (zoom 0–24; default if absent/bad)
  if (c.view != null) {
    const la = lat(c.view.lat), lo = lng(c.view.lng), z = num(c.view.zoom);
    if (la !== null && lo !== null) out.view = { lat: la, lng: lo, zoom: Number.isFinite(z) ? Math.max(0, Math.min(24, z)) : 13 };
    else dropped.push("map view (out of range)");
  }
  // measure points — keep only valid [lat,lng] pairs
  if (Array.isArray(c.measure)) {
    out.measure = c.measure.map(ll).filter(Boolean);
    if (out.measure.length !== c.measure.length) dropped.push(`${c.measure.length - out.measure.length} measure point(s)`);
  } else out.measure = [];
  // annotations — need a valid ll, and arrows also a valid ll2
  if (Array.isArray(c.annos)) {
    const before = c.annos.length;
    out.annos = c.annos.filter((a) => a && ll(a.ll) && (a.type !== "arrow" || ll(a.ll2)))
      .map((a) => ({ type: a.type, ll: ll(a.ll), ll2: ll(a.ll2), text: typeof a.text === "string" ? a.text : "" }));
    if (out.annos.length !== before) dropped.push(`${before - out.annos.length} annotation(s)`);
  } else out.annos = [];
  // gbif overlays — keyed by a numeric taxon key (name is cosmetic, may be "")
  out.gbif = Array.isArray(c.gbif)
    ? c.gbif.filter((g) => g && Number.isFinite(num(g.key))).map((g) => ({ key: num(g.key), name: String(g.name || "") }))
    : [];

  return { case: out, dropped };
}

function applyCase(raw) {
  const v = sanitizeCase(raw);
  if (!v) return status("not a GeOSINT case file", true);
  const c = v.case;
  // notes + every field first (so module renders pick them up)
  setVal("#case-notes", c.notes || "");
  // evidence log (v2). Rehydrate _artId past the loaded max so new artifacts
  // don't collide with restored ids.
  state.artifacts = c.artifacts;
  _artId = state.artifacts.reduce((m, a) => Math.max(m, (a && a.id) || 0), 0);
  renderEvidenceLog();
  const f = c.inputs;
  setVal("#sun-dt", f.sunDt); setVal("#sun-offset", f.sunOffset);
  setVal("#solver-az", f.solverAz); setVal("#solver-ratio", f.solverRatio); setVal("#solver-tol", f.solverTol);
  setVal("#solver-az2", f.solverAz2); setVal("#solver-ratio2", f.solverRatio2); setVal("#solver-dt2", f.solverDt2);
  setVal("#wx-date", f.wxDate); setVal("#img-url", f.imgUrl);
  setVal("#data-preset", f.dataPreset); setVal("#data-custom", f.dataCustom); setVal("#gbif-name", f.gbifName);
  renderUrlButtons();

  // map view + active point (validated above — never NaN)
  if (c.view) state.map.setView([c.view.lat, c.view.lng], c.view.zoom);
  if (c.point) setPoint(L.latLng(c.point.lat, c.point.lng));

  // measure shapes
  clearMeasure();
  if (c.measure.length) {
    toggleMeasure(true);
    state.measure.pts = c.measure.map(([lat, lng]) => L.latLng(lat, lng));
    renderMeasure();
  }

  // annotations (rebuild from stored geometry + text)
  clearAnnos();
  c.annos.forEach((a) => addAnno({ type: a.type, ll: a.ll, ll2: a.ll2, text: a.text }));

  // GBIF overlays (re-add by stored taxon key + name)
  Object.values(state.gbifLayers).forEach((tl) => state.map.removeLayer(tl));
  state.gbifLayers = {};
  $("#gbif-active").innerHTML = "";
  c.gbif.forEach((g) => gbifOverlay(g.name, g.key));

  if (c.module) openModule(c.module);
  const drop = v.dropped.length ? ` — skipped ${v.dropped.join(", ")}` : "";
  status(`case loaded${c.saved ? " (saved " + c.saved.slice(0, 16).replace("T", " ") + ")" : ""}${drop}`, v.dropped.length > 0);
}

function loadCase(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const c = JSON.parse(reader.result);
      applyCase(c);
      clearAutosave();
      recordRecent(c, file.name);                  // a loaded file is now a working case
    } catch { status("could not parse case file", true); }
  };
  reader.readAsText(file);
}

/* ── recent cases ──────────────────────────────────────────────
   A small local index of saved/loaded cases so you can reopen one in-app
   (no file re-pick). Stores the full snapshot per entry; capped + quota-safe.
   100% local (localStorage). The browser can't reopen files by path, so this
   keeps the snapshots itself. */
const RECENT_KEY = "geosint:recent";
const RECENT_MAX = 8;

function readRecent() {
  try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function writeRecent(list) {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); return true; }
  catch {
    // Quota: drop oldest snapshots (tombstone), then oldest entries, until it fits.
    const trimmed = list.slice();
    for (let i = trimmed.length - 1; i >= 0; i--) {
      if (trimmed[i].snapshot) { trimmed[i] = { ...trimmed[i], snapshot: null }; }
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(trimmed)); return true; } catch { /* keep trimming */ }
    }
    while (trimmed.length) {
      trimmed.pop();
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(trimmed)); return true; } catch { /* keep popping */ }
    }
    return false;
  }
}

function recordRecent(caseObj, name) {
  if (!caseObj || caseObj.app !== "geosint-workbench") return;
  if (!lsAvailable()) return;
  const entry = {
    id: Date.now(),
    name: (name || `case ${new Date().toISOString().slice(0, 16).replace("T", " ")}`).replace(/\.geosint\.json$/i, ""),
    saved: caseObj.saved || new Date().toISOString(),
    point: caseObj.point ? `${caseObj.point.lat.toFixed(4)}, ${caseObj.point.lng.toFixed(4)}` : null,
    counts: { annos: (caseObj.annos || []).length, artifacts: (caseObj.artifacts || []).length,
              measure: (caseObj.measure || []).length },
    snapshot: caseObj,
  };
  let list = readRecent().filter((e) => e.name !== entry.name);   // dedupe by name
  list.unshift(entry);
  if (list.length > RECENT_MAX) list = list.slice(0, RECENT_MAX);
  writeRecent(list);
}

function renderRecentMenu() {
  const menu = $("#recent-menu");
  const list = readRecent();
  let html = list.map((e, i) => {
    const tomb = !e.snapshot;
    const meta = [e.point || "no point",
      `${e.counts ? e.counts.annos : 0}📌 ${e.counts ? e.counts.artifacts : 0}🖼`,
      (e.saved || "").slice(0, 16).replace("T", " ")].join(" · ");
    return `<div class="rc-item${tomb ? " tomb" : ""}" data-i="${i}"${tomb ? ' title="Snapshot dropped to save space — use ⭱ LOAD to open the file"' : ""}>
      <div class="rc-name">${esc(e.name)}${tomb ? " (file only)" : ""}</div>
      <div class="rc-meta">${esc(meta)}</div></div>`;
  }).join("");
  if (!list.length) html = `<div class="rc-empty">No recent cases yet — save one with ⭳ SAVE.</div>`;
  html += `<div class="rc-open" data-open="1">⭱ Open a case file…</div>`;
  menu.innerHTML = html;
  menu.querySelectorAll(".rc-item[data-i]").forEach((el) => el.addEventListener("click", () => {
    const e = list[+el.dataset.i];
    closeRecentMenu();
    if (e.snapshot) { applyCase(e.snapshot); clearAutosave(); }
    else { status("snapshot was dropped to save space — opening file picker", false, 4000); $("#case-file").click(); }
  }));
  menu.querySelector("[data-open]").addEventListener("click", () => { closeRecentMenu(); $("#case-file").click(); });
}

function openRecentMenu() { renderRecentMenu(); $("#recent-menu").hidden = false; }
function closeRecentMenu() { $("#recent-menu").hidden = true; }
function toggleRecentMenu() { $("#recent-menu").hidden ? openRecentMenu() : closeRecentMenu(); }

/* ── bundled sample case + first-run onboarding ─────────────────
   A real, self-contained demo case that teaches the verification spine.
   No network, no external file — loaded via the existing applyCase(). */
const SAMPLE_CASE = {
  app: "geosint-workbench", version: 2,
  saved: "(bundled sample)",
  point: { lat: -33.85679, lng: 151.21528 },        // Sydney Opera House
  view: { lat: -33.8568, lng: 151.2153, zoom: 17 },
  module: null,
  measure: [],
  annos: [
    { type: "pin", ll: [-33.85679, 151.21528], text: "Claimed location: the sail-shell roof" },
    { type: "label", ll: [-33.8575, 151.2140], text: "Cross-check: harbour bridge to the NW" },
  ],
  gbif: [], data: null,
  notes: [
    "SAMPLE CASE — Sydney Opera House (a worked example of the verification spine).",
    "",
    "The workflow GeOSINT is built around:",
    "1. IMAGE [3] — drop a photo. Local EXIF gives GPS (→ jump to map) and a",
    "   timestamp (auto-fills Sun & Weather). No EXIF? Recover the embedded",
    "   preview and reverse-search the pixels.",
    "2. Map — set/confirm the active point (already set here). Right-click to copy",
    "   DD/DMS/MGRS/UTM/Plus, or open Street View / Google Earth centred here.",
    "3. SUN [1] — verify a claimed time from shadows; the shadow solver inverts a",
    "   shadow azimuth + length ratio into matching time windows (or proves the",
    "   claim impossible).",
    "4. WEATHER [2] — ERA5 archive back to 1940: was it really clear/overcast/",
    "   snowing there that day?",
    "5. Build the case — annotations (here: a pin + a label), this notes file, and",
    "   the evidence log feed the TIMELINE and the one-click DOSSIER. Save with",
    "   Ctrl+S; reopen from ↺ RECENT.",
    "",
    "Press Ctrl+K any time for the command palette. Replace this with your own case.",
  ].join("\n"),
  artifacts: [],
  inputs: { sunDt: "2023-06-15T14:30", wxDate: "2023-06-15" },
};

function loadSampleCase() {
  applyCase(SAMPLE_CASE);
  clearAutosave();
  status("sample case loaded — see the notes [N] for the workflow", false, 6000);
}

const SEEN_KEY = "geosint:seen";
/* ── modal overlay a11y: focus the first control on open, trap Tab inside, and
   restore focus to the opener on close. Used by the welcome + help overlays. */
let _modalReturnFocus = null;
function openModalOverlay(sel) {
  const el = $(sel);
  if (!el) return;
  _modalReturnFocus = document.activeElement;
  el.hidden = false;
  const focusables = el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (focusables.length) focusables[0].focus();
  el._trap = (e) => {
    if (e.key !== "Tab" || !focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  el.addEventListener("keydown", el._trap);
}
function closeModalOverlay(sel) {
  const el = $(sel);
  if (!el || el.hidden) return;
  el.hidden = true;
  if (el._trap) { el.removeEventListener("keydown", el._trap); el._trap = null; }
  if (_modalReturnFocus && _modalReturnFocus.focus) _modalReturnFocus.focus();
  _modalReturnFocus = null;
}

function maybeWelcome() {
  // Don't double-prompt: if an autosave restore is being offered, skip the welcome.
  let seen = true;
  try { seen = !!localStorage.getItem(SEEN_KEY); } catch { seen = true; }
  if (seen || !$("#restore-bar").hidden) return;
  openModalOverlay("#welcome-overlay");
}
function dismissWelcome() {
  closeModalOverlay("#welcome-overlay");
  try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* ignore */ }
}

/* ── autosave / crash recovery ─────────────────────────────────
   Continuously snapshot the live case to localStorage so a crash / accidental
   close / reload never loses work since the last manual Save. 100% local —
   localStorage is per-origin, on the user's disk; nothing is uploaded.
   Explicit Save/Load clears the snapshot (the user then has a durable copy). */
const AUTOSAVE_KEY = "geosint:autosave";
let _autosaveTimer = null, _autosaveLast = null, _autosavePaused = false;
// After an explicit Save/Load the in-memory case is "clean" — suppress autosave
// (incl. the pagehide/interval flushes) until the user edits again, so leaving the
// page doesn't silently re-snapshot a case the user already has a durable copy of.
let _autosaveClean = true;

function lsAvailable() {
  try { localStorage.setItem("geosint:_t", "1"); localStorage.removeItem("geosint:_t"); return true; }
  catch { return false; }
}

// A case is worth autosaving only once it holds real work — otherwise startup
// (deep-link setPoint, openModule) would snapshot an empty default and pop a
// pointless "restore" banner on the next load.
function caseHasContent(c) {
  return !!(c.point || (c.notes || "").trim() || (c.annos || []).length ||
            (c.measure || []).length || (c.artifacts || []).length ||
            (c.gbif || []).length || c.data);
}

function writeAutosave() {
  if (_autosaveClean || _autosavePaused || !lsAvailable()) return;
  let c;
  try { c = serializeCase(); } catch { return; }
  if (!caseHasContent(c)) {                       // nothing worth restoring yet
    if (_autosaveLast !== null) clearAutosave();  // also drop a now-emptied case
    return;
  }
  const snap = JSON.stringify(c);
  if (snap === _autosaveLast) return;            // no change since last write
  try {
    localStorage.setItem(AUTOSAVE_KEY, snap);
    _autosaveLast = snap;
  } catch {
    // Quota: retry once with thumbnails stripped (keep the rest of the case).
    try {
      const c = serializeCase();
      c.artifacts = (c.artifacts || []).map(({ thumb, ...rest }) => rest);
      const lean = JSON.stringify(c);
      localStorage.setItem(AUTOSAVE_KEY, lean);
      _autosaveLast = lean;
    } catch {
      _autosavePaused = true;                     // give up quietly for this session
      status("autosave paused — case too large for browser storage", true, 3000);
    }
  }
}

// Debounced: most edits fire this; a coarse interval + pagehide flush back it up.
function markDirty() {
  _autosaveClean = false;                          // a real edit happened → re-arm autosave
  if (_autosaveTimer) clearTimeout(_autosaveTimer);
  _autosaveTimer = setTimeout(writeAutosave, 1500);
}

function clearAutosave() {
  _autosaveLast = null;
  _autosaveClean = true;                           // durable copy / no snapshot → don't re-flush
  if (_autosaveTimer) { clearTimeout(_autosaveTimer); _autosaveTimer = null; }
  try { localStorage.removeItem(AUTOSAVE_KEY); } catch { /* ignore */ }
}

function readAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    return (c && c.app === "geosint-workbench") ? c : null;
  } catch { return null; }
}

// On startup: if a snapshot exists, offer to restore it (never auto-apply, so a
// fresh session isn't silently overwritten).
function maybeOfferRestore() {
  const c = readAutosave();
  const bar = $("#restore-bar");
  if (!c || !bar) { if (!c) clearAutosave(); return; }
  const when = c.saved ? c.saved.slice(0, 16).replace("T", " ") : "earlier";
  $("#restore-when").textContent = when;
  bar.hidden = false;
  $("#restore-yes").onclick = () => {
    applyCase(c);                                 // serializeCase is sync; nothing to await
    bar.hidden = true;
    _autosaveLast = null;                          // restored case becomes the new baseline
  };
  $("#restore-no").onclick = () => { clearAutosave(); bar.hidden = true; };
}

function toggleNotes(force) {
  const d = $("#notes-drawer");
  d.hidden = force !== undefined ? !force : !d.hidden;
  if (!d.hidden) $("#case-notes").focus();
}

function initCase() {
  $("#btn-case-save").addEventListener("click", saveCase);
  $("#btn-case-load").addEventListener("click", () => $("#case-file").click());
  $("#case-file").addEventListener("change", (e) => {
    if (e.target.files[0]) loadCase(e.target.files[0]);
    e.target.value = "";                       // allow re-loading the same file
  });
  $("#btn-notes").addEventListener("click", () => toggleNotes());
  $("#notes-close").addEventListener("click", () => toggleNotes(false));
  // recent-cases dropdown
  $("#btn-recent").addEventListener("click", (e) => { e.stopPropagation(); toggleRecentMenu(); });
  document.addEventListener("click", (e) => {
    if (!$("#recent-menu").hidden && !e.target.closest(".menu-wrap")) closeRecentMenu();
  });
  const cc = $("#custody-csv"), cj = $("#custody-json");
  if (cc) cc.addEventListener("click", () => exportCustody("csv"));
  if (cj) cj.addEventListener("click", () => exportCustody("json"));
  const tlo = $("#timeline-open"), tlc = $("#timeline-close");
  if (tlo) tlo.addEventListener("click", openTimeline);
  if (tlc) tlc.addEventListener("click", () => { $("#timeline-panel").hidden = true; });
  const dossierExport = (redact) => async () => {
    if (_artPending.size) { status("finalizing evidence log…", false, 1500); await Promise.all([..._artPending]); }
    exportDossier(redact);
  };
  const dz = $("#btn-dossier");
  if (dz) dz.addEventListener("click", dossierExport(false));
  const dzr = $("#btn-dossier-redacted");
  if (dzr) dzr.addEventListener("click", dossierExport(true));

  // ── autosave wiring ──
  const notes = $("#case-notes");
  if (notes) notes.addEventListener("input", markDirty);
  setInterval(writeAutosave, 20000);             // coarse backstop in case a mutator is missed
  // Flush synchronously when the tab is hidden/closed so the last edits survive
  // an abrupt close (the debounce timer may not fire otherwise).
  window.addEventListener("pagehide", writeAutosave);
  document.addEventListener("visibilitychange", () => { if (document.hidden) writeAutosave(); });
  maybeOfferRestore();                            // offer to restore a prior unsaved snapshot

  // first-run welcome + sample case
  $("#welcome-sample").addEventListener("click", () => { dismissWelcome(); loadSampleCase(); });
  $("#welcome-keys").addEventListener("click", () => { dismissWelcome(); openModalOverlay("#help-overlay"); });
  $("#welcome-start").addEventListener("click", dismissWelcome);
  maybeWelcome();                                 // show on first visit (after restore check)

  // pick up a finding handed off from the Sun & Shadow Studio tab
  ingestStudioFinding();
  window.addEventListener("focus", ingestStudioFinding);
}
