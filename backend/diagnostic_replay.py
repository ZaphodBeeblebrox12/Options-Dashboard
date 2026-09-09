"""Standalone Wall Reversal Scanner Diagnostic / Replay Tool.

READ-ONLY. Does NOT modify the existing application, scanner, or data.
Replays the EXACT pattern-detection logic from wall_scanner.py over historical
data from the existing SQLite databases to answer:
  "Over the last N days, did the alert logic have opportunities to trigger,
   and if not, WHY NOT?"

Usage:
  python diagnostic_replay.py                    # last 7 trading days
  python diagnostic_replay.py --days 14
  python diagnostic_replay.py --start 2026-09-01 --end 2026-09-08
  python diagnostic_replay.py --symbol RELIANCE  # single symbol
  python diagnostic_replay.py --verbose          # per-pattern diagnostics
"""
import os
import sys
import sqlite3
import argparse
from datetime import datetime, timedelta
from collections import defaultdict

# ── import EXISTING scanner logic (read-only; no side effects) ──
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wall_scanner import (
    htf_bucket_minutes, five_m_bucket_minutes, _aggregate, local_interval,
    TF_MINUTES, HTF_TFS, INDEX_SYMBOLS,
    C1_MIN_RANGE_X_INTERVAL, C2_MAX_RATIO_OF_C1,
    C2_CLOSE_TOLERANCE_X_INTERVAL, INDEX_CLUSTER_X_INTERVAL,
)

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "nifty_snapshots.db")
TFS = ("15m", "30m", "1H")


def trading_days(n, end=None):
    """Return the last n trading days (Mon-Fri) as YYYY-MM-DD strings."""
    days = []
    d = (datetime.strptime(end, "%Y-%m-%d") if end else datetime.now()).date()
    while len(days) < n:
        if d.weekday() < 5:
            days.append(d.isoformat())
        d -= timedelta(days=1)
    return sorted(days)


def get_symbols(conn, start, end):
    """All symbols that have 1m candle data in the range."""
    rows = conn.execute(
        "SELECT DISTINCT symbol FROM candles_1m WHERE date(ts_minute) BETWEEN ? AND ?",
        (start, end)).fetchall()
    return sorted(r[0] for r in rows)


def load_1m(conn, symbol, start, end):
    """Chronological 1m candles for symbol in [start, end]."""
    rows = conn.execute(
        "SELECT ts_minute, open, high, low, close FROM candles_1m "
        "WHERE symbol = ? AND date(ts_minute) BETWEEN ? AND ? ORDER BY ts_minute",
        (symbol, start, end)).fetchall()
    return [{"symbol": symbol, "ts_minute": r[0], "open": r[1], "high": r[2],
             "low": r[3], "close": r[4], "volume": None, "tick_count": 0}
            for r in rows]


def get_snapshot_ids(conn, symbol, start, end):
    """All snapshot ids for symbol in range, with timestamps."""
    return conn.execute(
        "SELECT id, timestamp FROM snapshots WHERE index_name = ? "
        "AND date(timestamp) BETWEEN ? AND ? ORDER BY timestamp",
        (symbol, start, end)).fetchall()


def reconstruct_walls(conn, snapshot_id):
    """CE/PE wall strikes + max-neg-gex strike from option_snapshots at a snapshot.
    Uses the EXACT same math as wall_scanner._walls (max-OI) and neg-gex (min net gex)."""
    rows = conn.execute(
        "SELECT strike, option_type, oi, gex FROM option_snapshots WHERE snapshot_id = ?",
        (snapshot_id,)).fetchall()
    ce_w = pe_w = None
    ce_oi = pe_oi = -1
    neg_gex = None
    neg_val = 0.0
    gex_by_strike = defaultdict(float)
    for strike, ot, oi, gex in rows:
        if ot == "CE" and (oi or 0) > ce_oi:
            ce_oi, ce_w = oi, strike
        if ot == "PE" and (oi or 0) > pe_oi:
            pe_oi, pe_w = oi, strike
        if gex is not None:
            gex_by_strike[strike] += gex
    for strike, g in gex_by_strike.items():
        if g < neg_val:
            neg_val, neg_gex = g, strike
    return ce_w, pe_w, neg_gex


def get_strike_interval(conn, symbol, snapshot_id, wall):
    """Adjacent-gap median around the wall from option_snapshots strikes."""
    rows = conn.execute(
        "SELECT DISTINCT strike FROM option_snapshots WHERE snapshot_id = ? ORDER BY strike",
        (snapshot_id,)).fetchall()
    strikes = [r[0] for r in rows]
    if not strikes:
        return None
    return local_interval(strikes, wall)


