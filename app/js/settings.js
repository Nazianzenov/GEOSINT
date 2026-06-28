/* GeOSINT Workbench — OPSEC egress settings page (Axis A).
   Standalone page (settings.html): edits geosint/egress.py's per-feature routing
   config via /api/opsec. Self-contained — defines its own tiny $ / esc and talks
   to the local API over fetch; no shared app globals. */
"use strict";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const FEATURE_LABELS = {
  tiles: "Map tiles", geocode: "Geocoding (Nominatim)",
  weather: "Weather / elevation (Open-Meteo)", overpass: "OSM features (Overpass)",
  gbif: "Species overlay (GBIF)", media: "Wiki reference images",
};
const SCHEMES = ["http", "https", "socks5", "socks5h"];

let CFG = null;        // the working config (mutated by the form)
let FEATURES = [];

function msg(text, isErr) {
  const m = $("#msg");
  m.hidden = !text;
  m.textContent = text || "";
  m.style.color = isErr ? "#ff6b6b" : "#7CFC9B";
}

function routeOptions(selected) {
  const opts = [
    ["direct", "Direct (real IP / system VPN)"],
    ["vpn", "VPN (verified exit)"],
    ["tor", "Tor (socks5h)"],
  ];
  Object.keys(CFG.proxies).forEach((id) => opts.push(["proxy:" + id, "Proxy: " + id]));
  return opts.map(([v, l]) =>
    `<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(l)}</option>`).join("");
}

function proxyRow(id, p) {
  return `<div class="prow" data-id="${esc(id)}">
    <label class="inline">id <input class="px-id" value="${esc(id)}" size="8"></label>
    <label class="inline">scheme <select class="px-scheme">${
      SCHEMES.map((s) => `<option${s === p.scheme ? " selected" : ""}>${s}</option>`).join("")
    }</select></label>
    <label class="inline">host <input class="px-host" value="${esc(p.host)}"></label>
    <label class="inline">port <input class="px-port" type="number" value="${esc(p.port)}"></label>
    <label class="inline">user <input class="px-user" value="${esc(p.user || "")}" size="8"></label>
    <label class="inline">pass <input class="px-pass" type="password" value="${esc(p.pass || "")}" size="8"></label>
    <button class="btn px-del" title="remove">✕</button>
  </div>`;
}

function renderProxies() {
  const entries = Object.entries(CFG.proxies);
  $("#proxies").innerHTML = entries.length
    ? entries.map(([id, p]) => proxyRow(id, p)).join("")
    : '<p class="muted">No proxies configured.</p>';
}

function render() {
  $("#routes").innerHTML = FEATURES.map((f) =>
    `<tr><td>${esc(FEATURE_LABELS[f] || f)}</td>
     <td><select data-feat="${esc(f)}">${routeOptions(CFG.routes[f] || "direct")}</select></td></tr>`).join("");
  $("#vpn-provider").value = CFG.vpn.provider || "";
  $("#vpn-verify").checked = !!CFG.vpn.verify;
  $("#vpn-match").value = CFG.vpn.match || "";
  renderProxies();
  $("#tor-host").value = CFG.tor.host;
  $("#tor-port").value = CFG.tor.port;
  const mode = (CFG.ua === "default" || CFG.ua === "neutral") ? CFG.ua : "custom";
  $("#ua-mode").value = mode;
  $("#ua-custom").hidden = mode !== "custom";
  if (mode === "custom") $("#ua-custom").value = CFG.ua;
}

/* Read the form back into a config object. A password left as the masked sentinel
   ("********") is sent verbatim — the server keeps the stored secret rather than
   overwriting it with the mask. */
