#!/usr/bin/env python3
"""GeOSINT — the single source of truth for the "rebuild everything" pipeline.

The wiki/data build used to be encoded three times, differently: run.ps1 ran the
full set (flags, refdata, geohints, gallery, …), while run.sh and
`python -m geosint` ran only a thin subset — so a macOS/Linux or `python -m`
user got a thinner wiki than a Windows user (#90). This module defines the
ordered, named step list ONCE; run.ps1, run.sh and geosint/__main__.py all call
it, so every platform builds the same artifacts.

Each step is run as a subprocess with a chosen interpreter (the launcher's venv
Python), mirroring how the shell scripts already invoke the tools. A step is
either REQUIRED (its failure aborts the build — mkdocs and the search index) or
BEST-EFFORT (network-dependent fetches/caches: logged and skipped on failure,
exactly as the scripts' `|| true` / `try` did).

Usage:
  python tools/build_all.py [--python PATH] [--mkdocs PATH] [--rebuild]
    --python   interpreter to run the tool steps with (default: this interpreter)
    --mkdocs   mkdocs executable (default: "mkdocs" on PATH)
    --rebuild  force a full rebuild even if wiki/site/index.html already exists
Exit code is non-zero only if a REQUIRED step fails.
"""
import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent       # repo root


# (name, kind, argv-builder) — kind: "py" runs a tool with the chosen python;
# "mkdocs" runs the mkdocs build. required=False means best-effort (network).
class Step:
    def __init__(self, tool, *, required, kind="py"):
        self.tool = tool
        self.required = required
        self.kind = kind

    @property
    def name(self):
        return "mkdocs build" if self.kind == "mkdocs" else self.tool


# THE pipeline. Order matters: data fetch/caches -> generated assets ->
# mkdocs site -> search index (which reads the built site + assets).
PIPELINE = [
    Step("tools/fetch_datasets.py", required=False),         # upstream datasets (network)
    Step("tools/build_flora.py", required=False),            # flora pages (network)
    Step("tools/cache_wikimedia.py", required=False),        # image cache (network)
    Step("tools/cache_geohints.py", required=False),         # geo hints (network)
    Step("tools/build_flags.py", required=False),            # national flags
    Step("tools/build_subnational_flags.py", required=False),# subnational flags
    Step("tools/build_commons_gallery.py", required=False),  # commons gallery
    Step("tools/build_refdata.py", required=False),          # reference data
    Step("", required=True, kind="mkdocs"),                  # build the MkDocs site
    Step("tools/build_search_index.py", required=True),      # search index (reads the site)
]


def _run(argv):
    print("[geosint]", " ".join(str(a) for a in argv), flush=True)
    return subprocess.run([str(a) for a in argv], cwd=str(ROOT))


def build_all(python=None, mkdocs="mkdocs", rebuild=False):
    """Run the full pipeline. Returns True on success (all REQUIRED steps ok)."""
    python = python or sys.executable
    site = ROOT / "wiki" / "site" / "index.html"
    index = ROOT / "app" / "data" / "search-index.json"

    if not rebuild and site.exists():
        # Already built; only ensure the search index exists (cheap, no network).
        if not index.exists():
            r = _run([python, "tools/build_search_index.py"])
            if r.returncode != 0:
                print("[geosint] ERROR: search index build failed", file=sys.stderr)
                return False
        return True

    for step in PIPELINE:
        if step.kind == "mkdocs":
            argv = [mkdocs, "build", "-f", str(ROOT / "wiki" / "mkdocs.yml")]
        else:
            argv = [python, step.tool]
        r = _run(argv)
        if r.returncode != 0:
            if step.required:
                print(f"[geosint] ERROR: required step failed: {step.name}", file=sys.stderr)
                return False
            print(f"[geosint] WARN: optional step failed (continuing): {step.name}",
                  file=sys.stderr)
    return True


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build the GeOSINT wiki + data artifacts.")
    ap.add_argument("--python", default=sys.executable,
                    help="interpreter for the tool steps (default: this interpreter)")
    ap.add_argument("--mkdocs", default="mkdocs", help="mkdocs executable (default: mkdocs)")
    ap.add_argument("--rebuild", action="store_true",
                    help="force a full rebuild even if the wiki is already built")
    args = ap.parse_args(argv)
    ok = build_all(python=args.python, mkdocs=args.mkdocs, rebuild=args.rebuild)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
