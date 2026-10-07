#!/usr/bin/env python3
"""Wall Zone Chart — spot (Angel One historical candles) vs PE/CE walls
(your DB 30s snapshots) with each wall's +/-half-interval zone shaded.

NIFTY  : strike interval 50  -> wall zone = +/-25 pts
SENSEX : strike interval 100 -> wall zone = +/-50 pts

The wall zone is centered ON the wall strike: PE wall at 75,000 shades
74,950-75,050. As the wall steps to a new strike intraday, its zone jumps
with it. Grid lines: one horizontal line at every strike needed to cover
the day's price action (day low -> day high) and nothing more.

Data source for spot: Angel One SmartAPI historical endpoint
(getCandleData, per official docs: one params dict, rows are LISTS
[ts, O, H, L, C, V]). If the API is unavailable/empty, falls back to the
DB snapshot spot series automatically.

Usage (from backend/, uses your .env credentials):
  python wall_chart.py --date 2026-09-22               # both indices
  python wall_chart.py --date 2026-09-22 --index NIFTY
  python wall_chart.py --all                           # every recorded day
  python wall_chart.py --all --index SENSEX --out ./charts
  python wall_chart.py --date 2026-09-22 --no-fetch    # spot from DB only
"""
import argparse
import os
import sqlite3
import sys
from datetime import datetime

# ── hardcoded strike intervals ───────────────────────────────
INTERVAL = {"NIFTY": 50, "SENSEX": 100}
SPOT_TOKEN = {"NIFTY": ("NSE", "26000"), "SENSEX": ("BSE", "999001")}


def find_db(explicit):
    if explicit:
        if not os.path.exists(explicit):
            sys.exit(f"[chart] DB not found: {explicit}")
        return explicit
    here = os.path.dirname(os.path.abspath(__file__))
    for c in (os.path.join(here, "nifty_snapshots.db"),
              os.path.join(os.getcwd(), "nifty_snapshots.db")):
        if os.path.exists(c):
            return c
    sys.exit("[chart] DB not found. Pass --db /path/to/nifty_snapshots.db")


def angel_login():
    try:
        from dotenv import load_dotenv
        import pyotp
        from SmartApi import SmartConnect
    except ImportError as e:
        sys.exit(f"[chart] missing package: {e}  (pip install smartapi-python pyotp python-dotenv)")
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(env_path):
        load_dotenv(env_path, override=True)
    api_key = os.getenv("API_KEY", "").strip()
    client = os.getenv("CLIENT_CODE", "").strip()
    pwd = os.getenv("PASSWORD", "").strip()
    totp = os.getenv("TOTP_SECRET", "").strip()
    if not all((api_key, client, pwd, totp)):
        sys.exit("[chart] Angel credentials missing in .env "
                 "(API_KEY / CLIENT_CODE / PASSWORD / TOTP_SECRET)")
    api = SmartConnect(api_key)
    data = api.generateSession(clientCode=client, password=pwd,
                               totp=pyotp.TOTP(totp).now())
    if not data.get("status"):
        sys.exit(f"[chart] Angel login failed: {data.get('message')}")
    return api


def _parse_candle_row(row):
    """Angel returns rows as LISTS [ts, O, H, L, C, V]; some builds use
    dicts. Return (datetime, close) or None."""
    try:
        if isinstance(row, dict):
            ts_raw, close = row.get("timestamp"), row.get("close")
        else:
            ts_raw, close = row[0], row[4]
        ts = datetime.fromisoformat(str(ts_raw).split("+")[0].strip())
        return ts, float(close)
    except Exception:
        return None


