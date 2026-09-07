"""EOD validation report: Angel One Greeks vs our local calculations.

Reads greek_samples from greeks_compare.db (written by greeks_validation.py),
normalizes Angel's units with CONVENTION DETECTION (never blind assumption),
applies the price-consistency filter to separate calculation differences from
price-snapshot/timing differences, and emits markdown + per-contract CSV.

Usage:
  python validation_report.py --date 2026-09-06 [--index NIFTY] [--out ./reports]
"""
import os
import sys
import json
import math
import sqlite3
import argparse
import statistics
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from calculations import black_scholes_price  # price-consistency reprice only

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "greeks_compare.db")

METRICS = ["iv", "delta", "gamma", "theta", "vega"]
BANDS = [(0.005, "near <0.5%"), (0.015, "mid 0.5-1.5%"), (float("inf"), "wing >1.5%")]
# materiality: (abs, rel) — material if BOTH exceeded; wings scale abs by bucket factor
MATERIAL = {"iv": (0.75, 0.05), "delta": (0.015, 0.05), "gamma": (0.0002, 0.10),
            "theta": (0.10, 0.15), "vega": (0.15, 0.10)}
BUCKET_SCALE = [1.0, 1.5, 3.0]


def bucket(money):
    for i, (lim, _) in enumerate(BANDS):
        if money < lim:
            return i
    return 2


def pct(a, b):
    return 100.0 * a / b if b else float("nan")


class Rows:
    def __init__(self, date, index=None, db=DB_PATH):
        conn = sqlite3.connect(db)
        conn.row_factory = sqlite3.Row
        q = "SELECT * FROM greek_samples WHERE date(ts) = ?"
        params = [date]
        if index:
            q += " AND index_name = ?"
            params.append(index)
        self.rows = [dict(r) for r in conn.execute(q, params).fetchall()]
        self.errors = [dict(r) for r in conn.execute(
            "SELECT * FROM api_errors WHERE date(ts) = ? ORDER BY ts", [date]).fetchall()]
        self.meta = {r["key"]: r["value"] for r in conn.execute("SELECT * FROM meta")}
        conn.close()
        for r in self.rows:
            r["flags"] = json.loads(r.get("flags") or "[]")
            r["hour"] = r["ts"][11:16] if r.get("ts") else "?"

    def usable(self, r):
        """Both sides present, no disqualifying flags."""
        bad = {"expiry_mismatch", "missing_local", "missing_angel", "malformed_angel", "stale_local"}
        return not (bad & set(r["flags"]))


def detect_conventions(rows):
    """Median Angel/local ratio over near-ATM matched rows, per metric.
    IV ~100 => percent; theta ~365 => per-year; vega ~100 => per-unit."""
    det = {}
    for m in METRICS:
        ratios = []
        for r in rows:
            a, l = r.get(f"angel_{m}"), r.get(f"local_{m}")
            if a is None or not l:
                continue
            money = abs((r["spot"] or 0) - r["strike"]) / (r["spot"] or 1)
            if money < 0.005 and abs(l) > 1e-9:
                ratios.append(a / l)
        med = statistics.median(ratios) if ratios else None
        det[m] = med
    norm = {}
    norm["iv"] = (lambda v: v / 100.0) if (det["iv"] and det["iv"] > 20) else (lambda v: v)
    norm["theta"] = (lambda v: v / 365.0) if (det["theta"] and det["theta"] > 100) else (lambda v: v)
    norm["vega"] = (lambda v: v / 100.0) if (det["vega"] and det["vega"] > 20) else (lambda v: v)
    norm["delta"] = lambda v: v
    norm["gamma"] = lambda v: v
    return det, norm


def price_consistent(r, norm_iv):
    """BS(our S, K, our T, our r, angel_iv) vs our LTP: proves Angel's internal
    price snapshot ~= ours, making the greek comparison a pure calc comparison."""
    if None in (r.get("spot"), r.get("local_ltp"), r.get("t_years")):
        return False
    try:
        theo = black_scholes_price(r["spot"], r["strike"], r["t_years"], r["risk_free_rate"],
                                   norm_iv(r["angel_iv"]), r["option_type"])
    except Exception:
        return False
    return abs(theo - r["local_ltp"]) <= max(0.25, 0.005 * r["local_ltp"])


