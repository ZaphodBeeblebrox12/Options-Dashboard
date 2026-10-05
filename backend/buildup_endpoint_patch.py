# ── v3.15: futures-OI buildup classification (Long/Short Buildup cards) ──

def _classify_buildup(px_chg: float, oi_chg: float) -> str:
    if px_chg >= 0 and oi_chg >= 0:
        return "LONG BUILDUP"
    if px_chg >= 0:
        return "SHORT COVERING"
    if oi_chg >= 0:
        return "SHORT BUILDUP"
    return "LONG UNWINDING"


@app.get("/api/buildup")
async def get_buildup(
    index: str = Query(default=None, description="Instrument name (default: NIFTY + SENSEX)"),
    date: str = Query(default=None, description="Trading date (default: latest available)"),
    timestamp: str = Query(default=None, description="Specific snapshot timestamp for replay mode"),
):
    """Futures-OI buildup status: price change x FUTURES OI change since the
    day's first snapshot. OI source: futures_oi (mode-3 ticks, v3.15+); falls
    back to summed option OI for dates recorded before futures OI existed.

    REPLAY MODE: pass `timestamp` to evaluate buildup up to that exact
    snapshot instead of the day's last snapshot."""
    targets = [index.strip().upper()] if index else ["NIFTY", "SENSEX"]
    out = {}
    with get_db() as conn:
        for idx in targets:
            day = date
            if not day:
                r = conn.execute(
                    "SELECT date(MAX(timestamp)) AS d FROM snapshots WHERE index_name = ?",
                    (idx,)).fetchone()
                day = r["d"] if r else None
            if not day:
                continue
            first = conn.execute(
                "SELECT * FROM snapshots WHERE index_name = ? AND date(timestamp) = ? "
                "ORDER BY timestamp LIMIT 1", (idx, day)).fetchone()
            if not first:
                continue

            # ── REPLAY MODE: use the exact timestamp snapshot ──
            if timestamp:
                last = conn.execute(
                    "SELECT * FROM snapshots WHERE index_name = ? AND timestamp = ?",
                    (idx, timestamp)).fetchone()
                if not last:
                    out[idx] = {"date": day, "label": "NO DATA", "error": "timestamp not found"}
                    continue
                last_px, foi, last_ts = last["spot"], last["futures_oi"], last["timestamp"]
                r = conn.execute(
                    "SELECT COALESCE(SUM(oi),0) FROM option_snapshots WHERE snapshot_id = ?",
                    (last["id"],)).fetchone()
                oi_sum = r[0] or None
                is_live = False
            else:
                # latest reading: live in-memory snapshot when it belongs to this day
                live = snapshot_engine.get_latest_snapshot(idx)
                if live and str(live.get("timestamp", "")).startswith(day):
                    last_px = live.get("spot")
                    foi = live.get("futures_oi")
                    oi_sum = sum(o.get("oi", 0) for o in live.get("options", [])) or None
                    last_ts = live.get("timestamp")
                    is_live = True
                else:
                    last = conn.execute(
                        "SELECT * FROM snapshots WHERE index_name = ? AND date(timestamp) = ? "
                        "ORDER BY timestamp DESC LIMIT 1", (idx, day)).fetchone()
                    if not last:
                        continue
                    last_px, foi, last_ts = last["spot"], last["futures_oi"], last["timestamp"]
                    r = conn.execute(
                        "SELECT COALESCE(SUM(oi),0) FROM option_snapshots WHERE snapshot_id = ?",
                        (last["id"],)).fetchone()
                    oi_sum = r[0] or None
                    is_live = False

            f0 = first["futures_oi"]
            if f0 is not None and foi is not None:
                oi0, oi1, oi_src = f0, foi, "futures"
            else:
                r0 = conn.execute(
                    "SELECT COALESCE(SUM(oi),0) FROM option_snapshots WHERE snapshot_id = ?",
                    (first["id"],)).fetchone()
                oi0, oi1, oi_src = (r0[0] or None), oi_sum, "options"

            if not last_px or not first["spot"] or not oi0 or oi1 is None:
                out[idx] = {"date": day, "label": "NO DATA", "error": "insufficient data"}
                continue

            px_chg = (last_px - first["spot"]) / first["spot"] * 100
            oi_chg = (oi1 - oi0) / oi0 * 100
            out[idx] = {
                "date": day, "label": _classify_buildup(px_chg, oi_chg),
                "px": last_px, "px_chg": round(px_chg, 2),
                "futures_oi": foi, "oi_chg": round(oi_chg, 2), "oi_source": oi_src,
                "baseline_ts": first["timestamp"], "last_ts": last_ts, "live": is_live,
            }
    return out
