# Contributing to the GeOSINT Workbench

Thanks for helping build the field knowledge base. The highest-leverage
contribution is **sourced recognition content** — bollards, plates, scripts,
architecture, signage, vegetation, etc. — because the wiki's depth is what makes
the identify workflow work.

## Ground rule: every claim is referenced

A recognition card without a source is a liability, not an asset. Each fact must
cite a standard, paper, maintained community catalogue, or a primary image with
provenance. Unsourced "looks like X" claims will be asked for a reference.

## How the knowledge base becomes searchable

You don't hand-write cards. You write **Markdown** in `wiki/docs/`, and
`tools/build_search_index.py` extracts every atomic fact into a tagged "card"
that powers the smart search and the knowledge graph. The extractor recognises:

- **Bold lead entries** in a list — `**Term** — description` becomes a fact card,
  inheriting the page's category and any country/continent context.
- **Image galleries** — images under a recognised gallery become photo cards.
- **World-index tables** — per-country rows become country-tagged cards.
- **Page cards** — each page itself is a card.

A card carries these fields (set by the extractor from your Markdown — see
`tools/build_search_index.py`):

| Field | Meaning |
|---|---|
| `t` | title / term |
| `x` | searchable text (description) |
| `g` | category (e.g. `bollards`, `license-plates`, `architecture`) |
| `c` | countries the card applies to |
| `k` | continent |
| `ll` | `[lat, lng]` when the fact has a location |
| `img` | image URL for photo cards |
| `page` | the source wiki page URL (the card's citation) |

So: **put the fact on the right page, in the right shape, with a source link, and
the indexer does the rest.** Categories live in `PAGE_CATEGORY` / `CATEGORY_LABEL`
in the builder — reuse an existing one or add a new key there if you're starting
a new catalogue.

## Adding content — workflow

1. Edit or add a Markdown page under `wiki/docs/` (mirror an existing page in the
   same category for structure and the bold-entry convention).
2. Cite sources inline (a link per claim, or a page-level source list).
3. Rebuild + preview:
   ```
   ./run.ps1 -RebuildWiki     # Windows;  ./run.sh --rebuild-wiki  on macOS/Linux
   ```
   or just the index: `python tools/build_search_index.py`.
4. Open the workbench, press `5` (Wiki Search), and confirm your cards appear
   with the right category/country facets and a working source link.

## Code contributions

- The **server is pure Python stdlib** — keep it that way (no runtime pip deps).
  Build-time tooling goes in `requirements-build.txt`.
- Cross-platform: no Windows-only assumptions in detection/launch (`server.py`
  branches on `IS_WIN`/`IS_MAC`/`IS_LINUX`).
- Run the tests: `python -m pytest tests/ -q`.
- The case file is a documented exchange format — see
  [docs/CASE-FORMAT.md](docs/CASE-FORMAT.md); don't break it without bumping
  `CASE_VERSION` and handling back-compat in `applyCase`.
- Security: all attacker-influenceable strings (EXIF, geocoder, OSM tags, pasted
  findings) must be `esc()`-escaped before reaching `innerHTML` or a dossier.

## Doctrine (non-negotiable)

Local-first, no telemetry, no required cloud, **no AI geolocation**. Anything that
leaves the machine must be opt-in and disclosed. Contributions that phone home or
bundle a hosted dependency won't be merged.
