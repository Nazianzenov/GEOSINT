/* GeOSINT wiki search — entity-aware faceted search over the card index.
   Pipeline: query → entity parser (countries/demonyms/continents/categories
   become facets) → MiniSearch BM25 over the rest → facet post-filter →
   grouped smart display (photo grids vs fact cards). */
"use strict";

const $ = (s) => document.querySelector(s);
const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const esc = (s) => String(s).replace(/[&<>"']/g,
  (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

let DATA = null, MS = null;
const state = { country: null, continent: null, cats: new Set(), photos: false };

/* display order + which categories render as photo grids */
const GROUP_ORDER = ["country-facts", "recognition", "landmarks", "unesco", "castles",
  "national-parks", "airports", "flora", "bollards", "utility-poles",
  "traffic-lights", "license-plates", "flags", "sceneries", "architecture", "road-markings",
  "road-signs", "driving-side", "language-scripts", "domains-phones", "streetview-meta",
  "vegetation-climate", "methodology", "page"];

async function init() {
  DATA = await (await fetch("data/search-index.json")).json();
  DATA.countryKey = {};
  for (const c of Object.keys(DATA.countries)) DATA.countryKey[norm(c)] = c;

  MS = new MiniSearch({
    fields: ["t", "x", "cs"],
    storeFields: ["id"],
    processTerm: (t) => norm(t),
    searchOptions: { prefix: true, fuzzy: 0.15, boost: { t: 3, cs: 4 } },
  });
  MS.addAll(DATA.cards.map((c) => ({ ...c, cs: (c.c || []).join(" ") })));

  buildFacets();
  const params = new URLSearchParams(location.search);
  if (params.get("q")) $("#s-q").value = params.get("q");
  if (params.get("country")) state.country = params.get("country");
  if (params.get("continent")) state.continent = params.get("continent");
  if (params.get("cat")) state.cats.add(params.get("cat"));
  $("#s-q").addEventListener("input", debounce(run, 180));
  $("#s-country").addEventListener("change", () => {
    const v = DATA.countryKey[norm($("#s-country").value)];
    if (v) { state.country = v; $("#s-country").value = ""; run(); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement.tagName !== "INPUT") {
      e.preventDefault(); $("#s-q").focus();
    }
  });
  run();
}

const debounce = (fn, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };

function buildFacets() {
  const dl = $("#s-countries");
  Object.keys(DATA.countries).sort().forEach((c) => {
    const o = document.createElement("option"); o.value = c; dl.appendChild(o);
  });
  const cont = $("#s-continents");
  ["Africa", "Asia", "Europe", "North America", "Oceania", "South America"].forEach((k) => {
    const el = document.createElement("span");
    el.className = "facet"; el.textContent = k; el.dataset.k = k;
    el.onclick = () => { state.continent = state.continent === k ? null : k; run(); };
    cont.appendChild(el);
  });
  const counts = {};
  DATA.cards.forEach((c) => { counts[c.g] = (counts[c.g] || 0) + 1; });
  const cats = $("#s-cats");
  GROUP_ORDER.filter((g) => counts[g]).forEach((g) => {
    const el = document.createElement("span");
    el.className = "facet"; el.dataset.g = g;
    el.innerHTML = `${DATA.labels[g] || g}<span class="n">${counts[g]}</span>`;
    el.onclick = () => { state.cats.has(g) ? state.cats.delete(g) : state.cats.add(g); run(); };
    cats.appendChild(el);
  });
  $("#s-photos").onclick = () => { state.photos = !state.photos; run(); };
}

/* ── entity-aware query parsing ───────────────────────────────────── */
function parseQuery(q) {
  const tokens = norm(q).split(/\s+/).filter(Boolean);
  const f = { country: null, continent: null, cats: new Set() };
  const rest = [];
  for (let i = 0; i < tokens.length;) {
    let used = 0;
    for (const n of [3, 2, 1]) {
      const phrase = tokens.slice(i, i + n).join(" ");
      if (DATA.aliases.continents[phrase]) { f.continent = DATA.aliases.continents[phrase]; used = n; break; }
      if (DATA.countryKey[phrase]) { f.country = DATA.countryKey[phrase]; used = n; break; }
      const dem = DATA.aliases.demonyms[phrase];
      if (dem && DATA.countries[dem]) { f.country = dem; used = n; break; }
      const cat = DATA.aliases.categories[phrase];
      if (cat) { f.cats.add(cat); used = n; break; }
    }
    if (used) i += used; else { rest.push(tokens[i]); i++; }
  }
  return { f, text: rest.join(" ") };
}

/* ── search + filter ──────────────────────────────────────────────── */
function run() {
  const q = $("#s-q").value.trim();
  const { f, text } = parseQuery(q);
  const country = state.country || f.country;
  const continent = state.continent || f.continent;
  const cats = state.cats.size ? state.cats : f.cats;

  let cards, scores = null;
  if (text) {
    scores = new Map();
    MS.search(text).forEach((r) => scores.set(r.id, r.score));
    cards = DATA.cards.filter((c) => scores.has(c.id));
  } else {
    cards = DATA.cards;
  }
  cards = cards.filter((c) =>
    (!country || (c.c || []).includes(country)) &&
    (!continent || c.k === continent ||
      (country == null && (c.c || []).some((x) => DATA.countries[x] === continent))) &&
    (!cats.size || cats.has(c.g)) &&
    (!state.photos || c.img));

  renderInterp(q, { country, continent, cats, text });
  renderFacetState(country, continent, cats);
  render(cards, scores, { country, text });
  const url = new URL(location); q ? url.searchParams.set("q", q) : url.searchParams.delete("q");
  history.replaceState(null, "", url);
}

function renderInterp(q, eff) {
  const parts = [];
  if (eff.country) parts.push(`country = <b>${eff.country}</b>`);
  if (eff.continent) parts.push(`continent = <b>${eff.continent}</b>`);
  if (eff.cats.size) parts.push(`category = <b>${[...eff.cats].map((g) => DATA.labels[g] || g).join(", ")}</b>`);
  if (eff.text) parts.push(`text ≈ <b>${eff.text}</b>`);
  $("#s-chips").innerHTML = state.country
    ? `<span class="chip" onclick="state.country=null;run()">${state.country}</span>` : "";
  const el = document.createElement("div");
  el.className = "interp";
  el.innerHTML = parts.length ? "interpreted: " + parts.join(" · ") : "";
  const old = $("#s-main .interp"); if (old) old.remove();
  $("#s-main").prepend(el);
}

function renderFacetState(country, continent, cats) {
  document.querySelectorAll("#s-continents .facet").forEach((el) =>
    el.classList.toggle("on", el.dataset.k === continent));
  document.querySelectorAll("#s-cats .facet").forEach((el) =>
    el.classList.toggle("on", cats.has(el.dataset.g)));
  $("#s-photos").classList.toggle("on", state.photos);
}

/* ── smart display ────────────────────────────────────────────────── */
const PHOTO_CAP = 48, FACT_CAP = 25;

function render(cards, scores, ctx) {
  const main = $("#s-main");
  main.querySelectorAll(".s-group, .empty, h1.cq").forEach((e) => e.remove());
  $("#s-count").textContent = `${cards.length} results`;
  if (!cards.length) {
    main.insertAdjacentHTML("beforeend",
      `<div class="empty">No matches. Try a country ("liechtenstein"), a category ("bollards"), or both ("asian utility poles").</div>`);
    return;
  }
  if (ctx.country && !ctx.text) {
    main.insertAdjacentHTML("beforeend",
      `<h1 class="cq" style="font:600 20px var(--sans);margin:4px 0 0">Everything on ${ctx.country}</h1>`);
  }
  const groups = new Map();
  cards.forEach((c) => { (groups.get(c.g) || groups.set(c.g, []).get(c.g)).push(c); });
  const order = [...groups.keys()].sort((a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b));
  for (const g of order) {
    let items = groups.get(g);
    if (scores) items = items.sort((a, b) => scores.get(b.id) - scores.get(a.id));
    else items = items.sort((a, b) => ((a.c || [])[0] || "").localeCompare((b.c || [])[0] || ""));
    const photos = items.filter((c) => c.img);
    const isPhotoGroup = photos.length > items.length / 2;
    const div = document.createElement("div");
    div.className = "s-group";
    div.innerHTML = `<h2>${DATA.labels[g] || g}<span class="n">${items.length}</span></h2>`;
    if (isPhotoGroup) div.appendChild(photoGrid(items, PHOTO_CAP));
    else div.appendChild(factList(items, FACT_CAP, ctx.text));
    $("#s-main").appendChild(div);
  }
}

function photoGrid(items, cap) {
  const wrap = document.createElement("div");
  const grid = document.createElement("div");
  grid.className = "grid";
  const renderSlice = (from, to) => items.slice(from, to).forEach((c) => {
    const links = [
      c.map ? `<a href="${c.map}" target="_blank">map</a>` : "",
      c.page ? `<a href="${c.page}" target="_blank">wiki</a>` : "",
    ].filter(Boolean).join(" · ");
    grid.insertAdjacentHTML("beforeend",
      `<div class="pcard"><img src="${esc(c.img)}" loading="lazy" alt="">
       <div class="cap"><b>${esc((c.c || []).join(", ") || c.t)}</b><span>${links}</span></div></div>`);
  });
  renderSlice(0, cap);
  wrap.appendChild(grid);
  if (items.length > cap) {
    const btn = document.createElement("button");
    btn.className = "btn more";
    btn.textContent = `show all ${items.length}`;
    btn.onclick = () => { renderSlice(cap, items.length); btn.remove(); };
    wrap.appendChild(btn);
  }
  return wrap;
}

function factList(items, cap, text) {
  const wrap = document.createElement("div");
  const hl = (s) => {
    if (!text) return s;
    let out = s;
    for (const w of text.split(/\s+/).filter((w) => w.length > 2)) {
      out = out.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"), "<mark>$1</mark>");
    }
    return out;
  };
  const renderSlice = (from, to) => items.slice(from, to).forEach((c) => {
    const where = [(c.c || []).join(", "), c.k].filter(Boolean).join(" · ");
    const mapLink = c.ll ? ` · <a href="/app/index.html#ll=${c.ll[0]},${c.ll[1]}" target="_blank">⌖ open on map</a>` : "";
    wrap.insertAdjacentHTML("beforeend",
      `<div class="fcard"><b>${esc(c.t)}</b>${where && where !== c.t ? ` <span class="muted">(${esc(where)})</span>` : ""}
       ${c.img ? `<br><img src="${esc(c.img)}" loading="lazy" style="max-width:300px;border-radius:4px;margin:6px 0">` : ""}
       <div>${hl(esc(c.x || ""))}</div>
       <div class="src"><a href="${esc(c.page || "#")}" target="_blank">source page</a>${mapLink}</div></div>`);
  });
  renderSlice(0, cap);
  if (items.length > cap) {
    const btn = document.createElement("button");
    btn.className = "btn more";
    btn.textContent = `show all ${items.length}`;
    btn.onclick = () => { renderSlice(cap, items.length); btn.remove(); };
    wrap.appendChild(btn);
  }
  return wrap;
}

window.run = run;          // chip onclick
window.state = state;
init();
