/* GeOSINT Workbench — dossier export. Builds a self-contained HTML report
   (and its redacted, publication-safe variant) from case state + artifacts.
   Split from case.js per the #50 roadmap; loaded after case.js (uses
   timelineEvents) and before the bootstrap. Shares global scope. */

/* ── dossier export ──
   A self-contained HTML report of the case: active point (all coord formats),
   notes, annotations, the evidence log with inline thumbnails, the timeline,
   and a sources/provenance section. Renders from case state + v2 artifacts;
   thumbnails are already base64 so no originals are needed. 100% local. */

/* Dossier stylesheet — a module-level constant, not an inline string buried in
   buildDossier (where a typo failed silently). */
const DOSSIER_CSS = `body{font:14px/1.5 "Segoe UI",system-ui,sans-serif;color:#1a1d24;max-width:880px;margin:24px auto;padding:0 16px}
  h1{font-size:22px;margin:0 0 2px} h2{font-size:15px;margin:22px 0 6px;border-bottom:1px solid #ddd;padding-bottom:3px}
  .muted{color:#6b7280} .mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:#374151;word-break:break-all}
  table.kv{border-collapse:collapse;width:100%} table.kv td,table.kv th{border:1px solid #e5e7eb;padding:4px 7px;text-align:left;vertical-align:top;font-size:13px}
  table.kv th{background:#f3f4f6} pre{white-space:pre-wrap;background:#f9fafb;border:1px solid #e5e7eb;padding:8px;border-radius:4px}
  .grid{display:flex;flex-wrap:wrap;gap:10px} .ev{display:flex;gap:8px;border:1px solid #e5e7eb;border-radius:5px;padding:6px;width:260px}
  .ev img{width:80px;height:80px;object-fit:cover;border-radius:3px} .ev .noimg{width:80px;height:80px;display:flex;align-items:center;justify-content:center;font-size:28px;background:#f3f4f6;border-radius:3px}
  .ev-meta{font-size:12px;overflow:hidden} footer{margin-top:28px;color:#6b7280;font-size:12px;border-top:1px solid #ddd;padding-top:8px}`;