def fetch_spot_candles(api, index, day):
    """1-minute index candles -> [(ts, close)], via official getCandleData
    (dict params). Falls back to any other historical method the installed
    SDK build exposes."""
    exch, token = SPOT_TOKEN[index]
    fd, td = f"{day} 09:15", f"{day} 15:30"

    # ── primary: official SmartAPI getCandleData({params dict}) ──
    fn = getattr(api, "getCandleData", None)
    if callable(fn):
        try:
            res = fn({
                "exchange": exch,
                "symboltoken": token,
                "interval": "ONE_MINUTE",
                "fromdate": fd,
                "todate": td,
            })
        except Exception as e:
            print(f"[chart] {index} {day}: getCandleData call failed: {e}")
            res = None
        if isinstance(res, dict):
            if not res.get("status", False):
                msg = str(res.get("message", res.get("errorcode", "unknown")))
                print(f"[chart] {index} {day}: Angel rejected historical request: {msg}")
                if "AG8004" in msg or "AG8004" in str(res.get("errorcode", "")):
                    print("[chart] AG8004 = your SmartAPI app type lacks Historical API "
                          "permission. Create/enable an app with Historical access on the "
                          "Angel developer portal, OR rerun with --no-fetch to chart "
                          "spot from your DB snapshots instead.")
                return []
            data = res.get("data") or []
            out = [r for r in (_parse_candle_row(c) for c in data) if r]
            out.sort()
            if out:
                return out
            print(f"[chart] {index} {day}: getCandleData returned no rows")
            return []

    # ── fallback: whatever historical-ish method this SDK build has ──
    for name in ("getHistoricalData", "getHistoricalApi", "getHistoricalDataV2",
                 "historicalData", "getHistory"):
        fn = getattr(api, name, None)
        if not callable(fn):
            continue
        for attempt in (
            lambda: fn("ONE_MINUTE", fd, td, exch, token),
            lambda: fn(interval="ONE_MINUTE", fromdate=fd, todate=td, exchange=exch, token=token),
            lambda: fn("ONE_MINUTE", fd, td, exch, token, "INDEX", "0"),
        ):
            try:
                res = attempt()
            except TypeError:
                continue
            except Exception as e:
                print(f"[chart] {index} {day}: {name} failed: {e}")
                res = None
                break
            if isinstance(res, dict) and not res.get("status", True):
                print(f"[chart] {index} {day}: {name} rejected: "
                      f"{res.get('message', res.get('errorcode', 'unknown'))}")
                return []
            data = res.get("data", res) if isinstance(res, dict) else res
            if isinstance(data, dict) and "candles" in data:
                data = data["candles"]
            out = [r for r in (_parse_candle_row(c) for c in (data or [])) if r]
            out.sort()
            if out:
                return out
    print(f"[chart] {index} {day}: no usable Angel historical method found")
    return []


def load_walls_db(conn, index, day):
    """Per 30s snapshot: (ts, pe_wall, ce_wall). Walls = max-OI strikes."""
    rows = conn.execute(
        """SELECT s.timestamp, o.strike, o.option_type, o.oi
           FROM snapshots s JOIN option_snapshots o ON o.snapshot_id = s.id
           WHERE s.index_name = ? AND date(s.timestamp) = ?
           ORDER BY s.timestamp, o.strike""", (index, day)).fetchall()
    snaps = {}
    for ts, strike, ot, oi in rows:
        e = snaps.setdefault(ts, {"PE": {}, "CE": {}})
        e[ot][strike] = oi
    timeline = []
    for ts in sorted(snaps):
        pe, ce = snaps[ts]["PE"], snaps[ts]["CE"]
        if not pe or not ce:
            continue
        pe_wall = min(s for s, o in pe.items() if o == max(pe.values()))
        ce_wall = min(s for s, o in ce.items() if o == max(ce.values()))
        timeline.append((datetime.strptime(ts, "%Y-%m-%d %H:%M:%S"), pe_wall, ce_wall))
    return timeline


def spot_from_db(conn, index, day):
    """Fallback spot series from DB snapshots."""
    rows = conn.execute(
        "SELECT timestamp, spot FROM snapshots WHERE index_name = ? AND date(timestamp) = ? "
        "AND spot IS NOT NULL AND spot > 0 ORDER BY timestamp", (index, day)).fetchall()
    return [(datetime.strptime(r[0], "%Y-%m-%d %H:%M:%S"), float(r[1])) for r in rows]


def step_walls_to_candles(walls, candle_ts):
    """Forward-fill wall timeline onto candle timestamps (step function)."""
    out = []
    j = 0
    n = len(walls)
    for t in candle_ts:
        while j < n - 1 and walls[j + 1][0] <= t:
            j += 1
        if j < n:
            out.append((walls[j][1], walls[j][2]))
        else:
            out.append((None, None))
    return out


