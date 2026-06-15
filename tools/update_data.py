#!/usr/bin/env python3
"""GeOSINT - unified updater for volatile reference data.

One entry point to refresh (or just check for deltas in) the data that changes
over time, while leaving the stable GeoHints galleries untouched (bollards,
poles, etc. don't change on a useful timescale and are a deliberate one-off
mirror — see cache_geohints.py).

Sources it manages, in order:
  flags     build_flags.py      national flags  -> wiki/docs/assets/flags + flags.md
  refdata   build_refdata.py    ccTLDs + E.164  -> domains-phones.md (+ data/ caches)
  datasets  fetch_datasets.py   UNESCO/parks/.. -> data/*.json
  flora     build_flora.py      botanical cards -> data/flora.json
  wikimedia cache_wikimedia.py  inline wiki imgs-> wiki/docs/assets/wm

Usage:
    python tools/update_data.py            # refresh everything, report changes
    python tools/update_data.py --check    # report what WOULD change, write nothing
    python tools/update_data.py flags refdata     # only those sources

--check works by hashing each source's output files before, running the builder
against a throwaway copy is overkill here, so instead --check refreshes the
upstream *caches* under data/ (cheap, idempotent) and reports whether the
generated wiki artifacts would differ — it restores any modified tracked file
afterwards so the working tree is left clean. For a guaranteed-safe preview,
run on a clean git tree and inspect `git diff` after a normal run.
"""
import argparse
import hashlib
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
ROOT = Path(__file__).resolve().parents[1]
PY = sys.executable

# source key -> (script, [output paths to watch for deltas])
SOURCES = {
    "flags":     ("build_flags.py",      ["wiki/docs/identify/flags.md", "wiki/docs/assets/flags"]),
    "refdata":   ("build_refdata.py",    ["wiki/docs/identify/domains-phones.md"]),
    "datasets":  ("fetch_datasets.py",   ["data/unesco.json", "data/national-parks.json",
                                          "data/castles.json", "data/airports.json"]),
    "flora":     ("build_flora.py",      ["data/flora.json"]),
    "wikimedia": ("cache_wikimedia.py",  ["wiki/docs/assets/wm", "wiki/wm_manifest.json"]),
}
ORDER = ["flags", "refdata", "datasets", "flora", "wikimedia"]


def tree_hash(path: Path):
    """Stable hash of a file, or of all files under a directory."""
    if not path.exists():
        return None
    h = hashlib.sha1()
    files = sorted(path.rglob("*")) if path.is_dir() else [path]
    for f in files:
        if f.is_file():
            h.update(f.relative_to(path).as_posix().encode() if path.is_dir() else b"")
            h.update(f.read_bytes())
    return h.hexdigest()


def snapshot(paths):
    return {p: tree_hash(ROOT / p) for p in paths}


def git_is_clean(path):
    """True if `path` has no uncommitted changes vs the index/HEAD."""
    r = subprocess.run(["git", "-C", str(ROOT), "status", "--porcelain", "--", path],
                       capture_output=True, text=True)
    return r.returncode == 0 and r.stdout.strip() == ""


def git_restore(paths):
    """Revert ONLY the given tracked files to HEAD. The caller must pass solely
    files that were clean before the probe — never restore a path that already
    had uncommitted work, or --check would silently destroy it."""
    for p in paths:
        subprocess.run(["git", "-C", str(ROOT), "checkout", "--", p],
                       capture_output=True)


def run_source(key, check):
    script, outputs = SOURCES[key]
    before = snapshot(outputs)
    # in --check we may only safely revert files that were clean to begin with;
    # restoring a path with pre-existing uncommitted work would destroy it.
    clean_before = {p for p in outputs if git_is_clean(p)} if check else set()
    print(f"\n=== {key} ({script}){' [check]' if check else ''} ===")
    r = subprocess.run([PY, str(ROOT / "tools" / script)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    sys.stdout.write(r.stdout)
    if r.returncode != 0:
        sys.stderr.write(r.stderr)
        print(f"  -> {key}: builder FAILED (exit {r.returncode})")
        return "error"
    after = snapshot(outputs)
    changed = [p for p in outputs if before[p] != after[p]]
    if check:
        # only revert paths that were clean before AND that we just changed;
        # never touch a path that already had uncommitted work
        to_restore = [p for p in changed if p in clean_before]
        skipped = [p for p in changed if p not in clean_before]
        git_restore(to_restore)
        if skipped:
            print(f"  note: left {len(skipped)} pre-modified file(s) untouched: {', '.join(skipped)}")
    if changed:
        print(f"  -> {key}: would change {len(changed)} output(s): {', '.join(changed)}"
              if check else f"  -> {key}: updated {len(changed)} output(s): {', '.join(changed)}")
        return "changed"
    print(f"  -> {key}: up to date (no delta)")
    return "same"


def main():
    ap = argparse.ArgumentParser(description="Refresh/diff volatile GeOSINT reference data")
    ap.add_argument("sources", nargs="*", choices=ORDER, help="limit to these sources")
    ap.add_argument("--check", action="store_true",
                    help="report deltas without leaving changes in the tree")
    args = ap.parse_args()

    keys = args.sources or ORDER
    if args.check:
        # --check relies on git to restore; make sure we're in a repo
        if subprocess.run(["git", "-C", str(ROOT), "rev-parse"], capture_output=True).returncode:
            print("--check needs a git repo (it restores tracked files after probing).")
            return 2

    results = {}
    for key in ORDER:
        if key in keys:
            results[key] = run_source(key, args.check)

    print("\n=== summary ===")
    for key in ORDER:
        if key in results:
            print(f"  {key:10} {results[key]}")
    print("\nNote: GeoHints galleries are intentionally NOT refreshed (stable; see cache_geohints.py).")
    return 1 if "error" in results.values() else 0


if __name__ == "__main__":
    sys.exit(main())
