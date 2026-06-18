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

// Shared helpers DEFINED in app/js/common.js (loaded first). Declaring them as
// globals lets no-undef resolve their use in app.js / sun.js / search.js;
// common.js itself is linted without these so its own `const` declarations are
// the definitions, not redeclarations.
const commonGlobals = {
  $: "readonly", $$: "readonly", esc: "readonly", dataThumb: "readonly",
  fetchT: "readonly", cachedFetch: "readonly", cacheNote: "readonly",
  FETCH_TIMEOUT: "readonly", UPLOAD_TIMEOUT: "readonly",
  fmtDD: "readonly", toDMS: "readonly", fmtDMS: "readonly",
  compassAz: "readonly", cardinal: "readonly",
  parseCoords: "readonly", project: "readonly", drawSunChart: "readonly",
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
    // common.js DEFINES the shared helpers — don't predeclare them here, and
    // don't flag them as "unused": they're the module's public surface, consumed
    // by app.js / sun.js / search.js (which ESLint lints as separate files).
    ...base,
    files: ["app/js/common.js"],
    languageOptions: { ...base.languageOptions, globals: { ...globals.browser, ...vendorGlobals } },
    rules: { ...sharedRules, "no-unused-vars": "off" },
  },
  {
    // consumers USE the shared helpers (defined in common.js).
    ...base,
    files: ["app/js/app.js", "app/js/sun.js", "app/js/search.js"],
    languageOptions: { ...base.languageOptions, globals: { ...globals.browser, ...vendorGlobals, ...commonGlobals } },
  },
];
