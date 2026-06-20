"""Unit tests for the shared build pipeline (tools/build_all.py, #90).

We stub subprocess so no tool actually runs: the contract under test is the step
LIST, ORDER, and required-vs-optional failure handling — the thing that used to
be forked across run.ps1 / run.sh / __main__.py."""
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import build_all  # noqa: E402


def _stub_runs(monkeypatch, fail=()):
    """Record each argv build_all would run; fake returncode 1 for any argv whose
    last path component is in `fail` (so we can target a specific step)."""
    calls = []

    def fake_run(argv, **kw):
        calls.append(argv)
        last = Path(str(argv[-1])).name if argv[-1] else ""
        # mkdocs build's argv ends in mkdocs.yml; key it as "mkdocs"
        tag = "mkdocs" if any("mkdocs" in str(a) for a in argv[:1]) else last
        rc = 1 if tag in fail else 0
        return types.SimpleNamespace(returncode=rc)

    monkeypatch.setattr(build_all.subprocess, "run", fake_run)
    return calls


def test_full_pipeline_runs_all_steps_in_order(monkeypatch):
    calls = _stub_runs(monkeypatch)
    ok = build_all.build_all(python="py", mkdocs="mkdocs", rebuild=True)
    assert ok is True
    ran = [Path(str(c[-1])).name for c in calls]
    # every tool + mkdocs.yml + the index, in the declared order
    assert ran == [
        "fetch_datasets.py", "build_flora.py", "cache_wikimedia.py", "cache_geohints.py",
        "build_flags.py", "build_subnational_flags.py", "build_commons_gallery.py",
        "build_refdata.py", "mkdocs.yml", "build_search_index.py",
    ]


def test_optional_step_failure_does_not_abort(monkeypatch):
    # a network step (fetch_datasets) failing must NOT stop the build
    calls = _stub_runs(monkeypatch, fail={"fetch_datasets.py"})
    ok = build_all.build_all(python="py", mkdocs="mkdocs", rebuild=True)
    assert ok is True
    ran = [Path(str(c[-1])).name for c in calls]
    assert "mkdocs.yml" in ran and "build_search_index.py" in ran   # continued past the failure


def test_required_step_failure_aborts(monkeypatch):
    # the search index is required — its failure fails the whole build
    _stub_runs(monkeypatch, fail={"build_search_index.py"})
    ok = build_all.build_all(python="py", mkdocs="mkdocs", rebuild=True)
    assert ok is False


def test_already_built_takes_cheap_path(monkeypatch, tmp_path):
    # when the site exists and the index exists and rebuild is False, nothing runs
    monkeypatch.setattr(build_all, "ROOT", tmp_path)
    (tmp_path / "wiki" / "site").mkdir(parents=True)
    (tmp_path / "wiki" / "site" / "index.html").write_text("x")
    (tmp_path / "app" / "data").mkdir(parents=True)
    (tmp_path / "app" / "data" / "search-index.json").write_text("[]")
    calls = _stub_runs(monkeypatch)
    ok = build_all.build_all(python="py", rebuild=False)
    assert ok is True and calls == []          # fully skipped
