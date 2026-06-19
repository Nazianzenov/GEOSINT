"""Cross-platform detection + launch tests (6.1 / 6.2).

The server is pure stdlib, so we import it directly and exercise the OS branches
by monkeypatching server.IS_WIN/IS_MAC/IS_LINUX and stubbing subprocess/shutil.
This verifies the Windows/macOS/Linux code paths on any host (incl. CI's matrix).
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402


@pytest.fixture
def os_mode(monkeypatch):
    """Return a setter that flips server's platform flags to a given OS."""
    def set_os(name):
        monkeypatch.setattr(server, "IS_WIN", name == "win")
        monkeypatch.setattr(server, "IS_MAC", name == "mac")
        monkeypatch.setattr(server, "IS_LINUX", name == "linux")
    return set_os


# ── _launch_app: the right spawn shape per OS ─────────────────────────────
def test_launch_windows_bat_uses_cmd(os_mode, monkeypatch):
    os_mode("win")
    calls = []
    monkeypatch.setattr(server.subprocess, "Popen", lambda cmd, **kw: calls.append((cmd, kw)) or "P")
    server._launch_app(Path(r"C:\QGIS\bin\qgis-ltr.bat"), [Path("layer.geojson")])
    cmd, kw = calls[0]
    assert cmd[:2] == ["cmd", "/c"]
    assert cmd[2].endswith("qgis-ltr.bat")
    assert cmd[-1].endswith("layer.geojson")


def test_launch_windows_exe_direct(os_mode, monkeypatch):
    os_mode("win")
    calls = []
    monkeypatch.setattr(server.subprocess, "Popen", lambda cmd, **kw: calls.append(cmd))
    server._launch_app(Path(r"C:\x\googleearth.exe"))
    assert calls[0][0].endswith("googleearth.exe")
    assert "cmd" not in calls[0]


def test_launch_mac_app_uses_open_a(os_mode, monkeypatch):
    os_mode("mac")
    calls = []
    monkeypatch.setattr(server.subprocess, "Popen", lambda cmd, **kw: calls.append(cmd))
    app = Path("/Applications/QGIS.app")
    server._launch_app(app, [Path("/tmp/x.geojson")])
    assert calls[0][0] == "open"
    assert calls[0][1] == "-a"
    assert calls[0][2] == str(app)            # str(Path) is OS-agnostic for the comparison
    assert "--args" in calls[0]


def test_launch_linux_direct(os_mode, monkeypatch):
    os_mode("linux")
    calls = []
    monkeypatch.setattr(server.subprocess, "Popen", lambda cmd, **kw: calls.append(cmd))
    qgis = Path("/usr/bin/qgis")
    server._launch_app(qgis)
    assert calls[0] == [str(qgis)]


def test_launch_no_shell_ever(os_mode, monkeypatch):
    # no launch path should ever pass shell=True
    seen = []
    monkeypatch.setattr(server.subprocess, "Popen", lambda cmd, **kw: seen.append(kw))
    for mode in ("win", "mac", "linux"):
        os_mode(mode)
        server._launch_app(Path("/x/app" + (".bat" if mode == "win" else "")))
    assert all("shell" not in kw or kw["shell"] is False for kw in seen)


# ── _open_document_with: open a KML in the detected app ───────────────────
def test_open_document_mac_app(os_mode, monkeypatch):
    os_mode("mac")
    calls = []
    monkeypatch.setattr(server.subprocess, "Popen", lambda cmd, **kw: calls.append(cmd))
    app, doc = Path("/Applications/Google Earth Pro.app"), Path("/tmp/f.kml")
    server._open_document_with(app, doc)
    assert calls[0] == ["open", "-a", str(app), str(doc)]


def test_open_document_linux_binary(os_mode, monkeypatch):
    os_mode("linux")
    calls = []
    monkeypatch.setattr(server.subprocess, "Popen", lambda cmd, **kw: calls.append(cmd))
    binp, doc = Path("/opt/google/earth/pro/googleearth"), Path("/tmp/f.kml")
    server._open_document_with(binp, doc)
    assert calls[0] == [str(binp), str(doc)]


# ── find_* OS branches ────────────────────────────────────────────────────
def test_find_exiftool_prefers_path(os_mode, monkeypatch):
    os_mode("linux")
    monkeypatch.setattr(server.shutil, "which", lambda n: "/usr/bin/exiftool" if n == "exiftool" else None)
    assert server.find_exiftool() == Path("/usr/bin/exiftool")


def test_find_qgis_windows_bat(os_mode, monkeypatch):
    os_mode("win")
    monkeypatch.setattr(server, "_first_existing", lambda paths: Path(list(paths)[0]))
    res = server.find_qgis()
    assert str(res).lower().endswith(".bat")


def test_find_qgis_mac_app(os_mode, monkeypatch):
    os_mode("mac")
    monkeypatch.setattr(server, "_first_existing", lambda paths: Path(list(paths)[0]))
    assert str(server.find_qgis()).endswith(".app")


def test_venv_python_dir(os_mode):
    os_mode("win")
    assert server._venv_python_dir() == "Scripts"
    os_mode("linux")
    assert server._venv_python_dir() == "bin"


# ── version surface ───────────────────────────────────────────────────────
def test_version_constant():
    assert server.VERSION
    assert server.UA.startswith(f"GeOSINT-Workbench/{server.VERSION}")


# ── atomic cache writes (threaded server: no half-written reads) ─────────────
def test_atomic_write_creates_dirs_and_replaces(tmp_path):
    target = tmp_path / "a" / "b" / "c.bin"     # nested dir doesn't exist yet
    server.atomic_write(target, b"hello")
    assert target.read_bytes() == b"hello"
    server.atomic_write(target, b"world")       # replace in place
    assert target.read_bytes() == b"world"


