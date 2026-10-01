"""One-shot diagnostic for the 09:36 -> 09:44 freeze (2026-09-22).

Run from the backend folder:
    python diagnose_freeze.py

Gathers everything relevant in one pass:
  [1] System power/crash events in the gap window (sleep=42, wake=1,
      bugcheck=1001, kernel power 41/107/507, any Error)
  [2] Security lock/unlock events (4800/4801)
  [3] The ACTUAL NIFTY snapshot rows in nifty_snapshots.db across the
      gap (marks gaps >45s) -- proves whether the backend kept writing
  [4] Current power scheme and sleep capability
Then prints a plain-English verdict.
"""
import os
import sqlite3
import subprocess
from datetime import datetime

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BACKEND_DIR, "nifty_snapshots.db")

WINDOW_START = "2026-09-22 09:25:00"
WINDOW_END   = "2026-09-22 09:50:00"


def run_ps(command):
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-Command", command],
                           capture_output=True, text=True, timeout=180)
        return ((r.stdout or "") + (r.stderr or "")).strip() or "(no output)"
    except Exception as e:
        return f"(failed: {e})"


def section(title):
    print()
    print("-" * 60)
    print(title)
    print("-" * 60)


print("=" * 60)
print("  FREEZE DIAGNOSTIC -", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
print("=" * 60)

section("[1] POWER / CRASH EVENTS  09:25 - 09:50  (System log)")
# (.Split([char]10)[0] takes the first line of the message without
# needing any quotes inside the PowerShell command.)
ps1 = (
    "Get-WinEvent -FilterHashtable @{LogName='System';"
    f" StartTime='{WINDOW_START}'; EndTime='{WINDOW_END}'"
    "} -ErrorAction SilentlyContinue"
    " | Where-Object {$_.Id -in 1,41,42,107,1001,507 -or $_.LevelDisplayName -eq 'Error'}"
    " | ForEach-Object { '{0}  Id={1,-5} {2,-28} {3}' -f $_.TimeCreated,"
    " $_.Id, $_.ProviderName, ($_.Message).Split([char]10)[0] }"
)
print(run_ps(ps1))

section("[2] WORKSTATION LOCK / UNLOCK  09:25 - 09:50  (Security log)")
ps2 = (
    "Get-WinEvent -FilterHashtable @{LogName='Security';"
    f" StartTime='{WINDOW_START}'; EndTime='{WINDOW_END}'; Id=4800,4801"
    "} -ErrorAction SilentlyContinue"
    " | ForEach-Object { '{0}  Id={1}  {2}' -f $_.TimeCreated, $_.Id,"
    " ($_.Message).Split([char]10)[0] }"
)
print(run_ps(ps2))

section("[3] ACTUAL NIFTY SNAPSHOT ROWS IN DB  09:30 - 09:50")
if not os.path.exists(DB):
    print(f"(nifty_snapshots.db not found next to this script: {DB})")
else:
    conn = sqlite3.connect(DB)
    rows = conn.execute(
        "SELECT timestamp, spot FROM snapshots"
        " WHERE index_name = 'NIFTY'"
        "   AND timestamp BETWEEN '2026-09-22 09:30:00' AND '2026-09-22 09:50:00'"
        " ORDER BY timestamp"
    ).fetchall()
    conn.close()
    if not rows:
        print("(no NIFTY snapshot rows at all in that window)")
    else:
        prev = None
        for ts, spot in rows:
            marker = ""
            if prev:
                gap = (datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")
                       - datetime.strptime(prev, "%Y-%m-%d %H:%M:%S")).total_seconds()
                if gap > 45:
                    marker = f"   <-- GAP {gap:.0f}s"
            print(f"   {ts}   spot={spot}{marker}")
            prev = ts

section("[4] POWER CONFIG (sleep capability + active scheme)")
print(run_ps("powercfg /a"))
print(run_ps("powercfg /getactivescheme"))

section("VERDICT")
print()
print("How to read the result:")
print()
print("  * [1] shows 'Id=42  Kernel-Power' at ~09:36 AND 'Id=1  Power-Troubleshooter'")
print("    at ~09:44  -> THE MACHINE SLEPT. Not a code bug.")
print("    Fix (admin cmd):")
print("        powercfg /change standby-timeout-ac 0")
print("        powercfg /change hibernate-timeout-ac 0")
print("        powercfg /change monitor-timeout-ac 0")
print("    And log to a file:  python main.py > backend_log.txt 2>&1")
print()
print("  * [1] and [2] show no power/lock events, AND [3] shows a GAP of")
print("    ~7-8 minutes  -> the backend process truly froze. Deploy the")
print("    freeze-watchdog patch; next occurrence writes every thread's stack")
print("    to backend/freeze_dump.txt within 90s.")
print()
print("  * [3] shows rows straight through 09:36-09:44 with no GAP")
print("    -> the backend NEVER stopped; only console output stalled.")
print("    File logging (python main.py > backend_log.txt 2>&1) fixes it.")
print()
print("If unsure, paste the ENTIRE output of this script back to me.")
