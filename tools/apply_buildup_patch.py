"""One-time patch: replace the get_buildup endpoint in backend/main.py with the
replay-aware version (timestamp parameter) from backend/buildup_endpoint_patch.py.

Safe to re-run (idempotent). Run from anywhere:
    python tools/apply_buildup_patch.py
"""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
main_path = ROOT / "backend" / "main.py"
patch_path = ROOT / "backend" / "buildup_endpoint_patch.py"

if not main_path.exists():
    sys.exit(f"ERROR: {main_path} not found")
if not patch_path.exists():
    sys.exit(f"ERROR: {patch_path} not found. Make sure buildup_endpoint_patch.py is in backend/")

content = main_path.read_text(encoding="utf-8")
new_block = patch_path.read_text(encoding="utf-8").rstrip() + "\n"

START = "# \u2500\u2500 v3.15: futures-OI buildup classification"
END = '@app.get("/api/market-status")'

s = content.find(START)
e = content.find(END, s if s != -1 else 0)

if s == -1 or e == -1:
    sys.exit(
        "ERROR: could not locate the get_buildup section in main.py.\n"
        "Look for the line: @app.get(\"/api/buildup\")"
    )

# Avoid double-pasting: if already patched, the timestamp Query line is present
segment = content[s:e]
if "Specific snapshot timestamp for replay mode" in segment:
    print("Already patched - nothing to do.")
    sys.exit(0)

updated = content[:s] + new_block + "\n" + content[e:]
main_path.write_text(updated, encoding="utf-8")
print("SUCCESS: backend/main.py patched.")
print("Now RESTART the backend (Ctrl+C, then python main.py) to load the change.")