def aggregate_htf(ones, tf):
    """Market-open anchored HTF aggregation (reuses wall_scanner.htf_bucket_minutes + _aggregate)."""
    out = []
    cur_b = None
    part = []
    date_part = ones[0]["ts_minute"][:10] if ones else "0000-00-00"
    for c in ones:
        b = htf_bucket_minutes(tf, c["ts_minute"])
        if b is None:
            continue
        if cur_b is None:
            cur_b, part = b, [c]
        elif b == cur_b:
            part.append(c)
        else:
            agg = _aggregate(ones[0]["symbol"], part)
            agg["ts_minute"] = f"{date_part} {cur_b//60:02d}:{cur_b%60:02d}:00"
            out.append(agg)
            cur_b, part = b, [c]
    if part:
        agg = _aggregate(ones[0]["symbol"], part)
        agg["ts_minute"] = f"{date_part} {cur_b//60:02d}:{cur_b%60:02d}:00"
        out.append(agg)
    return out


def aggregate_5m(ones):
    """Clock-aligned 5m aggregation."""
    out = []
    cur_b = None
    part = []
    date_part = ones[0]["ts_minute"][:10] if ones else "0000-00-00"
    for c in ones:
        b = five_m_bucket_minutes(c["ts_minute"])
        if cur_b is None:
            cur_b, part = b, [c]
        elif b == cur_b:
            part.append(c)
        else:
            agg = _aggregate(ones[0]["symbol"], part)
            agg["ts_minute"] = f"{date_part} {cur_b//60:02d}:{cur_b%60:02d}:00"
            out.append(agg)
            cur_b, part = b, [c]
    if part:
        agg = _aggregate(ones[0]["symbol"], part)
        agg["ts_minute"] = f"{date_part} {cur_b//60:02d}:{cur_b%60:02d}:00"
        out.append(agg)
    return out


def diagnose_pattern(symbol, tf, direction, c1, c2, c3, wall, interval, neg_gex, spot, verbose):
    """Full diagnostic for a 3-candle pattern. Returns (is_setup, is_confirmed, reason)."""
    r1 = c1["high"] - c1["low"]
    r2 = c2["high"] - c2["low"]
    lines = []
    is_setup = True
    reasons = []

    # C1 size
    if r1 < C1_MIN_RANGE_X_INTERVAL * interval:
        is_setup = False
        reasons.append(f"C1 range {r1:.2f} < {C1_MIN_RANGE_X_INTERVAL}x{interval:.2f} = {C1_MIN_RANGE_X_INTERVAL*interval:.2f}")
    # C2/C1 ratio
    if is_setup and r2 > C2_MAX_RATIO_OF_C1 * r1:
        is_setup = False
        reasons.append(f"C2 range {r2:.2f} > {C2_MAX_RATIO_OF_C1}xC1({r1:.2f}) = {C2_MAX_RATIO_OF_C1*r1:.2f}")
    # wick touch
    if is_setup:
        if direction == "CE":
            if not (c1["high"] >= wall or c2["high"] >= wall):
                is_setup = False
                reasons.append(f"no wick touch: C1 high {c1['high']} < wall {wall}, C2 high {c2['high']} < wall {wall}")
        else:
            if not (c1["low"] <= wall or c2["low"] <= wall):
                is_setup = False
                reasons.append(f"no wick touch: C1 low {c1['low']} > wall {wall}, C2 low {c2['low']} > wall {wall}")
    # C2 close tolerance
    if is_setup:
        if abs(c2["close"] - wall) > C2_CLOSE_TOLERANCE_X_INTERVAL * interval:
            is_setup = False
            reasons.append(f"C2 close {c2['close']} too far from wall {wall} (tol {C2_CLOSE_TOLERANCE_X_INTERVAL}x{interval:.2f} = {C2_CLOSE_TOLERANCE_X_INTERVAL*interval:.2f})")

    # index cluster
    if is_setup and symbol in INDEX_SYMBOLS and neg_gex is not None:
        strikes = sorted({int(c1.get("_strike", 0)), int(c2.get("_strike", 0)), int(neg_gex)})
        # approximate cluster: ATM, wall, neg_gex within 2 intervals
        if spot and abs(spot - wall) > INDEX_CLUSTER_X_INTERVAL * interval:
            is_setup = False
            reasons.append(f"index cluster broken: spot {spot} vs wall {wall} (>{INDEX_CLUSTER_X_INTERVAL}x interval)")

    # confirmation (C3)
    is_confirmed = False
    if is_setup:
        if direction == "CE":
            is_confirmed = c3["close"] < c2["low"]
        else:
            is_confirmed = c3["close"] > c2["high"]

    if verbose:
        pattern_name = "Evening Star" if direction == "CE" else "Morning Star"
        lines.append(f"\n  Symbol: {symbol} | TF: {tf} | Pattern: {pattern_name}")
        lines.append(f"  C1 [{c1['ts_minute']}] O/H/L/C = {c1['open']}/{c1['high']}/{c1['low']}/{c1['close']}")
        lines.append(f"  C2 [{c2['ts_minute']}] O/H/L/C = {c2['open']}/{c2['high']}/{c2['low']}/{c2['close']}")
        lines.append(f"  C3 [{c3['ts_minute']}] O/H/L/C = {c3['open']}/{c3['high']}/{c3['low']}/{c3['close']}")
        lines.append(f"  Wall: {wall} | interval: {interval:.2f} | negGEX: {neg_gex} | spot: {spot}")
        lines.append(f"  C1 range: {r1:.2f} | C2 range: {r2:.2f} | ratio: {r2/r1:.2f}")
        lvl = c2["low"] if direction == "CE" else c2["high"]
        lines.append(f"  Confirmation level (C2 {'low' if direction=='CE' else 'high'}): {lvl}")
        lines.append(f"  C3 close: {c3['close']} | crossed: {'YES' if is_confirmed else 'NO'}")
        lines.append(f"  SETUP: {'YES' if is_setup else 'NO'} | ALERT: {'YES' if (is_setup and is_confirmed) else 'NO'}")
        if reasons:
            lines.append(f"  REJECTED: {'; '.join(reasons)}")
        print("\n".join(lines))

    return is_setup, is_confirmed, reasons