def make_chart(index, day, candles, walls_step, outdir):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates

    half = INTERVAL[index] / 2.0
    times = [c[0] for c in candles]
    spot = [c[1] for c in candles]
    pe_w = [w[0] for w in walls_step]
    ce_w = [w[1] for w in walls_step]

    valid = [w for w in pe_w + ce_w if w]
    lo = min(min(spot), min(valid))
    hi = max(max(spot), max(valid))
    grid_lo = int(lo // INTERVAL[index] * INTERVAL[index]) - INTERVAL[index]
    grid_hi = int(-(-hi // INTERVAL[index]) * INTERVAL[index]) + INTERVAL[index]

    fig, ax = plt.subplots(figsize=(16, 9))
    fig.subplots_adjust(left=0.06, right=0.94, top=0.92, bottom=0.08)

    # strike grid: only what covers the day's price action
    for s in range(grid_lo, grid_hi + 1, INTERVAL[index]):
        ax.axhline(s, color="#cccccc", lw=0.5, ls=":", zorder=1)

    nan = float("nan")
    # wall zones (shaded) + wall step lines
    ax.fill_between(times, [w - half if w else nan for w in pe_w],
                    [w + half if w else nan for w in pe_w],
                    color="tab:green", alpha=0.18, zorder=2,
                    label=f"PE wall zone (+/-{half:g})")
    ax.fill_between(times, [w - half if w else nan for w in ce_w],
                    [w + half if w else nan for w in ce_w],
                    color="tab:red", alpha=0.15, zorder=2,
                    label=f"CE wall zone (+/-{half:g})")
    ax.step(times, pe_w, where="post", color="tab:green", lw=1.6, zorder=4, label="PE wall")
    ax.step(times, ce_w, where="post", color="tab:red", lw=1.6, zorder=4, label="CE wall")
    ax.plot(times, spot, color="black", lw=1.8, zorder=5, label=f"{index} spot")

    # wall-change markers on the wall lines
    for series, col in ((pe_w, "tab:green"), (ce_w, "tab:red")):
        for i in range(1, len(series)):
            if series[i] and series[i - 1] and series[i] != series[i - 1]:
                ax.plot(times[i], series[i], "o", ms=5, color=col, zorder=6)

    # first break below PE wall annotation
    for i in range(len(spot)):
        if pe_w[i] and spot[i] < pe_w[i] - half:
            ax.annotate("below PE zone", (times[i], spot[i]),
                        textcoords="offset points", xytext=(6, -14),
                        fontsize=8, color="tab:green")
            break

    ax.set_title(f"{index} — {day}  |  walls from 30s OI snapshots, spot from Angel 1m candles",
                 fontsize=13, fontweight="bold")
    ax.set_ylabel("Price")
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%H:%M"))
    ax.set_xlim(times[0], times[-1])
    ax.set_ylim(grid_lo, grid_hi)
    ax.grid(axis="x", color="#eeeeee", lw=0.6)
    ax.legend(loc="upper left", fontsize=9, framealpha=0.9)

    os.makedirs(outdir, exist_ok=True)
    path = os.path.join(outdir, f"{index}_{day}.png")
    fig.savefig(path, dpi=130)
    plt.close(fig)
    print(f"[chart] wrote {path}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=None)
    ap.add_argument("--date", default=None, help="YYYY-MM-DD (comma-repeatable)")
    ap.add_argument("--all", action="store_true", help="every recorded day")
    ap.add_argument("--index", default=None, choices=["NIFTY", "SENSEX"])
    ap.add_argument("--out", default="charts")
    ap.add_argument("--no-fetch", action="store_true",
                    help="skip Angel; plot spot from DB snapshots too")
    args = ap.parse_args()

    db = find_db(args.db)
    conn = sqlite3.connect(db)
    conn.execute("PRAGMA busy_timeout=30000")
    indices = (args.index,) if args.index else ("NIFTY", "SENSEX")

    days_by_index = {}
    for idx in indices:
        if args.all:
            days = [r[0] for r in conn.execute(
                "SELECT DISTINCT date(timestamp) FROM snapshots WHERE index_name = ? ORDER BY 1",
                (idx,)).fetchall()]
        elif args.date:
            days = [d.strip() for d in args.date.split(",")]
        else:
            r = conn.execute(
                "SELECT MAX(date(timestamp)) FROM snapshots WHERE index_name = ?",
                (idx,)).fetchone()
            days = [r[0]] if r and r[0] else []
        days_by_index[idx] = days

    api = None if args.no_fetch else angel_login()

    for idx in indices:
        for day in days_by_index[idx]:
            walls = load_walls_db(conn, idx, day)
            if len(walls) < 5:
                print(f"[chart] {idx} {day}: not enough wall data, skipped")
                continue
            candles = fetch_spot_candles(api, idx, day) if api else []
            src = "Angel 1m"
            if not candles:
                candles = spot_from_db(conn, idx, day)
                src = "DB snapshots"
            if len(candles) < 5:
                print(f"[chart] {idx} {day}: no spot data ({src}), skipped")
                continue
            step = step_walls_to_candles(walls, [c[0] for c in candles])
            print(f"[chart] {idx} {day}: {len(candles)} spot bars ({src}), "
                  f"{len(walls)} wall snapshots")
            make_chart(idx, day, candles, step, args.out)
    conn.close()


if __name__ == "__main__":
    main()
