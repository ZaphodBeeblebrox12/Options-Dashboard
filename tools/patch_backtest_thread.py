"""v3.16 patch: move the alerts-backtest full-day DB read off the event
loop (asyncio.to_thread), same pattern as the v3.11 /api/history fix.

SELF-DISCOVERING: finds any @app.get/post("...backtest...") route in
backend/main.py instead of assuming a fixed path (local copies drift).

The backtest handler loads ~150-300k rows synchronously inside an async
def, blocking the loop and freezing WS broadcasts for all clients.

Safe to re-run (idempotent). Refuses to write if the result would not
compile. Run from anywhere:
    python tools/patch_backtest_thread.py
"""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
main_path = ROOT / "backend" / "main.py"

if not main_path.exists():
    sys.exit(f"ERROR: {main_path} not found")

content = main_path.read_text(encoding="utf-8")

# ── Discover the backtest route (any method, any path containing 'backtest') ──
routes = list(re.finditer(r'@app\.(get|post)\(\s*"([^"]*backtest[^"]*)"', content))
if not routes:
    sys.exit(
        "ERROR: no @app.get/post(\"...backtest...\") decorator found in backend/main.py.\n"
        "The endpoint may live in another file or under a different name.\n"
        "Run this and paste me the output:\n"
        "    findstr /S /N /C:\"backtest\" backend\\*.py"
    )

if len(routes) > 1:
    found = ", ".join(f'{m.group(1).upper()} {m.group(2)}' for m in routes)
    print(f"NOTE: multiple backtest routes found ({found}) — patching the first.")

m = routes[0]
route_path = m.group(2)
print(f"Found backtest route: {m.group(1).upper()} {route_path}")

# Idempotency: is this specific route already patched?
func_start = m.end()
body_probe = content[func_start:func_start + 4000]
if "to_thread" in body_probe.split("def ")[0]:
    print("Already patched - nothing to do.")
    sys.exit(0)

# ── 1. Insert the synchronous loader helper just above the route's banner ──
banner_start = content.rfind("\n# ──", 0, m.start())
if banner_start == -1:
    banner_start = content.rfind("\n", 0, m.start())
insert_at = banner_start + 1

helper = (
    "def _load_backtest_day(index_name: str, date: str):\n"
    "    \"\"\"Synchronous full-day loader for the backtest endpoint.\n"
    "\n"
    "    Runs in the thread pool via asyncio.to_thread so the event loop\n"
    "    stays responsive (v3.16 — same fix as /api/history in v3.11).\"\"\"\n"
    "    with get_db() as conn:\n"
    "        rows = conn.execute(\n"
    '            "SELECT * FROM snapshots WHERE index_name = ? AND date(timestamp) = ? ORDER BY timestamp",\n'
    "            (index_name, date)).fetchall()\n"
    "        opt_rows = conn.execute(\n"
    '            "SELECT * FROM option_snapshots WHERE snapshot_id IN "\n'
    '            "(SELECT id FROM snapshots WHERE index_name = ? AND date(timestamp) = ?)",\n'
    "            (index_name, date)).fetchall()\n"
    "    return rows, opt_rows\n"
    "\n"
    "\n"
)

content = content[:insert_at] + helper + content[insert_at:]

# ── 2. Replace the sync with-block inside the endpoint with a thread handoff ──
routes = list(re.finditer(r'@app\.(get|post)\(\s*"([^"]*backtest[^"]*)"', content))
m = routes[0]
wb = content.find("    with get_db() as conn:", m.end())
if wb == -1:
    sys.exit(
        "ERROR: found the route but no sync 'with get_db()' block after it.\n"
        "The handler may load data differently (helper function? another module?).\n"
        "Paste me the route's code and I will adapt the patch."
    )

lines = content[wb:].split("\n")
end_idx = None
for i, line in enumerate(lines[1:], start=1):
    if line.strip() == "":
        continue
    if line.startswith("    ") and not line.startswith("     "):
        end_idx = i
        break
if end_idx is None:
    sys.exit("ERROR: could not find the end of the get_db block.")

new_block = (
    "    # v3.16: full-day read (150-300k rows) runs in the thread pool.\n"
    "    # Doing this synchronously blocked the event loop and froze WS\n"
    "    # broadcasts for every client while a backtest ran.\n"
    "    rows, opt_rows = await asyncio.to_thread(_load_backtest_day, index_name, date)\n"
)

suffix = "\n".join(lines[end_idx:])
updated = content[:wb] + new_block + "\n" + suffix

# ── 3. Safety: refuse to write if the result doesn't compile ──
try:
    compile(updated, str(main_path), "exec")
except SyntaxError as e:
    sys.exit(f"ERROR: patched file would not compile ({e}). Nothing was written.")

backup = main_path.with_suffix(".py.bak-backtest")
backup.write_text(main_path.read_text(encoding="utf-8"), encoding="utf-8")
main_path.write_text(updated, encoding="utf-8")

print("SUCCESS: backend/main.py patched (backtest DB read moved to thread pool).")
print(f"Backup saved to {backup.name}")
print("Now RESTART the backend (Ctrl+C, then python main.py).")
