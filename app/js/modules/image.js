/* GeOSINT Workbench — Image intelligence module (split from app.js, #31).
   Classic <script>, shared global scope; loaded after common.js + core/map,
   before the app.js bootstrap. Behaviour-neutral extraction. */

/* ═══════════════════════════ IMAGE ═════════════════════════════ */
function initImage() {
  const dz = $("#dropzone"), fi = $("#file-input");
  dz.addEventListener("click", () => fi.click());
  fi.addEventListener("change", () => fi.files[0] && loadImage(fi.files[0]));
  ["dragover", "dragenter"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith("image/")) loadImage(f);
  });
  $("#img-url").addEventListener("input", renderUrlButtons);
  $("#img-url-all").addEventListener("click", () => {
    const u = $("#img-url").value.trim();
    if (!u) return status("enter an image URL first", true);
    engineUrls(u).forEach((e) => window.open(e.url, "_blank"));
  });
  renderUrlButtons();
  initBatch();
}

/* ── batch EXIF: parse many images locally into a sortable table ── */
const _batch = { rows: [], sort: { key: "name", dir: 1 } };

function initBatch() {
  const bz = $("#batch-zone"), bi = $("#batch-input");
  bz.addEventListener("click", () => bi.click());
  bi.addEventListener("change", () => batchProcess([...bi.files]));
  ["dragover", "dragenter"].forEach((ev) => bz.addEventListener(ev, (e) => { e.preventDefault(); bz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => bz.addEventListener(ev, (e) => { e.preventDefault(); bz.classList.remove("over"); }));
  bz.addEventListener("drop", (e) => {
    // drops can be files or a dropped folder (webkit entries) — collect images
    const fs = [...(e.dataTransfer.files || [])].filter((f) => f.type.startsWith("image/"));
    if (fs.length) batchProcess(fs);
  });
}

async function batchProcess(files) {
  const imgs = files.filter((f) => f.type.startsWith("image/"));
  if (!imgs.length) return status("no images in that drop", true);
  _batch.rows = [];
  $("#batch-status").textContent = `parsing ${imgs.length} image(s) locally…`;
  let done = 0;
  for (const f of imgs) {
    let ex = null;
    try { ex = await exifr.parse(f, { gps: true, exif: true, ifd0: true }); } catch { /* none */ }
    _batch.rows.push({
      name: f.name,
      lat: ex && ex.latitude != null ? ex.latitude : null,
      lng: ex && ex.longitude != null ? ex.longitude : null,
      taken: ex && ex.DateTimeOriginal ? new Date(ex.DateTimeOriginal) : null,
      camera: ex ? [ex.Make, ex.Model].filter(Boolean).join(" ") : "",
      dir: ex && ex.GPSImgDirection != null ? Math.round(ex.GPSImgDirection) : null,
      size: f.size,
    });
    captureImage(f, ex);                         // case v2 evidence log (hash + thumb; deduped)
    if (++done % 10 === 0) $("#batch-status").textContent = `parsed ${done}/${imgs.length}…`;
  }
  const withGps = _batch.rows.filter((r) => r.lat != null).length;
  $("#batch-status").textContent =
    `${imgs.length} images · ${withGps} with GPS · ${_batch.rows.filter((r) => r.taken).length} with timestamp`;
  renderBatch();
}

function renderBatch() {
  const out = $("#batch-out");
  if (!_batch.rows.length) { out.innerHTML = ""; return; }
  const { key, dir } = _batch.sort;
  const val = (r) => key === "taken" ? (r.taken ? r.taken.getTime() : -Infinity)
    : key === "gps" ? (r.lat != null ? r.lat : -Infinity)
    : (r[key] ?? (typeof r[key] === "number" ? -Infinity : ""));
  const rows = [..._batch.rows].sort((a, b) => {
    const x = val(a), y = val(b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
  const hdr = (k, label) => `<th data-k="${k}" class="batch-th">${label}${key === k ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`;
  out.innerHTML = `<table class="data batch">
    <tr>${hdr("name", "File")}${hdr("gps", "GPS")}${hdr("taken", "Taken")}${hdr("camera", "Camera")}<th>dir</th><th></th></tr>
    ${rows.map((r) => `<tr>
      <td title="${esc(r.name)}">${esc(r.name.length > 28 ? r.name.slice(0, 26) + "…" : r.name)}</td>
      <td>${r.lat != null ? `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}` : "<span class='muted'>—</span>"}</td>
      <td>${r.taken ? esc(r.taken.toLocaleString()) : "<span class='muted'>—</span>"}</td>
      <td>${esc(r.camera) || "<span class='muted'>—</span>"}</td>
      <td>${r.dir != null ? `${r.dir}°` : ""}</td>
      <td>${r.lat != null ? `<a href="#" class="batch-go" data-lat="${r.lat}" data-lng="${r.lng}">⌖</a>` : ""}</td>
    </tr>`).join("")}
  </table>`;
  out.querySelectorAll(".batch-th").forEach((th) => th.onclick = () => {
    const k = th.dataset.k;
    _batch.sort = { key: k, dir: _batch.sort.key === k ? -_batch.sort.dir : 1 };
    renderBatch();
  });
  out.querySelectorAll(".batch-go").forEach((a) => a.onclick = (e) => {
    e.preventDefault();
    setPoint(L.latLng(+a.dataset.lat, +a.dataset.lng), { fly: true, zoom: 15 });
  });
}

const engineUrls = (u) => {
  const e = encodeURIComponent(u);
  return [
    { name: "Google Lens", url: `https://lens.google.com/uploadbyurl?url=${e}` },
    { name: "Yandex", url: `https://yandex.com/images/search?rpt=imageview&url=${e}` },
    { name: "Bing", url: `https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:${e}` },
    { name: "TinEye", url: `https://tineye.com/search?url=${e}` },
  ];
};

function renderUrlButtons() {
  const u = $("#img-url").value.trim();
  $("#img-url-btns").innerHTML = u
    ? engineUrls(u).map((e) => `<a class="btn" target="_blank" href="${e.url}">${e.name} ⇗</a>`).join("")
    : "";
}

// Reverse-search engines fetch an image URL from THEIR servers, so a local file
// (or a loopback URL) can't be auto-submitted. Doctrine-safe assist: copy
// the dropped image to the clipboard and open the engines' upload pages, so the
// analyst just pastes (Ctrl+V). Nothing leaves the machine.
const REVERSE_UPLOAD_PAGES = [
  ["Google Lens", "https://lens.google.com/"],
  ["Yandex", "https://yandex.com/images/"],
  ["Bing", "https://www.bing.com/visualsearch"],
  ["TinEye", "https://tineye.com/"],
];
async function localReverseSearch() {
  const file = state.lastFile;
  if (!file) return status("Drop an image first.", true);
  let copied = false;
  try {
    // Clipboard image write needs a PNG blob; convert via canvas (handles any
    // source type the browser decoded). Stays entirely local.
    const bmp = await createImageBitmap(file);
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    const blob = await new Promise((res) => c.toBlob(res, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    copied = true;
  } catch { /* clipboard-image blocked or unsupported */ }
  REVERSE_UPLOAD_PAGES.forEach(([, url]) => window.open(url, "_blank"));
  status(copied
    ? "image copied — paste it into the engine (Ctrl/Cmd+V)"
    : "clipboard blocked — drag the image into the engine tab", !copied, 6000);
}

// Local reverse-search assist button — copy-to-clipboard + open engines.
function reverseSearchButton() {
  return `<div class="gps-actions">
      <button class="btn" id="local-reverse" title="Copy this image to the clipboard and open the reverse-search engines — then paste (Ctrl/Cmd+V). Nothing is uploaded by GeOSINT.">🔍 REVERSE SEARCH (paste-ready)</button>
    </div>`;
}
function wireReverseSearch() {
  const b = $("#local-reverse");
  if (b) b.onclick = localReverseSearch;
}

/* Deep metadata dump + embedded-preview recovery via the locally installed
   ExifTool (server-side, stays on-machine). */
function exiftoolButton() {
  if (!state.tools || !state.tools.exiftool || !state.tools.exiftool.found) return "";
  return `<div class="gps-actions">
      <button class="btn" id="exiftool-dump">⚙ FULL METADATA (ExifTool)</button>
      <button class="btn" id="exiftool-preview" title="Extract the image embedded inside this file (RAW/HEIC/JPEG preview or thumbnail). Often the UNCROPPED original — recovers what a crop or redaction cut out.">⛏ RECOVER EMBEDDED PREVIEW</button>
    </div>
    <div id="exiftool-out"></div>`;
}

/* extract the largest embedded preview/thumbnail and flag any
   main-vs-preview GPS/time mismatch (a tampering signal). The preview is often
   the uncropped original — what a crop/redaction removed can still live here. */
async function previewExtract() {
  const out = $("#exiftool-out");
  out.innerHTML = `<p class="hint">extracting embedded preview locally…</p>`;
  try {
    const r = await fetchT("/api/exif-preview", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-GeOSINT": "1",
                 "X-Filename": encodeURIComponent(state.lastFile.name) },
      body: state.lastFile,
    }, UPLOAD_TIMEOUT);
    // a JSON body means "no preview" or an error; image bytes mean success
    if ((r.headers.get("Content-Type") || "").startsWith("application/json")) {
      const j = await r.json();
      out.innerHTML = `<p class="nomatch">✗ ${esc(j.error || j.msg || "no embedded preview")}</p>`;
      return;
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const tag = r.headers.get("X-Preview-Tag") || "preview";
    const kb = Math.round((+r.headers.get("X-Preview-Bytes") || blob.size) / 1024);
    const gpsBad = r.headers.get("X-GPS-Mismatch") === "1";
    const timeBad = r.headers.get("X-Time-Mismatch") === "1";
    const mainGps = r.headers.get("X-Main-GPS"), prevGps = r.headers.get("X-Preview-GPS");
    const mainTime = r.headers.get("X-Main-Time"), prevTime = r.headers.get("X-Preview-Time");
    let warn = "";
    if (gpsBad || timeBad) {
      const rows = [];
      if (gpsBad) rows.push(`<tr><td>GPS</td><td>main <b>${esc(mainGps)}</b></td><td>preview <b>${esc(prevGps)}</b></td></tr>`);
      if (timeBad) rows.push(`<tr><td>time</td><td>main <b>${esc(mainTime)}</b></td><td>preview <b>${esc(prevTime)}</b></td></tr>`);
      warn = `<div class="nomatch" style="margin:6px 0">⚠ <b>Preview metadata differs from the main image</b>
        — a possible edit/splice signal. Treat as a lead, not proof.
        <table class="kv" style="margin-top:4px">${rows.join("")}</table></div>`;
    }
    out.innerHTML = `<h3>Embedded preview — ${esc(tag)} · ${kb} KB</h3>
      ${warn}
      <p class="hint">If this differs from the visible image, the original was likely cropped or edited
        after capture — the embedded copy can show what was removed.</p>
      <img src="${url}" style="max-width:100%;border:1px solid var(--line);border-radius:4px;margin:6px 0" alt="embedded preview">
      <div class="gps-actions"><a class="btn" href="${url}" download="embedded-preview.jpg">⭳ save preview</a></div>`;
  } catch { out.innerHTML = `<p class="nomatch">✗ local server unreachable</p>`; }
}

async function exiftoolDump() {
  const out = $("#exiftool-out");
  out.innerHTML = `<p class="hint">running ExifTool locally…</p>`;
  try {
    const r = await fetchT("/api/exif", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "X-GeOSINT": "1",
                 "X-Filename": encodeURIComponent(state.lastFile.name) },
      body: state.lastFile,
    }, UPLOAD_TIMEOUT);
    const j = await r.json();
    if (j.error) { out.innerHTML = `<p class="nomatch">✗ ${esc(j.error)}</p>`; return; }
    const keys = Object.keys(j.tags);
    out.innerHTML = `<h3>ExifTool — ${keys.length} tags</h3>
      <div class="table-scroll"><table class="kv">${keys.map((k) =>
        `<tr><td>${esc(k)}</td><td>${esc(String(j.tags[k]).slice(0, 200))}</td></tr>`).join("")}</table></div>`;
  } catch { out.innerHTML = `<p class="nomatch">✗ local server unreachable</p>`; }
}

/* turn the raw EXIF dump into findings. All local, from fields exifr
   already parsed. Returns [{sev:'high'|'med'|'info', msg}], most severe first. */
function analyzeExifAnomalies(ex) {
  const out = [];
  if (!ex) return out;
  const D = (v) => { const t = v ? Date.parse(v instanceof Date ? v.toISOString() : v) : NaN; return isNaN(t) ? null : t; };

  // 1. Editing-software signature — a strong "touched after capture" signal.
  const sw = String(ex.Software || ex.ProcessingSoftware || "");
  if (/photoshop|lightroom|gimp|affinity|pixelmator|paint\.net|snapseed|inkscape|imagemagick|canva/i.test(sw)) {
    out.push({ sev: "high", msg: `Edited with ${sw.trim()} — image was processed after capture (EXIF/pixels may be altered).` });
  }

  // 2. Timestamp inconsistencies across the three EXIF dates.
  const orig = D(ex.DateTimeOriginal), create = D(ex.CreateDate), mod = D(ex.ModifyDate);
  if (orig && mod && mod - orig > 60 * 1000) {
    const mins = Math.round((mod - orig) / 60000);
    out.push({ sev: mins > 60 ? "high" : "med",
      msg: `Modified ${mins >= 1440 ? Math.round(mins / 1440) + " day(s)" : mins + " min"} after it was taken (ModifyDate > DateTimeOriginal) — re-saved/edited.` });
  }
  if (orig && create && Math.abs(create - orig) > 60 * 1000) {
    out.push({ sev: "med", msg: "DateTimeOriginal and CreateDate disagree by more than a minute — unusual for an untouched camera file." });
  }

  // 3. GPS vs stated timezone: the camera's UTC offset should roughly match the
  //    GPS longitude (~15° per hour). A big gap suggests a spoofed time or place.
  const off = ex.OffsetTimeOriginal || ex.OffsetTime;
  if (off && ex.longitude != null) {
    const m = /([+-])(\d{2}):?(\d{2})/.exec(off);
    if (m) {
      const statedHrs = (m[1] === "-" ? -1 : 1) * (+m[2] + (+m[3]) / 60);
      const expectedHrs = ex.longitude / 15;
      const gap = Math.abs(statedHrs - expectedHrs);
      if (gap > 3) out.push({ sev: "med",
        msg: `Timezone (${off}) is ~${gap.toFixed(1)}h off the GPS longitude's solar time — possible spoofed time or location.` });
    }
  }
  return out;
}

async function loadImage(file) {
  const img = $("#img-preview");
  img.src = URL.createObjectURL(file);
  img.hidden = false;
  state.lastFile = file;
  state.imgLayer.clearLayers();
  const out = $("#exif-out");
  out.innerHTML = `<p class="hint">reading metadata…</p>`;
  let ex = null;
  try { ex = await exifr.parse(file, { gps: true, exif: true, tiff: true, ifd0: true }); } catch { /* not parseable */ }
  captureImage(file, ex);                       // case v2 evidence log (hash + thumb; deduped)
  if (!ex || Object.keys(ex).length === 0) {
    out.innerHTML = `<h3>EXIF</h3><p class="hint">No metadata found — typical for images from social media
      (Twitter/X, Facebook, Telegram strip EXIF on upload). The pixels are still searchable below.</p>
      ${reverseSearchButton()}
      ${exiftoolButton()}`;
    const b0 = $("#exiftool-dump");
    if (b0) b0.onclick = exiftoolDump;
    const p0 = $("#exiftool-preview");
    if (p0) p0.onclick = previewExtract;
    wireReverseSearch();
    return;
  }
  const rows = [];
  // EXIF strings are attacker-controlled file content — always escape.
  const add = (k, v, raw) => v != null && v !== "" && rows.push(`<tr><td>${k}</td><td>${raw ? v : esc(v)}</td></tr>`);
  add("Camera", [ex.Make, ex.Model].filter(Boolean).join(" "));
  add("Taken", ex.DateTimeOriginal ? new Date(ex.DateTimeOriginal).toLocaleString() : null);
  add("Software", ex.Software);
  add("Lens", ex.LensModel);
  add("Exposure", ex.ExposureTime ? `1/${Math.round(1 / ex.ExposureTime)}s · f/${ex.FNumber} · ISO ${ex.ISO}` : null);
  let gpsHtml = "";
  if (ex.latitude != null && ex.longitude != null) {
    const ll = L.latLng(ex.latitude, ex.longitude);
    add("GPS", `${fmtDD(ll)} ${ex.GPSAltitude ? `· alt ${Math.round(ex.GPSAltitude)} m` : ""}`);
    if (ex.GPSImgDirection != null) add("Camera facing", `${Math.round(ex.GPSImgDirection)}° (${cardinal(ex.GPSImgDirection)})`);
    gpsHtml = `<div class="gps-actions">
      <button class="btn accent" id="exif-goto">⌖ GO TO GPS POSITION</button>
      <button class="btn" id="exif-copy">⧉ copy</button></div>`;
    // plot marker + camera view cone
    const mk = L.circleMarker(ll, { radius: 8, color: "#7ee787", fillColor: "#7ee787", fillOpacity: .6 })
      .bindTooltip("photo GPS", { permanent: false });
    state.imgLayer.addLayer(mk);
    if (ex.GPSImgDirection != null) {
      const d = ex.GPSImgDirection;
      state.imgLayer.addLayer(L.polygon([ll, project(ll, d - 25, 280), project(ll, d + 25, 280)],
        { color: "#7ee787", weight: 1, fillOpacity: .15 }));
    }
  } else {
    add("GPS", "<i>none embedded</i>", true);
  }
  // anomaly findings derived from the EXIF (edit signatures, timestamp
  // skew, GPS/timezone mismatch). Surfaced as a compact severity-ranked panel.
  const SEV = { high: ["⚠", "bad"], med: ["▲", "accent-2"], info: ["·", "muted"] };
  const anomalies = analyzeExifAnomalies(ex);
  const anomHtml = anomalies.length
    ? `<div class="exif-anom"><h4>⚠ Anomalies (${anomalies.length})</h4>${anomalies.map((a) =>
        `<div class="anom-row anom-${a.sev}">${SEV[a.sev][0]} ${esc(a.msg)}</div>`).join("")}</div>`
    : `<div class="exif-anom ok">✓ No metadata anomalies detected (edit signatures, timestamp skew, GPS/timezone all consistent).</div>`;
  out.innerHTML = `<h3>EXIF</h3><table class="kv">${rows.join("")}</table>${gpsHtml}
    ${anomHtml}
    ${reverseSearchButton()}
    ${exiftoolButton()}
    <p class="srcnote">EXIF can be edited or spoofed — treat as a lead, not proof. Cross-check with
      sun, weather and visual features. (<a target="_blank"
      href="https://www.bellingcat.com/resources/how-tos/2017/06/30/advanced-guide-verifying-video-content/">Bellingcat verification guide</a>)</p>`;
  wireReverseSearch();
  const bd = $("#exiftool-dump");
  if (bd) bd.onclick = exiftoolDump;
  const pv = $("#exiftool-preview");
  if (pv) pv.onclick = previewExtract;
  if (ex.latitude != null) {
    $("#exif-goto").onclick = () => setPoint(L.latLng(ex.latitude, ex.longitude), { fly: true, zoom: 16 });
    $("#exif-copy").onclick = () => copyText(`${ex.latitude.toFixed(6)}, ${ex.longitude.toFixed(6)}`);
  }
  if (ex.DateTimeOriginal) {
    const d = new Date(ex.DateTimeOriginal);
    const pad = (x) => String(x).padStart(2, "0");
    $("#sun-dt").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    $("#wx-date").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    status("EXIF timestamp copied to Sun & Weather modules");
  }
}

