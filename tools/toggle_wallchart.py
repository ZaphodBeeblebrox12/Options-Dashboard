#!/usr/bin/env python3
"""Toggle the Wall Scanner chart (WallChart) in frontend/src/App.tsx — line-based.

  python tools/toggle_wallchart.py            # hide the chart (default)
  python tools/toggle_wallchart.py --restore  # show it again

Finds the import line and the <WallChart ... /> block (which may span
multiple lines, ending at the first line whose trimmed form ends with '/>')
and comments/uncomments them. Idempotent; restores byte-for-byte.
"""
import os
import sys

APP = os.path.join("frontend", "src", "App.tsx")
if not os.path.exists(APP) and os.path.exists(os.path.join("..", APP)):
    APP = os.path.join("..", APP)
if not os.path.exists(APP):
    sys.exit("[toggle] frontend/src/App.tsx not found — run from the repo root")

IMPORT_LINE = "import { WallChart } from './components/WallChart';"
MARKER = "{/* [WallChart disabled]"

lines = open(APP, encoding="utf-8").read().split("\n")
restore_mode = "--restore" in sys.argv


def find_block(ls):
    """Return (start_idx, end_idx) of the <WallChart ... /> block, or None."""
    start = next((i for i, l in enumerate(ls) if "<WallChart" in l), None)
    if start is None:
        return None
    end = next((i for i in range(start, len(ls))
                if ls[i].rstrip().endswith("/>") and i >= start), None)
    return (start, end) if end is not None else None


if restore_mode:
    if not any(MARKER in l for l in lines):
        print("[toggle] WallChart is already enabled — nothing to do.")
        sys.exit(0)
    # uncomment import
    lines = [IMPORT_LINE
             if l.startswith("// [WallChart disabled] " + IMPORT_LINE) else l
             for l in lines]
    # unwrap comment: drop marker line and '*/}' line, keep middle
    s = next(i for i, l in enumerate(lines) if MARKER in l)
    e = next(i for i in range(s, len(lines)) if lines[i].strip().endswith("*/}"))
    lines = lines[:s] + lines[s + 1:e] + lines[e + 1:]
    open(APP, "w", encoding="utf-8").write("\n".join(lines))
    print("[toggle] WallChart restored. Next: cd frontend && npm run build")
else:
    if any(MARKER in l for l in lines):
        print("[toggle] WallChart already disabled — nothing to do.")
        sys.exit(0)
    if sum(1 for l in lines if l.strip() == IMPORT_LINE) != 1:
        sys.exit("[toggle] import anchor not found exactly once — edit App.tsx manually.")
    blk = find_block(lines)
    if not blk:
        sys.exit("[toggle] <WallChart ... /> block not found — already removed?")
    s, e = blk
    indent = lines[s][:len(lines[s]) - len(lines[s].lstrip())]
    block = lines[s:e + 1]
    lines = [("// [WallChart disabled] " + IMPORT_LINE
              + "   (re-enable: python tools/toggle_wallchart.py --restore)"
              if l.strip() == IMPORT_LINE else l)
             for l in lines]
    s, e = find_block(lines)   # recompute after import line change (indices may shift by 0 — same count)
    comment = ([indent + MARKER + " 2026-10-02 — re-enable with: "
                "python tools/toggle_wallchart.py --restore"] + block
               + [indent + "*/}"])
    lines = lines[:s] + comment + lines[e + 1:]
    open(APP, "w", encoding="utf-8").write("\n".join(lines))
    print(f"[toggle] WallChart hidden ({len(block)} line(s) commented). "
          "Next: cd frontend && npm run build")