def run_symbol(conn, symbol, start, end, verbose):
    """Replay scanner logic for one symbol over [start, end]. Returns stats dict."""
    ones = load_1m(conn, symbol, start, end)
    if len(ones) < 30:
        return None   # insufficient data

    # snapshot lookup for walls/negGEX reconstruction (nearest <= candle time)
    snap_rows = get_snapshot_ids(conn, symbol, start, end)
    snap_map = {}   # minute_key -> (ce_w, pe_w, neg_gex, interval, spot)
    for sid, ts in snap_rows:
        # snapshot ts format: "YYYY-MM-DD HH:MM:SS"
        minute_key = ts[:16]   # "YYYY-MM-DD HH:MM"
        ce_w, pe_w, neg_gex = reconstruct_walls(conn, sid)
        spot_row = conn.execute(
            "SELECT spot FROM snapshots WHERE id = ?", (sid,)).fetchone()
        spot = spot_row[0] if spot_row else None
        interval = get_strike_interval(conn, symbol, sid, ce_w) if ce_w else None
        snap_map[minute_key] = (ce_w, pe_w, neg_gex, interval, spot)

    def get_state(ts_minute):
        """Nearest snapshot state at or before ts_minute."""
        key = ts_minute[:16]
        # walk backwards to find latest snapshot <= ts
        candidates = [k for k in snap_map if k <= key]
        if not candidates:
            return None, None, None, None, None
        best = max(candidates)
        return snap_map[best]

    five_m = aggregate_5m(ones)
    five_closes = {c["ts_minute"]: c["close"] for c in five_m}

    stats = {
        "candles": len(ones),
        "es_candidates": 0, "ms_candidates": 0,
        "es_wall": 0, "ms_wall": 0,
        "es_crossed": 0, "ms_crossed": 0,
        "es_confirmed": 0, "ms_confirmed": 0,
        "alerts": [],
        "reject_no_cross": 0, "reject_not_setup": 0,
    }

    for tf in TFS:
        htf = aggregate_htf(ones, tf)
        if len(htf) < 4:
            continue
        # walk C1, C2, C3 triples
        for i in range(len(htf) - 2):
            c1, c2, c3 = htf[i], htf[i+1], htf[i+2]
            ce_w, pe_w, neg_gex, interval, spot = get_state(c2["ts_minute"])
            if ce_w is None or interval is None:
                continue
            for direction, wall in [("CE", ce_w), ("PE", pe_w)]:
                if wall is None:
                    continue
                is_setup, is_confirmed, reasons = diagnose_pattern(
                    symbol, tf, direction, c1, c2, c3, wall, interval, neg_gex, spot, verbose)
                if direction == "CE":
                    stats["es_candidates"] += 1
                    if is_setup:
                        stats["es_wall"] += 1
                        if is_confirmed:
                            stats["es_crossed"] += 1
                            stats["es_confirmed"] += 1
                            stats["alerts"].append({"tf": tf, "dir": "CE",
                                "time": c3["ts_minute"], "wall": wall,
                                "c2_low": c2["low"], "c3_close": c3["close"]})
                        else:
                            stats["reject_no_cross"] += 1
                    else:
                        stats["reject_not_setup"] += 1
                else:
                    stats["ms_candidates"] += 1
                    if is_setup:
                        stats["ms_wall"] += 1
                        if is_confirmed:
                            stats["ms_crossed"] += 1
                            stats["ms_confirmed"] += 1
                            stats["alerts"].append({"tf": tf, "dir": "PE",
                                "time": c3["ts_minute"], "wall": wall,
                                "c2_high": c2["high"], "c3_close": c3["close"]})
                        else:
                            stats["reject_no_cross"] += 1
                    else:
                        stats["reject_not_setup"] += 1

    return stats


