/* GeOSINT Workbench — command palette (Ctrl/Cmd+K fuzzy jump). #31. */

/* ═══════════════════════ command palette ═════════════════════
   Ctrl/Cmd+K: fuzzy-jump to any module, tool, coordinate action or wiki search.
   Commands are rebuilt on each open so point-dependent ones reflect live state. */
const _palette = { open: false, items: [], sel: 0, prevFocus: null };

function buildCommands() {
  const cmds = [];
  // kw = extra keywords matched in addition to the label (so "weather" finds
  // "Meteorology", "find"/"search" find Wiki Search, etc.)
  const C = (grp, label, run, hint, kw) => cmds.push({ grp, label, run, hint, kw: kw || "" });

  // modules
  C("Module", "Sun & Shadow", () => openModule("sun"), "1", "shadow chronolocation solar");
  C("Module", "Meteorology", () => openModule("weather"), "2", "weather climate rain cloud temperature");
  C("Module", "Image Intelligence", () => openModule("image"), "3", "exif photo metadata reverse");
  C("Module", "Tool Launcher", () => openModule("tools"), "4", "external tools open");
  C("Module", "Wiki Search", () => openModule("wiki"), "5", "find search identify bollards");
  C("Module", "Data Layers", () => openModule("data"), "6", "osm overpass features gbif");
  C("Module", "Annotations", () => openModule("anno"), "7", "pins labels arrows notes markup");
  C("Module", "Toggle ruler / measure", () => toggleMeasure(), "M", "distance bearing measure ruler");
  C("Module", "Case notes", () => toggleNotes(true), "N", "notes");

  // case actions
  C("Case", "Save case file", () => saveCase(), "Ctrl+S");
  C("Case", "Load case file", () => $("#case-file").click());
  C("Case", "Recent cases", () => toggleRecentMenu());
  C("Case", "Load sample case", () => loadSampleCase(), "", "demo example tour onboarding");
  C("Case", "Export dossier (HTML)", () => $("#btn-dossier").click());

  // coordinate actions (only meaningful with an active point)
  if (state.point) {
    const p = state.point;
    C("Coords", "Copy DD", () => copyText(fmtDD(p)));
    C("Coords", "Copy DMS", () => copyText(fmtDMS(p)));
    C("Coords", "Copy MGRS", () => copyText(fmtMGRS(p)));
    C("Coords", "Copy UTM", () => copyText(fmtUTM(p)));
    C("Coords", "Copy Plus Code", () => copyText(fmtPlus(p)));
    C("Coords", "Open Street View here", () => window.open(`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.lat},${p.lng}`));
    C("Coords", "Open Google Maps here", () => window.open(`https://www.google.com/maps/@${p.lat},${p.lng},16z`));
    C("Coords", "Open Google Earth here", () => window.open(`https://earth.google.com/web/@${p.lat},${p.lng},0a,2000d,35y,0h,0t,0r`));
  }

  // every tool (Tools.launch self-explains with a status if no active point)
  (typeof Tools !== "undefined" ? Tools.list : []).forEach((t) =>
    C("Tool", `Open ${t.name}`, () => Tools.launch(t)));

  return cmds;
}

// subsequence fuzzy match; exact-substring ranks higher. Matches the label first,
// then any extra keywords (so "weather" finds "Meteorology") at a lower rank.
function subseq(text, Q) {
  const L = text.toLowerCase();
  const idx = L.indexOf(Q);
  if (idx >= 0) return 1000 - idx;                 // contiguous, earlier = better
  let li = 0, hits = 0;
  for (const ch of Q) {
    const f = L.indexOf(ch, li);
    if (f < 0) return -1;
    li = f + 1; hits++;
  }
  return hits;                                      // looser subsequence match
}
function fuzzyScore(cmd, q) {
  const Q = (q || "").toLowerCase();
  if (!Q) return 1;
  const onLabel = subseq(cmd.label, Q);
  if (onLabel >= 0) return onLabel + 2000;          // label hits outrank keyword hits
  if (cmd.kw) { const onKw = subseq(cmd.kw, Q); if (onKw >= 0) return onKw; }
  return -1;
}

function renderPalette() {
  const q = $("#cmd-input").value.trim();
  const all = _palette.all;
  let list;
  if (q) {
    list = all.map((c) => ({ c, s: fuzzyScore(c, q) }))
              .filter((x) => x.s >= 0)
              .sort((a, b) => b.s - a.s)
              .map((x) => x.c);
    // always offer a wiki search for the raw query, appended last so it never
    // outranks a real command match (selection stays on the top match).
    list = list.concat([{ grp: "Wiki", label: `Search wiki for “${q}”`,
      run: () => { openModule("wiki"); setTimeout(() => { const i = document.querySelector("#module-wiki .s-q"); if (i) { i.value = q; i.dispatchEvent(new Event("input", { bubbles: true })); } }, 60); } }]);
  } else {
    list = all;
  }
  _palette.items = list;
  if (_palette.sel >= list.length) _palette.sel = Math.max(0, list.length - 1);
  const ul = $("#cmd-list");
  if (!list.length) { ul.innerHTML = `<li class="cmd-empty">No matching command</li>`; return; }
  ul.innerHTML = list.map((c, i) =>
    `<li role="option" data-i="${i}" aria-selected="${i === _palette.sel}">
       <span class="cmd-grp">${esc(c.grp)}</span>
       <span class="cmd-label">${esc(c.label)}</span>
       ${c.hint ? `<span class="cmd-hint">${esc(c.hint)}</span>` : ""}
     </li>`).join("");
  ul.querySelectorAll("li[data-i]").forEach((li) => {
    li.addEventListener("mousemove", () => { _palette.sel = +li.dataset.i; markSel(); });
    li.addEventListener("click", () => runPalette(+li.dataset.i));
  });
  scrollSelIntoView();
}

function markSel() {
  $("#cmd-list").querySelectorAll("li[data-i]").forEach((li) =>
    li.setAttribute("aria-selected", +li.dataset.i === _palette.sel));
  scrollSelIntoView();
}
function scrollSelIntoView() {
  const el = $("#cmd-list").querySelector(`li[data-i="${_palette.sel}"]`);
  if (el) el.scrollIntoView({ block: "nearest" });
}

function openPalette() {
  if (_palette.open) return;
  _palette.open = true;
  _palette.prevFocus = document.activeElement;
  _palette.all = buildCommands();
  _palette.sel = 0;
  $("#cmd-input").value = "";
  $("#cmd-palette").hidden = false;
  renderPalette();
  $("#cmd-input").focus();
}
function closePalette() {
  if (!_palette.open) return;
  _palette.open = false;
  $("#cmd-palette").hidden = true;
  if (_palette.prevFocus && _palette.prevFocus.focus) _palette.prevFocus.focus();
}
function runPalette(i) {
  const cmd = _palette.items[i != null ? i : _palette.sel];
  closePalette();
  if (cmd) try { cmd.run(); } catch { status("command failed", true); }
}

function initPalette() {
  const inp = $("#cmd-input");
  inp.addEventListener("input", () => { _palette.sel = 0; renderPalette(); });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); _palette.sel = Math.min(_palette.sel + 1, _palette.items.length - 1); markSel(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); _palette.sel = Math.max(_palette.sel - 1, 0); markSel(); }
    else if (e.key === "Enter") { e.preventDefault(); runPalette(); }
    else if (e.key === "Escape") { e.preventDefault(); closePalette(); }
  });
  // click outside the box closes
  $("#cmd-palette").addEventListener("mousedown", (e) => { if (e.target.id === "cmd-palette") closePalette(); });
}

