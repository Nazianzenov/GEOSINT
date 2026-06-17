# GeOSINT case file format (`*.geosint.json`)

A case is a single self-contained JSON file. **It is the unit of sharing** — hand
it to a colleague and they open the exact workspace (point, view, annotations,
evidence log, module inputs, notes). It's plain client-side download/upload:
nothing is uploaded by the app, and the file is portable across machines and OSes.

This is a **stable, documented format**. Tools may read/write it as long as they
honour the `app` guard and the `version`.

## Top-level shape

```jsonc
{
  "app": "geosint-workbench",   // REQUIRED guard — applyCase rejects anything else
  "version": 2,                 // schema version (CASE_VERSION); bump on breaking changes
  "saved": "2026-06-17T12:00:00.000Z",  // ISO timestamp the file was written

  "point":  { "lat": 48.8584, "lng": 2.2945 } | null,   // active point
  "view":   { "lat": 48.86, "lng": 2.29, "zoom": 14 },  // map camera
  "module": "sun" | "weather" | "image" | "tools" | "data" | "anno" | "wiki" | null,

  "measure": [[lat, lng], …],   // ruler vertices
  "annos":   [ { "type": "pin"|"label"|"arrow", "ll": [lat,lng], "ll2": [lat,lng]?, "text": "…" }, … ],
  "gbif":    [ { "key": <taxonKey>, "name": "…" }, … ],  // species overlays to re-add
  "data":    { "label": "…" } | null,                   // last data-layer preset label
  "notes":   "free-text case notes",

  "artifacts": [ <artifact>, … ],   // the evidence log (see below)

  "inputs": {                       // verbatim module form fields, restored on load
    "sunDt", "sunOffset", "solverAz", "solverRatio", "solverTol",
    "solverAz2", "solverRatio2", "solverDt2", "wxDate", "imgUrl",
    "dataPreset", "dataCustom", "gbifName"
  }
}
```

## Artifact (evidence log entry)

```jsonc
{
  "id": 1,                         // stable within the case
  "kind": "image"|"note"|"point"|"obs",
  "t": "2023-06-15T14:30:00.000Z", // observed/added time (ISO)
  "source": "filename or URL",     // provenance (optional)
  "sha256": "…",                   // image artifacts: SHA-256 of the ORIGINAL bytes
  "ll": [lat, lng],                // location (optional)
  "text": "…",                     // observations/notes (optional)
  "thumb": "data:image/jpeg;base64,…",  // ≤160px thumbnail (images; never the full image)
  "links": [ <id>, … ],            // related artifact ids → case relationship graph
  "meta": { "added", "size", "camera", "taken" }   // optional extras
}
```

Notes:
- Images store a **SHA-256 of the original bytes + a small thumbnail only** —
  never the full image. Originals stay on the analyst's disk; the hash gives
  defensible provenance.
- `links` builds the relationships rendered in the dossier; **back-compatible** —
  a missing `links` is treated as empty.

## Compatibility rules

- A reader **must** check `app === "geosint-workbench"` and reject otherwise
  (`applyCase` does this).
- Unknown fields should be ignored, not dropped on round-trip where practical.
- Within a `version`, fields are only added, never repurposed. A breaking change
  bumps `version`; `applyCase` is responsible for migrating/validating older
  files. (v1 had no `artifacts`; v2 added the evidence log — a v2 reader treats a
  missing `artifacts` as `[]`.)

## Derived exports (not the case file)

- **Chain-of-custody** CSV/JSON (`exportCustody`) — a flat provenance table /
  thumbnail-stripped artifact list for a report appendix.
- **Dossier** HTML (`exportDossier`) — a self-contained narrative report; the
  **redacted** variant coarsens coordinates and strips source URLs/filenames/notes
  while keeping findings and provenance hashes, for publication.

These are one-way outputs; the `*.geosint.json` remains the editable source of truth.
