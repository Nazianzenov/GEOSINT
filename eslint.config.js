// ESLint flat config — DEV/CI TOOLING ONLY.
// The workbench itself runs with no Node (pure-stdlib server + vanilla browser
// JS, all scripts vendored locally). This config lints app/js to catch the
// silent defects no static check used to: typos in template-literal strings,
// unused vars, undeclared globals, accidental assignment in conditions.
const globals = require("globals");

module.exports = [
  {
    files: ["app/js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script", // classic <script> tags, not ES modules
      globals: {
        ...globals.browser,
        // Vendored libraries (loaded via <script> before app code)
        L: "readonly",            // Leaflet
        SunCalc: "readonly",
        GeoCoords: "readonly",    // vendor/geocoords.js
        exifr: "readonly",
        MiniSearch: "readonly",
        GeoSearch: "readonly",
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      // The app's three scripts share top-level functions across files (classic
      // global scope), so cross-file references are expected — but a genuinely
      // undeclared name is still a real bug. no-undef stays on; the shared
      // globals are declared per-file via the inline /* global */ comments the
      // files already carry (or added as part of this gate).
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
    },
  },
];
