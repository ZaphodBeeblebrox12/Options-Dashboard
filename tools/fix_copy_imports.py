#!/usr/bin/env python3
"""Fix misplaced CopyCardButton imports (the multi-line-import patch bug).

The copy-button patch inserted `import { CopyCardButton } ...` after the
line *starting* an import — which is INSIDE the braces for multi-line
imports like:

    import {
    import { CopyCardButton } from './CopyCardButton';   <-- invalid here
      BarChart,
    } from 'recharts';

This script scans every .tsx in frontend/src/components, removes that line
wherever it sits, and re-inserts it after the LAST COMPLETE import statement
(brace-depth tracked, so multi-line imports close first). Idempotent: a
correctly-placed import is removed and re-inserted at the same spot, leaving
the file byte-identical.

  python tools/fix_copy_imports.py
"""
import os
import sys

BASE = os.path.join("frontend", "src", "components")
if not os.path.isdir(BASE) and os.path.isdir(os.path.join("..", BASE)):
    BASE = os.path.join("..", BASE)
if not os.path.isdir(BASE):
    sys.exit("[fix] frontend/src/components not found — run from the repo root")

TARGET = "import { CopyCardButton } from './CopyCardButton';"


def last_import_end(lines):
    """Index AFTER the last complete import statement (multi-line aware)."""
    insert_at, depth, in_import = 0, 0, False
    for i, l in enumerate(lines):
        if l.strip().startswith("import "):
            in_import = True
            depth = l.count("{") - l.count("}")
            if " from " in l and depth <= 0:
                insert_at = i + 1
                in_import = False
            continue
        if in_import:
            depth += l.count("{") - l.count("}")
            if " from " in l and depth <= 0:
                insert_at = i + 1
                in_import = False
    return insert_at


for fname in sorted(os.listdir(BASE)):
    if not fname.endswith(".tsx"):
        continue
    path = os.path.join(BASE, fname)
    text = open(path, encoding="utf-8").read()
    if TARGET not in text:
        continue
    lines = text.split("\n")
    kept = [l for l in lines if l.strip() != TARGET]
    removed = len(lines) - len(kept)
    if removed == 0:
        continue
    at = last_import_end(kept)
    kept.insert(at, TARGET)
    new = "\n".join(kept)
    if new != text:
        open(path, "w", encoding="utf-8").write(new)
        print(f"[fix] {fname}: import moved to after the last import block ✅")
    else:
        print(f"[fix] {fname}: already correctly placed — untouched")
print("[fix] Done. Next: cd frontend && npm run build")