def test_atomic_write_leaves_no_temp_files(tmp_path):
    server.atomic_write(tmp_path / "x.json", b"{}")
    # only the final file remains — no .tmp-* leftovers from the temp/replace dance
    names = [p.name for p in tmp_path.iterdir()]
    assert names == ["x.json"]


def test_atomic_write_no_partial_file_on_failure(tmp_path, monkeypatch):
    # If the replace fails, the temp file is cleaned up and the target is not
    # left half-written (a reader keeps seeing the old file / nothing).
    target = tmp_path / "y.bin"
    monkeypatch.setattr(server.os, "replace", lambda *a: (_ for _ in ()).throw(OSError("boom")))
    with pytest.raises(OSError):
        server.atomic_write(target, b"data")
    assert not target.exists()
    assert [p.name for p in tmp_path.iterdir()] == []   # temp cleaned up


# ── route table (#33) — one source of truth for POST dispatch + 405 ─────────
def test_post_routes_single_source_of_truth():
    H = server.Handler
    # every JSON route maps to a real handler method
    for path, name in H.POST_JSON_ROUTES.items():
        assert callable(getattr(H, name, None)), f"{path} -> missing handler {name}"
    # POST_PATHS (used for 404-vs-405) is exactly raw + json routes, no drift
    assert H.POST_PATHS == H.POST_RAW_PATHS | set(H.POST_JSON_ROUTES)


# ── named request-body caps (#32) — single source of truth ──────────────────
def test_body_caps_are_named_constants():
    # The EXIF cap is enforced in do_POST and re-checked in each exif handler;
    # naming it once means those checks can't silently diverge.
    assert server.EXIF_MAX_BYTES == 200 * 1024 * 1024
    assert server.JSON_MAX_BYTES == 2 * 1024 * 1024
    assert server.EXIF_MAX_BYTES > server.JSON_MAX_BYTES
    assert server.EXIF_TOOL_TIMEOUT > 0


# ── upstream failure logging (#28) — OPSEC: host only, never coords ──────────
def test_host_of_strips_query_and_path():
    # pget/overpass URLs embed coordinates in the query — only the host is safe
    # to log. _host_of must never return the query/path.
    u = "https://archive-api.open-meteo.com/v1/archive?latitude=48.85&longitude=2.29"
    assert server._host_of(u) == "archive-api.open-meteo.com"
    assert "48.85" not in server._host_of(u)
    assert server._host_of("not a url") == "?"


def test_warn_logs_host_not_url(monkeypatch, capsys):
    h = server.Handler.__new__(server.Handler)
    h._warn("/api/pget", "archive-api.open-meteo.com", ValueError("boom 48.85,2.29"))
    err = capsys.readouterr().err
    assert "[geosint] WARN /api/pget archive-api.open-meteo.com ValueError" in err
    assert "boom" in err            # the exception message is logged
    # the host arg carries no coords; the caller is responsible for passing a host


def test_warn_truncates_long_message(capsys):
    h = server.Handler.__new__(server.Handler)
    h._warn("/api/overpass", "overpass-api.de", RuntimeError("x" * 1000))
    line = capsys.readouterr().err
    assert "x" * 200 in line and "x" * 300 not in line   # message capped at 200


# ── host_ok / DNS-rebinding guard (H1 fix) ────────────────────────────────
class _FakeHeaders(dict):
    def get(self, k, default=None):  # case-insensitive Host lookup like real headers
        for kk, vv in self.items():
            if kk.lower() == k.lower():
                return vv
        return default


def _host_ok(host_value):
    """Call Handler.host_ok with a fake Host header, without a real socket."""
    h = server.Handler.__new__(server.Handler)
    h.headers = _FakeHeaders({"Host": host_value})
    return server.Handler.host_ok(h)


def test_host_ok_accepts_loopback_any_port(monkeypatch):
    # The guard matches on hostname, not port — so loopback works on any port
    # (incl. Docker port mapping like -p 8664:8650), but an attacker domain is
    # rejected regardless.
    monkeypatch.setattr(server, "ALLOWED_HOSTS", {"localhost:8650"})
    monkeypatch.setattr(server, "ALLOWED_HOSTNAMES", {"127.0.0.1", "localhost", "[::1]", "::1"})
    assert _host_ok("localhost:8650")          # exact
    assert _host_ok("localhost:8664")          # different published port (Docker) — OK
    assert _host_ok("127.0.0.1:9999")          # any loopback name/port
    assert _host_ok("[::1]:8650")              # bracketed IPv6 loopback
    assert not _host_ok("evil.attacker.com")        # rebound attacker domain rejected
    assert not _host_ok("evil.attacker.com:8650")   # ...with a port too
    assert not _host_ok("192.168.1.50:8650")        # LAN IP not allowed by default


def test_host_ok_offloopback_adds_bind_and_allowhost(monkeypatch):
    # Off-loopback bind adds the bind host; --allow-host adds a specific name.
    monkeypatch.setattr(server, "ALLOWED_HOSTS", {"localhost:8650"})
    monkeypatch.setattr(server, "ALLOWED_HOSTNAMES",
                        {"127.0.0.1", "localhost", "[::1]", "::1", "0.0.0.0", "geosint.lan"})
    assert _host_ok("localhost:8650")          # loopback still works
    assert _host_ok("geosint.lan:8650")        # operator-trusted name (any port)
    assert _host_ok("geosint.lan")
    assert not _host_ok("evil.attacker.com")   # still rejects attacker domains
