// ESLint flat config — DEV/CI TOOLING ONLY.
// The workbench itself runs with no Node (pure-stdlib server + vanilla browser
// JS, all scripts vendored locally). This config lints app/js to catch the
// silent defects no static check used to: typos in template-literal strings,
// unused vars, undeclared globals, accidental assignment in conditions.
const globals = require("globals");

// Vendored libraries loaded via <script> before app code.
const vendorGlobals = {
  L: "readonly",            // Leaflet
  SunCalc: "readonly",
  GeoCoords: "readonly",    // vendor/geocoords.js
  exifr: "readonly",
  MiniSearch: "readonly",
  GeoSearch: "readonly",
};

// App facade + the per-overlay data namespaces (#85 / #87). The facade
// (app-facade.js) gives panels a named surface over the shared state spine; the
// data overlays are self-contained IIFEs exposed as these globals. Declared
// readonly so no-undef resolves their use across the (separately-linted) files.
const appGlobals = {
  App: "readonly", DataPresets: "readonly",
  Overpass: "readonly", Gbif: "readonly", Cables: "readonly", Prefetch: "readonly",
  Sun: "readonly",
};

// Shared helpers DEFINED in app/js/common.js (loaded first). Declaring them as
// globals lets no-undef resolve their use in app.js / sun.js / search.js;
// common.js itself is linted without these so its own `const` declarations are
// the definitions, not redeclarations.
const commonGlobals = {
  $: "readonly", $$: "readonly", esc: "readonly", dataThumb: "readonly",
  fetchT: "readonly", cachedFetch: "readonly", cacheNote: "readonly",
  FETCH_TIMEOUT: "readonly", UPLOAD_TIMEOUT: "readonly",
  fmtDD: "readonly",
  parseCoords: "readonly", project: "readonly", drawSunChart: "readonly",
  fillUtcOffsets: "readonly", sunDate: "readonly", fmtClock: "readonly",
};

// Pure utilities DEFINED in app/js/coreutils.js (loaded before common.js): coord
// formatting + custody serialization (#89). Declared here so no-undef resolves
// their use in common.js / case.js / sun.js / search.js; coreutils.js itself is
// linted without these so its own declarations are the definitions.
const coreUtilsGlobals = {
  CoreUtils: "readonly", toDMS: "readonly", fmtDMS: "readonly",
  compassAz: "readonly", cardinal: "readonly",
  custodyCsv: "readonly", custodyJson: "readonly",
};

// Shared chronolocation engine DEFINED in app/js/chrono.js (loaded after
// common.js, before the solver modules). Same pattern as commonGlobals: declared
// here so no-undef resolves CHRONO/shadowAt/shadowFit in sun.js; chrono.js itself
// is linted without these so its own declarations are the definitions.
const chronoGlobals = {
  CHRONO: "readonly", shadowAt: "readonly", shadowFit: "readonly",
};

const sharedRules = {
  "no-undef": "error",
  "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
  "no-cond-assign": ["error", "always"],
  "no-constant-condition": ["error", { checkLoops: false }],
  "no-dupe-keys": "error",
  "no-unreachable": "error",
  "no-fallthrough": "error",
  "valid-typeof": "error",
  "use-isnan": "error",
  "no-self-assign": "error",
  "no-empty": ["warn", { allowEmptyCatch: true }],
};

const base = {
  languageOptions: { ecmaVersion: 2022, sourceType: "script" },  // classic <script> tags
  linterOptions: { reportUnusedDisableDirectives: true },
  rules: sharedRules,
};

module.exports = [
  {
    // coreutils.js DEFINES the pure utilities (CoreUtils + the toDMS/compassAz/
    // custodyCsv/… page globals). Like common.js: don't predeclare its own
    // surface and don't flag it "unused" (consumed by the other scripts/tests).
    ...base,
    files: ["app/js/coreutils.js"],
    languageOptions: { ...base.languageOptions, globals: { ...globals.browser, ...vendorGlobals } },
    rules: { ...sharedRules, "no-unused-vars": "off" },
  },
  {
    // common.js DEFINES the shared helpers — don't predeclare them here, and
    // don't flag them as "unused": they're the module's public surface, consumed
    // by the other scripts (which ESLint lints as separate files). It may use the
    // coreutils.js globals (loaded first).
    ...base,
    files: ["app/js/common.js"],
    languageOptions: { ...base.languageOptions, globals: { ...globals.browser, ...vendorGlobals, ...coreUtilsGlobals } },
    rules: { ...sharedRules, "no-unused-vars": "off" },
  },
  {
    // chrono.js DEFINES the shared shadow-solver engine (CHRONO + the shadowAt/
    // shadowFit page globals). Like common.js: don't predeclare its own surface
    // and don't flag it "unused" (consumed by the solver modules / tests).
    ...base,
    files: ["app/js/chrono.js"],
    languageOptions: { ...base.languageOptions, globals: { ...globals.browser, ...vendorGlobals, ...commonGlobals, ...coreUtilsGlobals } },
    rules: { ...sharedRules, "no-unused-vars": "off" },
  },
  {
    // The standalone Studio (sun.js) and the search module use common.js's +
    // coreutils.js's helpers (and, for sun.js, the chrono.js engine), so no-undef
    // can fully resolve their references.
    ...base,
    files: ["app/js/sun.js", "app/js/search.js"],
    languageOptions: { ...base.languageOptions, globals: { ...globals.browser, ...vendorGlobals, ...commonGlobals, ...coreUtilsGlobals, ...chronoGlobals } },
  },
  {
    // The workbench is ONE program split across app.js + modules/*.js (classic
    // <script>s sharing global scope, #31). They legitimately cross-reference
    // each other's top-level functions/consts, which a per-file linter can't see
    // — so no-undef is off for this set (common.js/coreutils.js/chrono.js/sun.js/
    // search.js keep it). Every other rule (unused vars, cond-assign, …) applies.
    ...base,
    files: ["app/js/app.js", "app/js/core.js", "app/js/app-facade.js", "app/js/map.js",
            "app/js/case.js", "app/js/dossier.js", "app/js/palette.js",
            "app/js/modules/**/*.js"],
    languageOptions: { ...base.languageOptions, globals: { ...globals.browser, ...vendorGlobals, ...appGlobals, ...commonGlobals, ...coreUtilsGlobals, ...chronoGlobals } },
    rules: { ...sharedRules, "no-undef": "off", "no-unused-vars": "off" },
  },
];
