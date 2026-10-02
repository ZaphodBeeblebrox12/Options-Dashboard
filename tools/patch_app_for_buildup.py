#!/usr/bin/env python3
"""Patch frontend/src/App.tsx to mount the BuildupCard (2 anchored insertions).

Idempotent: running twice changes nothing the second time. Verifies each
anchor exists exactly once before touching anything.

Usage (from the repo root):
    python tools/patch_app_for_buildup.py
"""
import os
import sys

APP = os.path.join("frontend", "src", "App.tsx")
if not os.path.exists(APP):
    for cand in (os.path.join("..", "frontend", "src", "App.tsx"),):
        if os.path.exists(cand):
            APP = cand
            break
    else:
        sys.exit("[patch] frontend/src/App.tsx not found — run from the repo root")

src = open(APP, encoding="utf-8").read()
orig_len = len(src)

IMPORT_ANCHOR = "import { AnalyticsHeader } from './components/AnalyticsHeader';"
IMPORT_LINE = "\nimport { BuildupCard } from './components/BuildupCard';"

MOUNT_ANCHOR = "isLive={liveMode && connected && marketOpen} />"
MOUNT_BLOCK = ("\n        <BuildupCard indexName={selectedIndex} date={selectedDate} live={liveMode} />")

if "BuildupCard" in src:
    print("[patch] BuildupCard already wired — nothing to do.")
    sys.exit(0)

if src.count(IMPORT_ANCHOR) != 1:
    sys.exit(f"[patch] import anchor not found exactly once ({src.count(IMPORT_ANCHOR)}x) — "
             f"add manually after the AnalyticsHeader import:\n  {IMPORT_LINE.strip()}")
src = src.replace(IMPORT_ANCHOR, IMPORT_ANCHOR + IMPORT_LINE, 1)

if src.count(MOUNT_ANCHOR) != 1:
    sys.exit(f"[patch] mount anchor not found exactly once ({src.count(MOUNT_ANCHOR)}x) — "
             f"add manually right after <AnalyticsHeader ... />:\n  {MOUNT_BLOCK.strip()}")
src = src.replace(MOUNT_ANCHOR, MOUNT_ANCHOR + MOUNT_BLOCK, 1)

open(APP, "w", encoding="utf-8").write(src)
print(f"[patch] {APP}: import + mount added (+{len(src) - orig_len} chars).")
print("[patch] Next: cd frontend && npm run build   (then restart backend)")