def stats_for(pairs):
    """pairs: list of (angel, local). Returns full stat block or None."""
    if not pairs:
        return None
    diffs = [a - l for a, l in pairs]
    ads = [abs(d) for d in diffs]
    n = len(diffs)
    mean = statistics.fmean(diffs)
    sd = statistics.stdev(diffs) if n > 1 else 0.0
    sem = sd / math.sqrt(n) if n else 0.0
    return {"n": n, "mean_abs": statistics.fmean(ads), "med_abs": statistics.median(ads),
            "p90": quantile(ads, 0.9), "p99": quantile(ads, 0.99), "max": max(ads),
            "mean": mean, "sem": sem, "med": statistics.median(diffs),
            "biased": abs(mean) > 3 * sem}


def quantile(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, max(0, int(q * len(xs) + 0.9999) - 1))]


def material_frac(pairs, m, bidx):
    a_abs, a_rel = MATERIAL[m]
    a_abs *= BUCKET_SCALE[bidx]
    if not pairs:
        return float("nan")
    bad = 0
    for a, l in pairs:
        d = abs(a - l)
        if d > a_abs and d > a_rel * abs(l):
            bad += 1
    return bad / len(pairs)


def build_report(date, index, db, outdir):
    R = Rows(date, index, db)
    lines = [f"# Greek validation report — {date}" + (f" — {index}" if index else "")]
    rows = [r for r in R.rows if R.usable(r)]
    lines.append(f"\n## Coverage\n")
    lines.append(f"- raw rows: {len(R.rows)}, usable rows: {len(rows)}")
    for idx in sorted({r['index_name'] for r in R.rows}):
        sub = [r for r in R.rows if r["index_name"] == idx]
        sens = json.loads(R.meta["sensex_supported"]) if "sensex_supported" in R.meta else None
        avail = f"{len({r['sample_id'] for r in sub})} samples, {len(sub)} rows"
        if idx == "SENSEX" and sens:
            avail += f" — SENSEX supported: **{sens['supported']}** ({sens['note']})"
        lines.append(f"- **{idx}**: {avail}")
    lines.append(f"- API errors: {len(R.errors)}")
    for e in R.errors[:10]:
        lines.append(f"  - {e['ts'][11:19]} {e['index_name']} {e['code']}: {e['message']}")
    em = sum(1 for r in R.rows if "expiry_mismatch" in r["flags"])
    lines.append(f"- expiry mismatches (Angel weekly/monthly bug guard): {em}")
    for f in ["missing_local", "stale_local", "sanity_reject", "missing_angel", "malformed_angel"]:
        c = sum(1 for r in R.rows if f in r["flags"])
        if c:
            lines.append(f"- flagged `{f}`: {c}")

    if not rows:
        lines.append("\n**No usable rows — nothing to compare.**\n")
        return finish(lines, R, date, index, outdir)

    det, norm = detect_conventions(rows)
    lines.append(f"\n## Convention verification (median Angel/local ratio, near-ATM)\n")
    lines.append("| metric | median ratio | detected convention | normalization applied |")
    lines.append("|---|---|---|---|")
    notes = {"iv": "percent" if det["iv"] and det["iv"] > 20 else "decimal",
             "theta": "per-year" if det["theta"] and det["theta"] > 100 else "per-day",
             "vega": "per-unit" if det["vega"] and det["vega"] > 20 else "per-1%"}
    for m in METRICS:
        r_ = det[m]
        applied = {"iv": "/100" if notes["iv"] == "percent" else "none",
                   "theta": "/365" if notes["theta"] == "per-year" else "none",
                   "vega": "/100" if notes["vega"] == "per-unit" else "none"}.get(m, "none")
        lines.append(f"| {m} | {r_:.3f} | {notes.get(m, 'same units')} | {applied} |")

    matched = [r for r in rows if price_consistent(r, norm["iv"])]
    lines.append(f"\n## Price consistency\n")
    lines.append(f"- matched-price subset (pure calculation comparison): {len(matched)}/{len(rows)} "
                 f"({pct(len(matched), len(rows)):.0f}%)")
    lines.append(f"- full dataset (includes price-snapshot/timing differences): {len(rows)}")

    verdicts = {}
    any_bias = {m: False for m in METRICS}
    for label, subset in (("matched", matched), ("full", rows)):
        lines.append(f"\n## Deviations — {label} subset\n")
        lines.append("| metric | bucket | side | n | mean abs | med abs | p90 | p99 | max | signed mean ± SEM | signed med | % material |")
        lines.append("|---|---|---|---|---|---|---|---|---|---|---|---|")
        for m in METRICS:
            for bidx, (_lim, bname) in enumerate(BANDS):
                for side in ("CE", "PE"):
                    pairs = []
                    for r in subset:
                        a, l = r.get(f"angel_{m}"), r.get(f"local_{m}")
                        if a is None or l is None or r["option_type"] != side:
                            continue
                        money = abs((r["spot"] or 0) - r["strike"]) / (r["spot"] or 1)
                        if bucket(money) != bidx:
                            continue
                        pairs.append((norm[m](a), l))
                    st = stats_for(pairs)
                    if not st:
                        continue
                    if label == "matched" and st["biased"]:
                        any_bias[m] = True
                    mf = material_frac(pairs, m, bidx)
                    lines.append(f"| {m} | {bname} | {side} | {st['n']} | {st['mean_abs']:.4f} | "
                                 f"{st['med_abs']:.4f} | {st['p90']:.4f} | {st['p99']:.4f} | {st['max']:.4f} | "
                                 f"{st['mean']:+.4f} ± {st['sem']:.4f}{' *BIAS*' if st['biased'] else ''} | "
                                 f"{st['med']:+.4f} | {pct(mf, 1):.1f}% |")
            if label == "matched":
                verdicts[m] = "INVESTIGATE" if any_bias[m] else "PASS"

    lines.append(f"\n## Bias by moneyness (matched subset, signed mean)\n")
    lines.append("| metric | side | near | mid | wing |")
    lines.append("|---|---|---|---|---|")
    for m in METRICS:
        for side in ("CE", "PE"):
            cells = []
            for bidx in range(3):
                pairs = [(norm[m](r[f"angel_{m}"]), r[f"local_{m}"]) for r in matched
                         if r.get(f"angel_{m}") is not None and r.get(f"local_{m}") is not None
                         and r["option_type"] == side
                         and bucket(abs((r["spot"] or 0) - r["strike"]) / (r["spot"] or 1)) == bidx]
                st = stats_for(pairs)
                cells.append(f"{st['mean']:+.4f}" if st else "—")
            lines.append(f"| {m} | {side} | {cells[0]} | {cells[1]} | {cells[2]} |")

    lines.append(f"\n## Bias by time of day (matched subset, signed mean, all metrics)\n")
    slots = sorted({r["hour"][:4] for r in matched})
    lines.append("| slot | n | " + " | ".join(METRICS) + " |")
    lines.append("|---|---|" + "---|" * len(METRICS))
    for slot in slots:
        sub = [r for r in matched if r["hour"].startswith(slot[:3])]
        cells = []
        for m in METRICS:
            pairs = [(norm[m](r[f"angel_{m}"]), r[f"local_{m}"]) for r in sub
                     if r.get(f"angel_{m}") is not None and r.get(f"local_{m}") is not None]
            st = stats_for(pairs)
            cells.append(f"{st['mean']:+.4f}" if st else "—")
        lines.append(f"| {slot} | {len(sub)} | " + " | ".join(cells) + " |")

    lines.append(f"\n## Verdicts (matched-price subset)\n")
    for m, v in verdicts.items():
        lines.append(f"- **{m}**: {v}")
    return finish(lines, R, date, index, outdir, norm)


def finish(lines, R, date, index, outdir, norm=None):
    os.makedirs(outdir, exist_ok=True)
    name = f"validation_report_{date}{'_' + index if index else ''}"
    md = os.path.join(outdir, name + ".md")
    open(md, "w").write("\n".join(lines) + "\n")
    csv = os.path.join(outdir, name + ".csv")
    if R.rows:
        keys = list(R.rows[0].keys())
        with open(csv, "w") as f:
            f.write(",".join(keys) + "\n")
            for r in R.rows:
                f.write(",".join(str(r.get(k, "")).replace(",", ";") for k in keys) + "\n")
    print("\n".join(lines[-(len(R.rows) and 6 or 3):]))
    print(f"\nReport written: {md}")
    if R.rows:
        print(f"Per-contract CSV: {csv}")
    return md


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True, help="YYYY-MM-DD")
    ap.add_argument("--index", default=None)
    ap.add_argument("--db", default=DB_PATH)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "validation_reports"))
    a = ap.parse_args()
    build_report(a.date, a.index, a.db, a.out)