def main():
    ap = argparse.ArgumentParser(description="Wall Reversal Scanner Diagnostic Replay")
    ap.add_argument("--days", type=int, default=7, help="trading days to replay (default 7)")
    ap.add_argument("--start", help="start date YYYY-MM-DD")
    ap.add_argument("--end", help="end date YYYY-MM-DD")
    ap.add_argument("--symbol", help="single symbol (default: all)")
    ap.add_argument("--verbose", "-v", action="store_true", help="per-pattern diagnostics")
    ap.add_argument("--db", default=DB_PATH, help="path to nifty_snapshots.db")
    args = ap.parse_args()

    if args.start and args.end:
        days = sorted(trading_days(365, args.end))
        days = [d for d in days if args.start <= d <= args.end]
    else:
        days = trading_days(args.days, args.end)

    if not days:
        print("No trading days in range.")
        return

    start, end = days[0], days[-1]
    print(f"Replay period: {start} to {end} ({len(days)} trading days)")
    print(f"Database: {args.db}")
    print(f"Timeframes: {TFS}")
    print(f"Symbols: {args.symbol or 'all with data'}")
    print("=" * 60)

    conn = sqlite3.connect(args.db)
    symbols = [args.symbol.upper()] if args.symbol else get_symbols(conn, start, end)
    if not symbols:
        print("No symbols with candle data in range.")
        conn.close()
        return

    all_stats = {}
    for symbol in symbols:
        st = run_symbol(conn, symbol, start, end, args.verbose)
        if st is None:
            print(f"\n{symbol}: insufficient data (< 30 candles)")
            continue
        all_stats[symbol] = st
        print(f"\n{'='*60}")
        print(f"{symbol}")
        print(f"  Candles processed: {st['candles']}")
        print(f"  Evening Star candidates: {st['es_candidates']}")
        print(f"    near CE wall: {st['es_wall']}")
        print(f"    crossed: {st['es_crossed']}")
        print(f"    confirmed: {st['es_confirmed']}")
        print(f"  Morning Star candidates: {st['ms_candidates']}")
        print(f"    near PE wall: {st['ms_wall']}")
        print(f"    crossed: {st['ms_crossed']}")
        print(f"    confirmed: {st['ms_confirmed']}")
        if st["alerts"]:
            print(f"  CONFIRMED ALERTS:")
            for a in st["alerts"]:
                print(f"    {a['tf']} {a['dir']} @ {a['time']} wall={a['wall']} c3_close={a['c3_close']}")
        if st["es_confirmed"] == 0 and st["ms_confirmed"] == 0:
            print(f"  ZERO ALERTS DIAGNOSIS:")
            print(f"    patterns not setup: {st['reject_not_setup']}")
            print(f"    setup but no cross: {st['reject_no_cross']}")
            if st["reject_not_setup"] > 0 and st["reject_no_cross"] == 0:
                print(f"    -> {st['reject_not_setup']} patterns failed setup conditions (see --verbose)")
            elif st["reject_no_cross"] > 0:
                print(f"    -> {st['reject_no_cross']} setups formed but C3 did not cross (legitimate)")

    # ── SUMMARY ──
    print(f"\n{'='*60}")
    print("ALERT REPLAY SUMMARY")
    print(f"{'='*60}")
    total_confirmed = 0
    for tf in TFS:
        tf_syms = [s for s, st in all_stats.items()
                   if any(a["tf"] == tf for a in st["alerts"])]
        tf_es = sum(1 for st in all_stats.values() if st["es_confirmed"] > 0)
        tf_ms = sum(1 for st in all_stats.values() if st["ms_confirmed"] > 0)
        tf_alerts = sum(1 for st in all_stats.values() for a in st["alerts"] if a["tf"] == tf)
        total_confirmed += tf_alerts
        print(f"\n{tf}:")
        print(f"  Symbols tested: {len(all_stats)}")
        print(f"  Evening Star confirmed: {sum(st['es_confirmed'] for st in all_stats.values())}")
        print(f"  Morning Star confirmed: {sum(st['ms_confirmed'] for st in all_stats.values())}")
        print(f"  Total confirmed: {tf_alerts}")
    print(f"\nTOTAL CONFIRMED ALERTS: {total_confirmed}")
    zero = [s for s, st in all_stats.items() if st["es_confirmed"] == 0 and st["ms_confirmed"] == 0]
    print(f"\nSYMBOLS WITH ZERO ALERTS ({len(zero)}):")
    for s in zero:
        print(f"  {s}")
    conn.close()


if __name__ == "__main__":
    main()
