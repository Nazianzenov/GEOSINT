# PyInstaller spec for the GeOSINT Workbench — a single self-contained executable.
#
# Build on the TARGET OS (PyInstaller does not cross-compile):
#   .venv/bin/pip install pyinstaller          # or .venv\Scripts\pip on Windows
#   .venv/bin/pyinstaller geosint.spec
# Output: dist/geosint  (dist/geosint.exe on Windows)
#
# Read-only assets (app/, wiki/site/, data/) are bundled and resolved from
# sys._MEIPASS at runtime; the writable cache/ is created next to the executable
# (see DATA_ROOT in server.py).

from PyInstaller.building.build_main import Analysis, PYZ, EXE
from pathlib import Path

root = Path(SPECPATH)

datas = [
    (str(root / "app"), "app"),
    (str(root / "wiki" / "site"), "wiki/site"),
    (str(root / "data"), "data"),
]

a = Analysis(
    [str(root / "server.py")],
    pathex=[str(root)],
    binaries=[],
    datas=datas,
    hiddenimports=[],
    hookspath=[],
    runtime_hooks=[],
    excludes=["mkdocs", "mkdocs_material"],   # build-time only; not needed at runtime
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz, a.scripts, a.binaries, a.datas, [],
    name="geosint",
    console=True,            # it prints the URL + tool status; keep the console
    onefile=True,
    upx=False,               # reproducibility: don't depend on a UPX install
    strip=False,
)