function collect() {
  const routes = {};
  document.querySelectorAll('#routes select[data-feat]').forEach((s) => {
    routes[s.getAttribute("data-feat")] = s.value;
  });
  const proxies = {};
  document.querySelectorAll(".prow").forEach((row) => {
    const id = row.querySelector(".px-id").value.trim();
    if (!id) return;
    proxies[id] = {
      scheme: row.querySelector(".px-scheme").value,
      host: row.querySelector(".px-host").value.trim(),
      port: Number(row.querySelector(".px-port").value) || 0,
      user: row.querySelector(".px-user").value,
      pass: row.querySelector(".px-pass").value,
    };
  });
  const uaMode = $("#ua-mode").value;
  const ua = uaMode === "custom" ? ($("#ua-custom").value.trim() || "default") : uaMode;
  return {
    version: 1, routes, proxies,
    vpn: { provider: $("#vpn-provider").value || null, verify: $("#vpn-verify").checked,
           match: $("#vpn-match").value.trim() },
    tor: { host: $("#tor-host").value.trim() || "127.0.0.1", port: Number($("#tor-port").value) || 9050 },
    ua,
  };
}

function describeCheck(j) {
  if (!j || j.ok === false) return "egress check failed (is the route reachable?)";
  const label = j.provider || "VPN";
  let onVpn;
  if (j.on_vpn === true) {
    onVpn = `✓ on ${label}`;
  } else if (j.on_vpn === false) {
    onVpn = `✗ NOT on ${label} — VPN-routed features are blocked. If this IS your VPN, ` +
            'copy a distinctive word from the Org/AS above into "expected exit" and Save.';
  } else {
    onVpn = '(can’t auto-verify — if this is your VPN, set "expected exit" to a word from the Org/AS above)';
  }
  return `IP ${j.ip || "?"} · ${j.country || "?"} · ${j.org || "?"} · ${onVpn}`;
}

async function load() {
  try {
    const r = await fetch("/api/opsec");
    const j = await r.json();
    CFG = j.config;
    FEATURES = j.features || Object.keys(CFG.routes);
    render();
  } catch {
    msg("Could not load OPSEC config — is the workbench server running?", true);
  }
}

async function save() {
  try {
    const r = await fetch("/api/opsec", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-GeOSINT": "1" },
      body: JSON.stringify({ config: collect() }),
    });
    const j = await r.json();
    if (!r.ok || j.ok === false) { msg(j.error || "save failed", true); return; }
    CFG = j.config;
    render();
    msg("Saved." + (j.check ? "  Egress: " + describeCheck(j.check) : ""));
  } catch {
    msg("save failed (network error)", true);
  }
}

async function check() {
  msg("Checking egress…");
  $("#check-result").textContent = "";
  try {
    const r = await fetch("/api/opsec/check");
    const j = await r.json();
    $("#check-result").textContent = describeCheck(j);
    msg("");
  } catch {
    $("#check-result").textContent = "egress check failed (network error)";
    msg("");
  }
}

function recommended() {
  FEATURES.forEach((f) => { CFG.routes[f] = "vpn"; });
  if (!CFG.vpn.provider) CFG.vpn.provider = "protonvpn";
  CFG.vpn.verify = true;
  render();
  msg("Recommended preset applied — pick your VPN provider, then Save. " +
      "Tip: switch geocoding to a residential proxy or Tor for your most sensitive lookups.");
}

function addProxy() {
  let i = 1;
  while (CFG.proxies["res" + i]) i++;
  CFG.proxies["res" + i] = { scheme: "http", host: "", port: 1080, user: "", pass: "" };
  renderProxies();
}

document.addEventListener("DOMContentLoaded", () => {
  $("#save").addEventListener("click", save);
  $("#check").addEventListener("click", check);
  $("#recommended").addEventListener("click", recommended);
  $("#add-proxy").addEventListener("click", addProxy);
  $("#ua-mode").addEventListener("change", () => {
    $("#ua-custom").hidden = $("#ua-mode").value !== "custom";
  });
  // delete-proxy via event delegation (rows are re-rendered)
  $("#proxies").addEventListener("click", (e) => {
    const btn = e.target.closest(".px-del");
    if (!btn) return;
    e.preventDefault();
    const id = btn.closest(".prow").getAttribute("data-id");
    delete CFG.proxies[id];
    FEATURES.forEach((f) => { if (CFG.routes[f] === "proxy:" + id) CFG.routes[f] = "direct"; });
    render();
  });
  load();
});
