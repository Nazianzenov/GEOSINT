"""Unit tests for the extracted ExifTool domain logic (geosint/exif.py, #88).

The point of the extraction is that this logic is testable WITHOUT the HTTP
Handler. We stub subprocess so no real ExifTool runs, and we pin the security
invariant the contract exists to guarantee: a failure's client_msg is generic
(no path / no stderr), while the unsafe detail goes to log_detail only."""
import json
import subprocess
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from geosint import exif  # noqa: E402


def _temp_writer(tmp_path):
    # a write_temp(raw)->Path that mimics the Handler's, without touching headers
    def w(raw):
        p = tmp_path / "geosint_in.jpg"
        p.write_bytes(raw)
        return p
    return w


def _stub_run(monkeypatch, *, returncode, stdout=b"", stderr=b""):
    monkeypatch.setattr(
        exif.subprocess, "run",
        lambda *a, **k: types.SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr))


def test_run_exif_success_scrubs_sourcefile_and_system(monkeypatch, tmp_path):
    # ExifTool returns SourceFile + a System: group (both leak the temp path) plus
    # a real tag — the path-leaking keys must be dropped, the real tag kept.
    payload = json.dumps([{
        "SourceFile": "/tmp/geosint_in.jpg",
        "System:FileName": "geosint_in.jpg",
        "EXIF:Model": "Camera X",
    }]).encode()
    _stub_run(monkeypatch, returncode=0, stdout=payload)
    res = exif.run_exif(b"img", Path("/usr/bin/exiftool"), _temp_writer(tmp_path))
    assert res.ok
    tags = res.data["tags"]
    assert tags == {"EXIF:Model": "Camera X"}          # path-leaking keys dropped
    assert "SourceFile" not in tags
    assert not any(k.startswith("System:") for k in tags)


def test_run_exif_bad_exit_is_generic_to_client_path_only_in_log(monkeypatch, tmp_path):
    # A non-(0,1) exit with stderr that embeds the temp path: the CLIENT message
    # must be generic, and the path must appear ONLY in log_detail.
    _stub_run(monkeypatch, returncode=2,
              stderr=b"Error: Unknown file type - /tmp/geosint_in.jpg")
    res = exif.run_exif(b"bad", Path("/usr/bin/exiftool"), _temp_writer(tmp_path))
    assert not res.ok and res.status == 500
    assert res.client_msg == "exiftool could not process this file"
    assert "/tmp/geosint_in.jpg" not in res.client_msg     # path NOT leaked to client
    assert "/tmp/geosint_in.jpg" in res.log_detail         # path IS in the operator log


def test_run_exif_spawn_oserror_does_not_leak_tool_path(monkeypatch, tmp_path):
    # subprocess.run raising OSError (spawn failure) can embed the ExifTool path in
    # str(e) — it must go to log_detail, never the client message.
    def boom(*a, **k):
        raise OSError("[Errno 13] Permission denied: '/opt/secret/exiftool'")
    monkeypatch.setattr(exif.subprocess, "run", boom)
    res = exif.run_exif(b"x", Path("/opt/secret/exiftool"), _temp_writer(tmp_path))
    assert not res.ok and res.status == 500
    assert "/opt/secret/exiftool" not in (res.client_msg or "")
    assert "/opt/secret/exiftool" in res.log_detail


def test_run_exif_timeout_maps_to_504(monkeypatch, tmp_path):
    def timeout(*a, **k):
        raise subprocess.TimeoutExpired(cmd="exiftool", timeout=30)
    monkeypatch.setattr(exif.subprocess, "run", timeout)
    res = exif.run_exif(b"x", Path("/usr/bin/exiftool"), _temp_writer(tmp_path))
    assert not res.ok and res.status == 504 and res.client_msg == "exiftool timed out"


def test_run_exif_unlinks_temp(monkeypatch, tmp_path):
    # the input temp file is removed even on success (the finally: cleanup)
    _stub_run(monkeypatch, returncode=0, stdout=b"[{}]")
    w = _temp_writer(tmp_path)
    exif.run_exif(b"x", Path("/usr/bin/exiftool"), w)
    assert not (tmp_path / "geosint_in.jpg").exists()


def test_analyze_preview_no_preview_returns_has_preview_false(monkeypatch, tmp_path):
    # every preview tag extraction yields empty stdout -> structured "no preview"
    _stub_run(monkeypatch, returncode=0, stdout=b"")
    res = exif.analyze_preview(b"x", Path("/usr/bin/exiftool"),
                               _temp_writer(tmp_path), lambda b: tmp_path / "p.jpg",
                               ("PreviewImage",))
    assert res.ok and res.data["has_preview"] is False
