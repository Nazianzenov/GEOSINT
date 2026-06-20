"""ExifTool orchestration — the domain logic behind /api/exif and
/api/exif-preview, extracted from the HTTP Handler (#88).

These functions run the local ExifTool on attacker-controlled image bytes and
return a DomainResult. They OWN the security decisions that used to live in the
handler:
  * the SourceFile / System: tag scrub (the temp path leaks otherwise),
  * the generic client error on a bad exit / spawn failure, with the raw stderr
    routed to log_detail ONLY (SEC-11 / AUD-03),
so the seam cannot accidentally send a temp path or raw stderr to the client.

The caller injects `write_temp(raw) -> Path` (the Handler's umask-0600 temp
writer) and, for previews, `chmod_600` + a NamedTemporaryFile factory, so this
module needs nothing from server.py's globals and is unit-testable by stubbing
`subprocess` here.
"""
import json
import subprocess
from pathlib import Path

from .result import DomainResult

EXIF_TOOL_TIMEOUT = 30          # seconds per ExifTool invocation (matches server.py)

# Generic, path-free client message reused by both failure branches.
_GENERIC_ERR = "exiftool could not process this file"


def run_exif(raw, exiftool, write_temp):
    """Full ExifTool JSON dump. Returns DomainResult.json({"ok", "exiftool",
    "tags"}) on success, or DomainResult.error(...) — the client never sees the
    temp path or raw stderr."""
    tmp = None
    try:
        tmp = write_temp(raw)
        proc = subprocess.run(
            [str(exiftool), "-json", "-a", "-G1", "-api", "largefilesupport=1", str(tmp)],
            capture_output=True, timeout=EXIF_TOOL_TIMEOUT, stdin=subprocess.DEVNULL,
        )
        if proc.returncode not in (0, 1):      # 1 = minor warnings
            err = proc.stderr.decode("utf-8", "replace")[:500]   # can embed the temp path
            return DomainResult.error(500, _GENERIC_ERR, log_where="exiftool",
                                      log_detail=f"exit {proc.returncode}: {err}")
        data = json.loads(proc.stdout.decode("utf-8", "replace"))
        tags = data[0] if data else {}
        tags.pop("SourceFile", None)
        # The System: group leaks the temp file's path/name — drop it entirely.
        tags = {k: v for k, v in tags.items() if not k.startswith("System:")}
        return DomainResult.json({"ok": True, "exiftool": str(exiftool), "tags": tags})
    except subprocess.TimeoutExpired as e:
        return DomainResult.error(504, "exiftool timed out", log_where="exiftool", log_detail=str(e))
    except (OSError, json.JSONDecodeError, ValueError) as e:
        # str(e) can embed the ExifTool path on a spawn OSError -> log only.
        return DomainResult.error(500, _GENERIC_ERR, log_where="exiftool", log_detail=str(e)[:500])
    finally:
        if tmp:
            try:
                tmp.unlink()
            except OSError:
                pass


def _exif_gps_time(exiftool, path):
    """(gps 'lat,lon' or None, DateTimeOriginal/CreateDate or None) for a path."""
    try:
        proc = subprocess.run(
            [str(exiftool), "-json", "-n", "-GPSLatitude", "-GPSLongitude",
             "-DateTimeOriginal", "-CreateDate", str(path)],
            capture_output=True, timeout=20, stdin=subprocess.DEVNULL,
        )
        d = (json.loads(proc.stdout.decode("utf-8", "replace")) or [{}])[0]
    except (OSError, json.JSONDecodeError, ValueError, subprocess.TimeoutExpired):
        return None, None
    lat, lon = d.get("GPSLatitude"), d.get("GPSLongitude")
    gps = f"{lat},{lon}" if (lat is not None and lon is not None) else None
    return gps, (d.get("DateTimeOriginal") or d.get("CreateDate"))


def analyze_preview(raw, exiftool, write_temp, write_private, preview_tags):
    """Extract the largest embedded preview/thumbnail and compare its own GPS/time
    against the main image (a splicing signal). Returns DomainResult whose `data`
    is the structured analysis the Handler turns into the X-* response headers +
    body — NOT an HTTP response itself.

    `write_private(body) -> Path` writes the extracted preview to an owner-only
    (0600) temp file (the Handler injects it). On 'no preview' returns a JSON
    DomainResult the Handler sends as a 200 directly.
    """
    tmp = prev_tmp = None
    try:
        tmp = write_temp(raw)
        chosen, body = None, b""
        for tag in preview_tags:
            try:
                p = subprocess.run([str(exiftool), "-b", "-" + tag, str(tmp)],
                                   capture_output=True, timeout=EXIF_TOOL_TIMEOUT, stdin=subprocess.DEVNULL)
            except subprocess.TimeoutExpired as e:
                return DomainResult.error(504, "exiftool timed out", log_where="exiftool", log_detail=str(e))
            if p.returncode in (0, 1) and p.stdout:
                chosen, body = tag, p.stdout
                break
        if not body:
            return DomainResult.json({"ok": True, "has_preview": False,
                                      "msg": "no embedded preview/thumbnail in this image"})

        main_gps, main_time = _exif_gps_time(exiftool, tmp)
        prev_tmp = write_private(body)
        prev_gps, prev_time = _exif_gps_time(exiftool, prev_tmp)
        ctype = "image/jpeg" if body[:2] == b"\xff\xd8" else "application/octet-stream"
        return DomainResult.json({
            "ok": True, "has_preview": True, "body": body, "ctype": ctype,
            "tag": chosen, "bytes": len(body),
            "main_gps": main_gps, "prev_gps": prev_gps,
            "main_time": main_time, "prev_time": prev_time,
            "gps_mismatch": bool(main_gps and prev_gps and main_gps != prev_gps),
            "time_mismatch": bool(main_time and prev_time and main_time != prev_time),
        })
    except (OSError, ValueError) as e:
        return DomainResult.error(500, "exiftool could not process this file",
                                  log_where="exiftool", log_detail=str(e)[:500])
    finally:
        for t in (tmp, prev_tmp):
            if t:
                try:
                    t.unlink()
                except OSError:
                    pass
