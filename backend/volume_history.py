"""Historical highest-volume CE/PE leaders derived from saved option snapshots.

The UI highlights the highest-volume contract within ±5% of spot. This module
uses the spot recorded on each saved snapshot so replayed leader movements
follow the same rule as the live table.
"""


_VOLUME_LEADER_SQL = """
WITH volume_candidates AS (
    SELECT
        s.id AS snapshot_id,
        s.timestamp AS timestamp,
        o.option_type AS side,
        o.strike AS strike,
        COALESCE(o.volume, 0) AS volume,
        CASE
            WHEN s.spot IS NOT NULL
             AND o.strike >= s.spot * 0.95
             AND o.strike <= s.spot * 1.05
            THEN 1
            ELSE 0
        END AS in_spot_window
    FROM snapshots AS s
    JOIN option_snapshots AS o
      ON o.snapshot_id = s.id
     AND o.index_name = s.index_name
    WHERE s.index_name = ?
      AND date(s.timestamp) = ?
      AND o.option_type IN ('CE', 'PE')
      AND COALESCE(o.volume, 0) > 0
),
scoped_volume AS (
    SELECT
        *,
        MAX(in_spot_window) OVER (
            PARTITION BY snapshot_id, side
        ) AS has_spot_window
    FROM volume_candidates
),
ranked_volume AS (
    SELECT
        timestamp,
        side,
        strike,
        volume,
        ROW_NUMBER() OVER (
            PARTITION BY snapshot_id, side
            ORDER BY
                CASE
                    WHEN has_spot_window = 1 THEN in_spot_window
                    ELSE 0
                END DESC,
                volume DESC,
                strike ASC
        ) AS volume_rank
    FROM scoped_volume
)
SELECT timestamp, side, strike, volume
FROM ranked_volume
WHERE volume_rank = 1
ORDER BY timestamp ASC, side ASC
"""


def load_volume_leader_rows(conn, index_name: str, date_str: str):
    """Return at most one highest-volume contract per side and saved snapshot."""
    return conn.execute(_VOLUME_LEADER_SQL, (index_name, date_str)).fetchall()


def _number(value):
    number = float(value)
    return int(number) if number.is_integer() else number


def build_volume_history(rows) -> dict:
    """Build volume-leader points and emit events only when the leader strike changes."""
    by_timestamp = {}
    for row in rows:
        timestamp = str(row["timestamp"])
        point = by_timestamp.setdefault(timestamp, {
            "timestamp": timestamp,
            "ce_volume_strike": None,
            "ce_volume": None,
            "pe_volume_strike": None,
            "pe_volume": None,
        })
        prefix = "ce" if row["side"] == "CE" else "pe"
        point[f"{prefix}_volume_strike"] = _number(row["strike"])
        point[f"{prefix}_volume"] = int(row["volume"] or 0)

    points = [by_timestamp[key] for key in sorted(by_timestamp)]
    events = []
    previous = {"CE": None, "PE": None}

    for point in points:
        for side, prefix in (("CE", "ce"), ("PE", "pe")):
            strike = point[f"{prefix}_volume_strike"]
            volume = point[f"{prefix}_volume"]
            if strike is None:
                continue
            prior = previous[side]
            if prior is not None and prior["strike"] != strike:
                events.append({
                    "side": side,
                    "timestamp": point["timestamp"],
                    "from_strike": prior["strike"],
                    "to_strike": strike,
                    "from_volume": prior["volume"],
                    "to_volume": volume,
                })
            previous[side] = {"strike": strike, "volume": volume}

    return {"volume_points": points, "volume_events": events}
