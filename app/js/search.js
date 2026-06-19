/* GeOSINT wiki search — entity-aware faceted search over the card index.
   Pipeline: query → entity parser (countries/demonyms/continents/categories
   become facets) → MiniSearch BM25 over the rest → facet post-filter →
   grouped smart display (photo grids vs fact cards).

   Packaged as a self-contained module (no globals shared with app.js) so it can
   power BOTH the standalone search.html page and the docked workbench panel:

     GeoSearch.mount(rootEl, { onPick })   build the UI inside rootEl
     GeoSearch.focus()                     focus the query box

   onPick(card) is called when the user activates a result's "open on map" action;
   when omitted (standalone page) the cards fall back to the #ll= deep link. */
"use strict";

window.GeoSearch = (function () {

const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
/* esc is shared from app/js/common.js (loaded before this script) */

/* display order + which categories render as photo grids */
const GROUP_ORDER = ["country-facts", "recognition", "landmarks", "unesco", "castles",
  "national-parks", "airports", "lighthouses", "stadiums", "dams", "universities",
  "power-plants", "mines", "railway-stations", "hospitals", "worship", "military",
  "flora", "bollards", "utility-poles",
  "traffic-lights", "license-plates", "flags", "sceneries", "architecture", "road-markings",
  "road-signs", "chevrons", "fire-hydrants", "manhole-covers", "bus-stops", "pylons",
  "driving-side", "language-scripts", "domains-phones", "streetview-meta",
  "vegetation-climate", "methodology", "page"];

const PHOTO_CAP = 48, FACT_CAP = 25;
const debounce = (fn, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };

/* Parse a workbench "map" deep link into a typed in-app intent the host can act
   on in place, or null if it isn't one we can handle (e.g. an external Google
   Maps short-link). The two link types the card index uses:
     /app/...#ll=lat,lng                  -> a point        { kind:'point', ll }
     /app/...#species=<gbifKey>&name=<n>  -> a distribution { kind:'species', key, name }
   Pure (no DOM/index) — exposed on GeoSearch for testing. */
function wbIntent(url) {
  if (!url) return null;
  let m = /#ll=(-?[\d.]+),(-?[\d.]+)/.exec(url);
  if (m) return { kind: "point", ll: [+m[1], +m[2]] };
  m = /#species=(\d+)(?:&name=([^&]*))?/.exec(url);
  if (m) return { kind: "species", key: +m[1], name: decodeURIComponent(m[2] || "species") };
  return null;
}

/* The index + MiniSearch instance are expensive (25 MB / ~105k cards). Build once,
   share across every mount (the standalone page mounts once; the workbench re-mounts
   the same instance whenever the panel re-opens). */
let _dataPromise = null;
async function loadData() {
  if (!_dataPromise) {
    _dataPromise = (async () => {
      const DATA = await (await fetch("data/search-index.json")).json();
      DATA.countryKey = {};
      for (const c of Object.keys(DATA.countries)) DATA.countryKey[norm(c)] = c;
      const MS = new MiniSearch({
        fields: ["t", "x", "cs"],
        storeFields: ["id"],
        processTerm: (t) => norm(t),
        searchOptions: { prefix: true, fuzzy: 0.15, boost: { t: 3, cs: 4 } },
      });
      MS.addAll(DATA.cards.map((c) => ({ ...c, cs: (c.c || []).join(" ") })));
      return { DATA, MS };
    })();
  }
  return _dataPromise;
}

/* One instance per mounted root, so two simultaneous mounts (page + panel) can't
   clobber each other's facet state or DOM. */
class SearchUI {
  constructor(root, opts) {
    this.root = root;
    this.onPick = opts && opts.onPick;          // (card) => void; falls back to #ll= link
    this.onLog = opts && opts.onLog;            // (card) => void; log a card to the case (workbench only)
    this.DATA = null; this.MS = null;
    this.state = { country: null, continent: null, cats: new Set(), photos: false };
    this.$ = (sel) => root.querySelector(sel);
    this.$$ = (sel) => root.querySelectorAll(sel);
    this.run = this.run.bind(this);
  }

  buildShell() {
    // Unique datalist id per mount so two simultaneous mounts can't collide on it.
    const dlId = "s-countries-dl-" + Math.random().toString(36).slice(2, 8);
    this.root.innerHTML = `
      <div class="s-controls">
        <input class="s-q" type="text" spellcheck="false" autocomplete="off"
               placeholder='Try: "asian bollards" · "japan" · "yellow plates" — press /'>
        <span class="s-count"></span>
      </div>
      <div class="s-wrap">
        <aside class="s-side">
          <h3>Country</h3>
          <input class="s-country mono" list="${dlId}" placeholder="type a country…">
          <datalist id="${dlId}"></datalist>
          <div class="s-chips"></div>
          <h3>Continent</h3>
          <div class="s-continents"></div>
          <h3>Category</h3>
          <div class="s-cats"></div>
          <h3>Display</h3>
          <label class="facet s-photos">photos only</label>
        </aside>
        <main class="s-main"><div class="empty">loading index…</div></main>
      </div>`;
  }

  async init() {
    this.buildShell();
    const { DATA, MS } = await loadData();
    this.DATA = DATA; this.MS = MS;
    this.buildFacets();
    this.$(".s-q").addEventListener("input", debounce(this.run, 180));
    this.$(".s-country").addEventListener("change", () => {
      const v = this.DATA.countryKey[norm(this.$(".s-country").value)];
      if (v) { this.state.country = v; this.$(".s-country").value = ""; this.run(); }
    });
    this.run();
  }

  focus() { const q = this.$(".s-q"); if (q) q.focus(); }

  buildFacets() {
    const dl = this.$(".s-side datalist");
    Object.keys(this.DATA.countries).sort().forEach((c) => {
      const o = document.createElement("option"); o.value = c; dl.appendChild(o);
    });
    const cont = this.$(".s-continents");
    ["Africa", "Asia", "Europe", "North America", "Oceania", "South America"].forEach((k) => {
      const el = document.createElement("span");
      el.className = "facet"; el.textContent = k; el.dataset.k = k;
      el.onclick = () => { this.state.continent = this.state.continent === k ? null : k; this.run(); };
      cont.appendChild(el);
    });
    const counts = {};
    this.DATA.cards.forEach((c) => { counts[c.g] = (counts[c.g] || 0) + 1; });
    const cats = this.$(".s-cats");
    GROUP_ORDER.filter((g) => counts[g]).forEach((g) => {
      const el = document.createElement("span");
      el.className = "facet"; el.dataset.g = g;
      el.innerHTML = `${this.DATA.labels[g] || g}<span class="n">${counts[g]}</span>`;
      el.onclick = () => { this.state.cats.has(g) ? this.state.cats.delete(g) : this.state.cats.add(g); this.run(); };
      cats.appendChild(el);
    });
    this.$(".s-photos").onclick = () => { this.state.photos = !this.state.photos; this.run(); };
  }

  /* ── entity-aware query parsing ───────────────────────────────────── */
  parseQuery(q) {
    const tokens = norm(q).split(/\s+/).filter(Boolean);
    const f = { country: null, continent: null, cats: new Set() };
    const rest = [];
    for (let i = 0; i < tokens.length;) {
      let used = 0;
      for (const n of [3, 2, 1]) {
        const phrase = tokens.slice(i, i + n).join(" ");
        if (this.DATA.aliases.continents[phrase]) { f.continent = this.DATA.aliases.continents[phrase]; used = n; break; }
        if (this.DATA.countryKey[phrase]) { f.country = this.DATA.countryKey[phrase]; used = n; break; }
        const dem = this.DATA.aliases.demonyms[phrase];
        if (dem && this.DATA.countries[dem]) { f.country = dem; used = n; break; }
        const cat = this.DATA.aliases.categories[phrase];
        if (cat) { f.cats.add(cat); used = n; break; }
      }
      if (used) i += used; else { rest.push(tokens[i]); i++; }
    }
    return { f, text: rest.join(" ") };
  }

  /* ── search + filter ──────────────────────────────────────────────── */
  run() {
    const q = this.$(".s-q").value.trim();
    const { f, text } = this.parseQuery(q);
    const country = this.state.country || f.country;
    const continent = this.state.continent || f.continent;
    const cats = this.state.cats.size ? this.state.cats : f.cats;

    let cards, scores = null;
    if (text) {
      scores = new Map();
      this.MS.search(text).forEach((r) => scores.set(r.id, r.score));
      cards = this.DATA.cards.filter((c) => scores.has(c.id));
    } else {
      cards = this.DATA.cards;
    }
    cards = cards.filter((c) =>
      (!country || (c.c || []).includes(country)) &&
      (!continent || c.k === continent ||
        (country == null && (c.c || []).some((x) => this.DATA.countries[x] === continent))) &&
      (!cats.size || cats.has(c.g)) &&
      (!this.state.photos || c.img));

    this.renderInterp(q, { country, continent, cats, text });
    this.renderFacetState(country, continent, cats);
    this.render(cards, scores, { country, text });
  }

  renderInterp(q, eff) {
    const parts = [];
    if (eff.country) parts.push(`country = <b>${esc(eff.country)}</b>`);
    if (eff.continent) parts.push(`continent = <b>${esc(eff.continent)}</b>`);
    if (eff.cats.size) parts.push(`category = <b>${[...eff.cats].map((g) => esc(this.DATA.labels[g] || g)).join(", ")}</b>`);
    if (eff.text) parts.push(`text ≈ <b>${esc(eff.text)}</b>`);
    const chips = this.$(".s-chips");
    chips.innerHTML = "";
    if (this.state.country) {
      const chip = document.createElement("span");
      chip.className = "chip"; chip.textContent = this.state.country;
      chip.onclick = () => { this.state.country = null; this.run(); };
      chips.appendChild(chip);
    }
    const el = document.createElement("div");
    el.className = "interp";
    el.innerHTML = parts.length ? "interpreted: " + parts.join(" · ") : "";
    const old = this.$(".s-main .interp"); if (old) old.remove();
    this.$(".s-main").prepend(el);
  }

  renderFacetState(country, continent, cats) {
    this.$$(".s-continents .facet").forEach((el) =>
      el.classList.toggle("on", el.dataset.k === continent));
    this.$$(".s-cats .facet").forEach((el) =>
      el.classList.toggle("on", cats.has(el.dataset.g)));
    this.$(".s-photos").classList.toggle("on", this.state.photos);
  }

  /* ── smart display ────────────────────────────────────────────────── */
  render(cards, scores, ctx) {
    const main = this.$(".s-main");
    main.querySelectorAll(".s-group, .empty, h1.cq").forEach((e) => e.remove());
    this.$(".s-count").textContent = `${cards.length} results`;
    if (!cards.length) {
      main.insertAdjacentHTML("beforeend",
        `<div class="empty">No matches. Try a country ("liechtenstein"), a category ("bollards"), or both ("asian utility poles").</div>`);
      return;
    }
    if (ctx.country && !ctx.text) {
      main.insertAdjacentHTML("beforeend",
        `<h1 class="cq" style="font:600 20px var(--sans);margin:4px 0 0">Everything on ${esc(ctx.country)}</h1>`);
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
      div.innerHTML = `<h2>${esc(this.DATA.labels[g] || g)}<span class="n">${items.length}</span></h2>`;
      if (isPhotoGroup) div.appendChild(this.photoGrid(items, PHOTO_CAP));
      else div.appendChild(this.factList(items, FACT_CAP, ctx.text));
      main.appendChild(div);
    }
  }

  // Render a card's map link, one place for every card/link type. In the workbench
  // (onPick set) a recognised workbench deep link — a point OR a species
  // distribution — becomes an in-place action (no new tab, stays on the docked
  // wiki); an external link, or the standalone page, keeps target="_blank".
  //   label : link text;  ll : explicit [lat,lng] when the card carries structured coords.
  mapLinkHtml(c, label = "map", ll = null) {
    const intent = ll ? { kind: "point", ll } : wbIntent(c.map);
    if (this.onPick && intent) {
      return `<a href="#" class="s-pick" data-pick="${esc(JSON.stringify(intent))}">${label}</a>`;
    }
    const href = c.map || (ll ? `/app/index.html#ll=${ll[0]},${ll[1]}` : null);
    return href ? `<a href="${esc(href)}" target="_blank">${label}</a>` : "";
  }

  // Wire any in-place map links inside a container to onPick, passing the parsed
  // intent (the photo grid builds via insertAdjacentHTML, so listeners attach
  // after render). Idempotent so "show all" can re-run it.
  wirePicks(container) {
    if (!this.onPick) return;
    container.querySelectorAll("a.s-pick:not([data-wired])").forEach((a) => {
      a.dataset.wired = "1";
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        this.onPick(JSON.parse(a.dataset.pick));
      });
    });
  }

  photoGrid(items, cap) {
    const wrap = document.createElement("div");
    const grid = document.createElement("div");
    grid.className = "grid";
    const renderSlice = (from, to) => {
      items.slice(from, to).forEach((c) => {
        const links = [
          this.mapLinkHtml(c),
          c.page ? `<a href="${esc(c.page)}" target="_blank">wiki</a>` : "",
        ].filter(Boolean).join(" · ");
        const title = esc((c.c || []).join(", ") || c.t);
        // image-less cards (e.g. the flags "look-alike groups" tips) must NOT render
        // an empty <img> (it shows as a black box) — show them as a text tile instead.
        if (c.img) {
          grid.insertAdjacentHTML("beforeend",
            `<div class="pcard"><img src="${esc(c.img)}" loading="lazy" alt="">
             <div class="cap"><b>${title}</b><span>${links}</span></div></div>`);
        } else {
          grid.insertAdjacentHTML("beforeend",
            `<div class="pcard noimg"><div class="cap"><b>${title}</b>${
              c.x ? `<small>${esc(c.x)}</small>` : ""}<span>${links}</span></div></div>`);
        }
      });
      this.wirePicks(grid);
    };
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

  factList(items, cap, text) {
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
      // "⌖ open on map" uses the card's structured coords (fact cards carry `ll`).
      const map = c.ll ? this.mapLinkHtml(c, "⌖ open on map", c.ll) : "";
      const mapLink = map ? ` · ${map}` : "";
      // 9A.2 — in the workbench, a card can be logged to the case as a sourced observation
      const logLink = this.onLog ? ` · <a href="#" class="s-log">＋ log to case</a>` : "";
      const div = document.createElement("div");
      div.className = "fcard";
      div.innerHTML =
        `<b>${esc(c.t)}</b>${where && where !== c.t ? ` <span class="muted">(${esc(where)})</span>` : ""}
         ${c.img ? `<br><img src="${esc(c.img)}" alt="${esc(c.t || "reference image")}" loading="lazy" style="max-width:300px;border-radius:4px;margin:6px 0">` : ""}
         <div>${hl(esc(c.x || ""))}</div>
         <div class="src"><a href="${esc(c.page || "#")}" target="_blank">source page</a>${mapLink}${logLink}</div>`;
      this.wirePicks(div);
      if (this.onLog) {
        const a = div.querySelector(".s-log");
        if (a) a.addEventListener("click", (ev) => { ev.preventDefault(); this.onLog(c); });
      }
      wrap.appendChild(div);
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
}

let _mounted = null;
async function mount(rootEl, opts) {
  const ui = new SearchUI(rootEl, opts || {});
  _mounted = ui;
  await ui.init();
  return ui;
}
function focus() { if (_mounted) _mounted.focus(); }

return { mount, focus, wbIntent };   // wbIntent exported for tests (pure)
})();
