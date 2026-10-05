#!/usr/bin/env python3
"""Add copy-as-image buttons (CopyCardButton) to dashboard panels:

  frontend/src/components/AnalyticsHeader.tsx  — the 7 stat cards
  frontend/src/components/OptionChain.tsx      — option chain table
  frontend/src/components/GexChart.tsx         — GEX by strike bar chart
  frontend/src/components/NetGexChart.tsx      — net GEX intraday chart

  python tools/patch_copy_buttons.py            # add buttons
  python tools/patch_copy_buttons.py --restore  # remove them

Per file: anchored insertions (each anchor verified unique), import added
after the last import line, idempotent per file, --restore byte-exact.
A file whose anchors don't match (local drift) is SKIPPED with the manual
edit printed — other files still patch. BuildupCard already carries the
button (shipped in the ZIP).

Requires (one time):  cd frontend && npm install html-to-image
"""
import os
import sys

BASE = os.path.join("frontend", "src", "components")
if not os.path.isdir(BASE) and os.path.isdir(os.path.join("..", BASE)):
    BASE = os.path.join("..", BASE)
if not os.path.isdir(BASE):
    sys.exit("[patch] frontend/src/components not found — run from the repo root")

IMPORT_STMT = "import { CopyCardButton } from './CopyCardButton';"

# (filename, import?, [(old, new), ...])
PATCHES = [
    ("AnalyticsHeader.tsx", True, [(
        """      {subValue && <div className="text-[9px] sm:text-[10px] font-mono text-terminal-muted">{subValue}</div>}
    </div>
  </div>
);""",
        """      {subValue && <div className="text-[9px] sm:text-[10px] font-mono text-terminal-muted">{subValue}</div>}
    </div>
    <div className="ml-auto self-start opacity-40 hover:opacity-100 transition-opacity shrink-0">
      <CopyCardButton />
    </div>
  </div>
);""")]),

    ("OptionChain.tsx", True, [(
        """        </div>
      </div>

      {/* MOBILE LEGEND — visible only on small screens */}""",
        """          <div className="ml-1 shrink-0"><CopyCardButton /></div>
        </div>
      </div>

      {/* MOBILE LEGEND — visible only on small screens */}""")]),

    ("GexChart.tsx", True, [(
        """          <span className="text-terminal-muted/60 ml-2 hidden sm:inline">
            {chartData.length} of {data.length} strikes
          </span>
        </div>
      </div>""",
        """          <span className="text-terminal-muted/60 ml-2 hidden sm:inline">
            {chartData.length} of {data.length} strikes
          </span>
          <CopyCardButton />
        </div>
      </div>""")]),

    ("NetGexChart.tsx", True, [(
        '      <div className="terminal-header">Net GEX — Full Trading Day</div>',
        """      <div className="terminal-header flex items-center justify-between">
        <span>Net GEX — Full Trading Day</span>
        <CopyCardButton />
      </div>""")]),
]

restore_mode = "--restore" in sys.argv


def add_import(src):
    lines = src.split("\n")
    last = max(i for i, l in enumerate(lines) if l.startswith("import "))
    lines.insert(last + 1, IMPORT_STMT)
    return "\n".join(lines)


for fname, do_import, pairs in PATCHES:
    path = os.path.join(BASE, fname)
    if not os.path.exists(path):
        print(f"[patch] SKIP {fname}: file not found")
        continue
    src = open(path, encoding="utf-8").read()
    tag = "restored" if restore_mode else "patched"
    try:
        if not restore_mode:
            if "CopyCardButton" in src:
                print(f"[patch] {fname}: already patched — skip")
                continue
            for old, new in pairs:
                if src.count(old) != 1:
                    raise ValueError(f"anchor x{src.count(old)}: {old[:60]!r}")
            for old, new in pairs:
                src = src.replace(old, new, 1)
            if do_import:
                src = add_import(src)
        else:
            if "CopyCardButton" not in src:
                print(f"[patch] {fname}: nothing to restore — skip")
                continue
            for old, new in pairs:
                if src.count(new) != 1:
                    raise ValueError(f"marker x{src.count(new)}: {new[:60]!r}")
            for old, new in pairs:
                src = src.replace(new, old, 1)
            src = src.replace(IMPORT_STMT + "\n", "", 1)
        open(path, "w", encoding="utf-8").write(src)
        print(f"[patch] {fname}: {tag}ed ✅")
    except ValueError as e:
        print(f"[patch] SKIP {fname}: {e}")
        print(f"          → add/remove this line manually where the panel header is:")
        print(f"            {IMPORT_STMT}")
print("[patch] Done. Remember: cd frontend && npm install html-to-image && npm run build")
