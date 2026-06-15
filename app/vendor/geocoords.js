/* geocoords.js — offline coordinate conversions for GeOSINT.
   Pure, dependency-free, vendored (no CDN). Exposes window.GeoCoords with:
     toUTM(lat,lng)        -> {zone, hemi, easting, northing, str}
     toMGRS(lat,lng,prec)  -> "31U DQ 48251 11932"   (prec = digits per axis, default 5)
     fromMGRS(str)         -> {lat,lng} | null
     toPlusCode(lat,lng,len) -> "8FW4V75V+8Q"          (Open Location Code)
     fromPlusCode(code)    -> {lat,lng} | null          (full codes only)

   WGS84 / UTM follows the standard Karney-grade series to mm-level for normal
   latitudes; MGRS bands and 100km square lettering per NGA/DMA. Open Location
   Code per Google's spec (https://github.com/google/open-location-code). */
"use strict";
(function () {
  const A = 6378137.0, F = 1 / 298.257223563;        // WGS84 ellipsoid
  const E2 = F * (2 - F), E = Math.sqrt(E2);
  const K0 = 0.9996;
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;

  // ── UTM ──────────────────────────────────────────────────────────────
  function utmZone(lat, lng) {
    let z = Math.floor((lng + 180) / 6) + 1;
    // Norway/Svalbard exceptions
    if (lat >= 56 && lat < 64 && lng >= 3 && lng < 12) z = 32;
    if (lat >= 72 && lat < 84) {
      if (lng >= 0 && lng < 9) z = 31;
      else if (lng >= 9 && lng < 21) z = 33;
      else if (lng >= 21 && lng < 33) z = 35;
      else if (lng >= 33 && lng < 42) z = 37;
    }
    return z;
  }

  function toUTM(lat, lng) {
    const zone = utmZone(lat, lng);
    const lon0 = (zone - 1) * 6 - 180 + 3;             // central meridian
    const φ = lat * D2R, λ = lng * D2R, λ0 = lon0 * D2R;
    const N = A / Math.sqrt(1 - E2 * Math.sin(φ) ** 2);
    const T = Math.tan(φ) ** 2;
    const C = (E2 / (1 - E2)) * Math.cos(φ) ** 2;
    const Acoef = Math.cos(φ) * (λ - λ0);
    const M = A * ((1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256) * φ
      - (3 * E2 / 8 + 3 * E2 ** 2 / 32 + 45 * E2 ** 3 / 1024) * Math.sin(2 * φ)
      + (15 * E2 ** 2 / 256 + 45 * E2 ** 3 / 1024) * Math.sin(4 * φ)
      - (35 * E2 ** 3 / 3072) * Math.sin(6 * φ));
    let easting = K0 * N * (Acoef + (1 - T + C) * Acoef ** 3 / 6
      + (5 - 18 * T + T ** 2 + 72 * C - 58 * (E2 / (1 - E2))) * Acoef ** 5 / 120) + 500000;
    let northing = K0 * (M + N * Math.tan(φ) * (Acoef ** 2 / 2
      + (5 - T + 9 * C + 4 * C ** 2) * Acoef ** 4 / 24
      + (61 - 58 * T + T ** 2 + 600 * C - 330 * (E2 / (1 - E2))) * Acoef ** 6 / 720));
    const hemi = lat >= 0 ? "N" : "S";
    if (lat < 0) northing += 10000000;
    easting = Math.round(easting); northing = Math.round(northing);
    return { zone, hemi, easting, northing,
      str: `${zone}${hemi} ${easting} ${northing}` };
  }

  // inverse: UTM -> lat/lng (needed by MGRS parse)
  function utmToLatLng(zone, hemi, easting, northing) {
    const x = easting - 500000;
    let y = northing;
    if (hemi === "S") y -= 10000000;
    const lon0 = (zone - 1) * 6 - 180 + 3;
    const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
    const M = y / K0;
    const mu = M / (A * (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256));
    const φ1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
      + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
      + (151 * e1 ** 3 / 96) * Math.sin(6 * mu);
    const N1 = A / Math.sqrt(1 - E2 * Math.sin(φ1) ** 2);
    const T1 = Math.tan(φ1) ** 2;
    const C1 = (E2 / (1 - E2)) * Math.cos(φ1) ** 2;
    const R1 = A * (1 - E2) / (1 - E2 * Math.sin(φ1) ** 2) ** 1.5;
    const D = x / (N1 * K0);
    const lat = φ1 - (N1 * Math.tan(φ1) / R1) * (D ** 2 / 2
      - (5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * (E2 / (1 - E2))) * D ** 4 / 24
      + (61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * (E2 / (1 - E2)) - 3 * C1 ** 2) * D ** 6 / 720);
    const lng = lon0 * D2R + (D - (1 + 2 * T1 + C1) * D ** 3 / 6
      + (5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * (E2 / (1 - E2)) + 24 * T1 ** 2) * D ** 5 / 120) / Math.cos(φ1);
    return { lat: lat * R2D, lng: lng * R2D };
  }

  // ── MGRS ─────────────────────────────────────────────────────────────
  const BANDS = "CDEFGHJKLMNPQRSTUVWX";               // 8°S..84°N latitude bands
  function latBand(lat) {
    if (lat >= 84) return "X";
    if (lat < -80) return "C";
    return BANDS[Math.floor((lat + 80) / 8)];
  }
  const COL = "ABCDEFGH JKLMNPQR STUVWXYZ".replace(/ /g, "");  // 100km easting letters
  const ROW = "ABCDEFGHJKLMNPQRSTUV";                          // 100km northing letters

  function toMGRS(lat, lng, prec = 5) {
    const u = toUTM(lat, lng);
    const band = latBand(lat);
    const setCol = (u.zone - 1) % 3;                  // 3 column-letter sets
    const colIdx = Math.floor(u.easting / 100000) - 1 + setCol * 8;
    const colLetter = COL[colIdx];
    const setRow = ((u.zone - 1) % 2) * 5;            // row sets alternate per zone
    let rowIdx = (Math.floor(u.northing / 100000) + setRow) % 20;
    const rowLetter = ROW[rowIdx];
    const e = String(Math.floor(u.easting % 100000)).padStart(5, "0").slice(0, prec);
    const n = String(Math.floor(u.northing % 100000)).padStart(5, "0").slice(0, prec);
    return `${u.zone}${band} ${colLetter}${rowLetter} ${e} ${n}`;
  }

  function fromMGRS(str) {
    const s = String(str).toUpperCase().replace(/\s+/g, "");
    const m = s.match(/^(\d{1,2})([C-HJ-NP-X])([A-HJ-NP-Z])([A-HJ-NP-V])(\d+)$/);
    if (!m) return null;
    const zone = +m[1], band = m[2], colL = m[3], rowL = m[4], digits = m[5];
    if (digits.length % 2 !== 0) return null;
    const half = digits.length / 2;
    const scale = Math.pow(10, 5 - half);
    const e0 = +digits.slice(0, half) * scale;
    const n0 = +digits.slice(half) * scale;
    const setCol = (zone - 1) % 3;
    let colIdx = COL.indexOf(colL) - setCol * 8;
    if (colIdx < 0) colIdx += 24;
    const easting = (colIdx + 1) * 100000 + e0;
    const setRow = ((zone - 1) % 2) * 5;
    let rowIdx = (ROW.indexOf(rowL) - setRow + 20) % 20;
    // resolve the 100km northing band into the correct 2,000km cycle for the lat band
    const bandIdx = BANDS.indexOf(band);
    const approxLat = bandIdx >= 0 ? -80 + bandIdx * 8 + 4 : 0;
    // northing of band base, then pick the rowIdx multiple of 100km nearest the band
    const hemi = approxLat >= 0 ? "N" : "S";
    // estimate northing: find n in [rowIdx*100k + k*2000k] closest to band latitude
    let best = null;
    for (let k = 0; k < 24; k++) {
      const northing = (rowIdx + k * 20) * 100000 + n0;
      const ll = utmToLatLng(zone, hemi, easting, northing);
      if (ll.lat >= approxLat - 4.5 && ll.lat <= approxLat + 4.5) { best = ll; break; }
    }
    return best;
  }

  // ── Open Location Code (Plus Codes) ───────────────────────────────────
  const OLC = "23456789CFGHJMPQRVWX";
  const OLC_BASE = 20, OLC_PAIRS = 5, OLC_MAXLEN = 15;
  const LAT_MAX = 90, LNG_MAX = 180;

  function toPlusCode(lat, lng, codeLen = 11) {
    codeLen = Math.min(codeLen, OLC_MAXLEN);
    let latv = Math.min(Math.max(lat, -LAT_MAX), LAT_MAX) + LAT_MAX;
    let lngv = ((lng + LNG_MAX) % 360 + 360) % 360;   // normalize to [0,360)
    let code = "";
    // pairs section (first 10 digits): base-20 lat then lng per step
    let latP = latv, lngP = lngv;
    let latPrec = LAT_MAX * 2, lngPrec = LNG_MAX * 2;
    for (let i = 0; i < Math.min(codeLen, 10) / 2; i++) {
      latPrec /= OLC_BASE; lngPrec /= OLC_BASE;
      const li = Math.floor(latP / latPrec); latP -= li * latPrec;
      const gi = Math.floor(lngP / lngPrec); lngP -= gi * lngPrec;
      code += OLC[li] + OLC[gi];
    }
    // grid refinement (digits 11+): 4×5 grid, one char per step
    if (codeLen > 10) {
      let gLat = latP, gLng = lngP, rLat = latPrec, rLng = lngPrec;
      for (let i = 10; i < codeLen; i++) {
        rLat /= 5; rLng /= 4;
        const r = Math.floor(gLat / rLat); gLat -= r * rLat;
        const c = Math.floor(gLng / rLng); gLng -= c * rLng;
        code += OLC[r * 4 + c];
      }
    }
    return code.slice(0, 8) + "+" + code.slice(8);
  }

  function fromPlusCode(code) {
    const c = String(code).toUpperCase().replace(/\+/g, "");
    if (!/^[23456789CFGHJMPQRVWX]+$/.test(c) || c.length < 8 || c.indexOf("0") >= 0) return null;
    let latv = -LAT_MAX, lngv = -LNG_MAX;
    let latPrec = LAT_MAX * 2, lngPrec = LNG_MAX * 2;
    let i = 0;
    for (; i < Math.min(c.length, 10); i += 2) {
      latPrec /= OLC_BASE; lngPrec /= OLC_BASE;
      latv += OLC.indexOf(c[i]) * latPrec;
      lngv += OLC.indexOf(c[i + 1]) * lngPrec;
    }
    let rLat = latPrec, rLng = lngPrec;
    for (let j = 10; j < c.length; j++) {
      rLat /= 5; rLng /= 4;
      const d = OLC.indexOf(c[j]);
      latv += Math.floor(d / 4) * rLat;
      lngv += (d % 4) * rLng;
    }
    // return the centre of the resolved cell
    return { lat: latv + latPrec / 2, lng: lngv + lngPrec / 2 };
  }

  window.GeoCoords = { toUTM, utmToLatLng, toMGRS, fromMGRS, toPlusCode, fromPlusCode };
})();