function buildDossier(redact = false) {
  const now = new Date();
  // 9C.3 — redaction helpers: coarsen coords, hide source URLs/filenames, keep
  // the analytical findings + provenance hashes.
  const coord = (lat, lng) => redact ? `${lat.toFixed(1)}, ${lng.toFixed(1)} (coarsened)` : `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  const src = (s) => !s ? "" : (redact ? "[redacted]" : esc(s));
  // Single redaction-label rule, shared by the artifact, relationship and
  // timeline blocks so they can't drift (they did: only the timeline used to
  // genericize image filenames). An image artifact's label is its original
  // filename + camera detail (sourcing), and any label that's a URL is a source
  // — both must be hidden from a publication-safe export.
  const redLabel = (kind, label) => {
    if (!redact) return label;
    if (kind === "image") return "image evidence";
    if (/^https?:\/\//i.test(String(label || ""))) return "external finding";
    return label;
  };

  const p = state.point;
  const ptBlock = p ? (redact
    ? `<table class="kv"><tr><td>Approx. location</td><td>${esc(coord(p.lat, p.lng))}</td></tr></table>`
    : `<table class="kv">
      <tr><td>Decimal</td><td>${esc(fmtDD(p))}</td></tr>
      <tr><td>DMS</td><td>${esc(fmtDMS(p))}</td></tr>
      <tr><td>MGRS</td><td>${esc(fmtMGRS(p))}</td></tr>
      <tr><td>UTM</td><td>${esc(fmtUTM(p))}</td></tr>
      <tr><td>Plus Code</td><td>${esc(fmtPlus(p))}</td></tr>
    </table>`) : `<p class="muted">No active point set.</p>`;

  const notes = (val("#case-notes") || "").trim();
  const notesBlock = redact ? `<p class="muted">Notes omitted from redacted export.</p>`
    : (notes ? `<pre>${esc(notes)}</pre>` : `<p class="muted">No notes.</p>`);

  const annos = state.annos || [];
  const annoBlock = annos.length ? `<table class="kv">
      <tr><th>type</th><th>text</th><th>location</th></tr>
      ${annos.map((a) => `<tr><td>${esc(a.type)}</td><td>${esc(a.text)}</td>
        <td>${esc(coord(a.ll[0], a.ll[1]))}</td></tr>`).join("")}
    </table>` : `<p class="muted">No annotations.</p>`;

  const arts = state.artifacts || [];
  const artBlock = arts.length ? `<div class="grid">
      ${[...arts].sort((a, b) => String(a.t).localeCompare(String(b.t))).map((a) => `
        <div class="ev">
          ${(!redact && dataThumb(a.thumb)) ? `<img src="${esc(dataThumb(a.thumb))}" alt="">` : `<div class="noimg">${ART_SYM[a.kind] || "•"}</div>`}
          <div class="ev-meta">
            <b>${redact ? esc(redLabel(a.kind, a.text || a.kind)) : esc(a.source || a.text || a.kind)}</b>
            <div class="muted">${esc(String(a.t).replace("T", " ").slice(0, 19))} · ${esc(a.kind)}</div>
            ${(redact && a.source) ? `<div class="muted">source: ${src(a.source)}</div>` : ""}
            ${a.ll ? `<div class="muted">${esc(coord(a.ll[0], a.ll[1]))}</div>` : ""}
            ${a.sha256 ? `<div class="mono">sha256 ${esc(redact ? a.sha256.slice(0, 16) + "…" : a.sha256)}</div>` : ""}
          </div>
        </div>`).join("")}
    </div>` : `<p class="muted">No evidence artifacts.</p>`;

  // 9A.3 — relationships: artifact links rendered as a graph-ish edge list.
  const byId = Object.fromEntries(arts.map((a) => [a.id, a]));
  const label = (a) => redLabel(a.kind, a.text || a.source || a.kind || `#${a.id}`);
  const edges = arts.flatMap((a) => (a.links || [])
    .filter((id) => byId[id])
    .map((id) => `<li>${esc(label(a))} <span class="muted">↔</span> ${esc(label(byId[id]))}</li>`));
  const relBlock = edges.length
    ? `<ul>${edges.join("")}</ul>` : `<p class="muted">No linked artifacts.</p>`;

  // 9B.3 — bibliography: de-duped numbered list of every source/page URL the case
  // references (artifact sources + the active point's notes are excluded; sources
  // only). Omitted from redacted exports.
  const cites = [...new Set(arts.map((a) => a.source).filter((s) => s && /^https?:\/\//i.test(s)))];
  const biblioBlock = redact
    ? `<p class="muted">Bibliography omitted from redacted export.</p>`
    : (cites.length
      ? `<ol>${cites.map((u) => `<li><a href="${esc(u)}">${esc(u)}</a></li>`).join("")}</ol>`
      : `<p class="muted">No web sources cited.</p>`);

  const ev = timelineEvents();
  // Timeline labels go through the same shared redaction rule as the artifact /
  // relationship blocks (redLabel): image events -> "image evidence", URL labels
  // -> "external finding". (timelineEvents sets label = source||text||kind.)
  const evLabel = (e) => redLabel(e.kind, e.label);
  const evDetail = (e) => (redact && e.kind === "image") ? "" : e.detail;   // camera make/model is sourcing
  const tlBlock = ev.length ? `<table class="kv">
      <tr><th>time</th><th>event</th><th>location</th></tr>
      ${ev.map((e) => `<tr><td class="mono">${esc(String(e.t).replace("T", " ").slice(0, 16))}</td>
        <td>${esc(evLabel(e))}${evDetail(e) ? ` <span class="muted">— ${esc(evDetail(e))}</span>` : ""}</td>
        <td>${e.ll ? esc(coord(e.ll[0], e.ll[1])) : ""}</td></tr>`).join("")}
    </table>` : `<p class="muted">No dated events.</p>`;

  // chronolocation finding with its stated uncertainty (if the solver ran).
  const sr = state.solverResult;
  const chronoBlock = !sr ? "" : (sr.status === "inconsistent"
    ? `<h2>Chronolocation finding</h2><p><b>Claim inconsistent</b> (${esc(sr.confidence)} confidence) —
       no time on the analysed date matches the shadow at the active point, within ±${esc(String(sr.tol))}° tolerance.</p>`
    : `<h2>Chronolocation finding</h2>
       <p>Shadow solver matched <b>${esc(sr.windows.join(", "))}</b> local time.
       Confidence <b>${esc(sr.confidence)}</b> — ${esc(sr.why)}; tolerance ±${esc(String(sr.tol))}°${sr.twoShadow ? ", two-shadow constraint" : ""}.</p>
       <p class="muted">Uncertainty is driven by the measurement tolerance; a narrower window at a tighter tolerance is a stronger finding.</p>`);

  return `<!doctype html><html><head><meta charset="utf-8">
    <title>GeOSINT ${redact ? "redacted " : ""}dossier — ${esc(now.toISOString().slice(0, 16).replace("T", " "))}</title>
    <style>${DOSSIER_CSS}</style></head><body>
    <h1>GeOSINT case dossier${redact ? " <span style=\"font-size:13px;color:#b91c1c\">(REDACTED)</span>" : ""}</h1>
    <div class="muted">Generated ${esc(now.toISOString().replace("T", " ").slice(0, 19))} (UTC) · GeOSINT Workbench (local)${redact ? " · sensitive sourcing removed for publication" : ""}</div>
    <h2>Active point</h2>${ptBlock}
    ${chronoBlock}
    <h2>Case notes</h2>${notesBlock}
    <h2>Annotations (${annos.length})</h2>${annoBlock}
    <h2>Evidence log (${arts.length})</h2>
    <p class="muted">SHA-256 of original bytes + embedded thumbnail. Originals retained on the analyst's machine.</p>${artBlock}
    <h2>Relationships</h2>${relBlock}
    <h2>Timeline (${ev.length})</h2>${tlBlock}
    <h2>Bibliography</h2>${biblioBlock}
    <footer>EXIF, geocoder and OSM data are leads, not proof — cross-check with sun, weather and visual features.
      Map data © OpenStreetMap contributors (ODbL). Generated entirely on-machine; nothing was uploaded.</footer>
    </body></html>`;
}

function exportDossier(redact = false) {
  const html = buildDossier(redact);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  a.download = `dossier-${redact ? "redacted-" : ""}${stamp}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  status(`${redact ? "redacted " : ""}dossier exported to your Downloads folder`);
}
