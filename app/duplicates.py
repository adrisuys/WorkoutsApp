"""Suspected double-uploads — the same session sitting in Strava twice.

Apple Health, a watch app and Strava's own recorder can each push the same
workout. Strava keeps them as separate activities with separate ids, this app
upserts by id, so both land here and every total counts that session twice.

**Reported, never deleted.** Strava is the source of truth: a row dropped on
import would come straight back on the next `sync --full`, and the app would
disagree with Strava for as long as it existed. A false positive would be worse
still — silently losing a real session. So both rows are kept, the pair is
named, and the fix is the one that also fixes Strava's own totals: delete it
there, then `prune`.

Recomputed on every call rather than written to a column, so it can never be
left stale by a prune, a re-sync or a reclassify.
"""

from __future__ import annotations

from datetime import datetime

from . import db
from .config import GROUP_LABELS

# Both real cases started within *one second* of each other: a re-upload of the
# same session keeps its start time, whatever else it renames or rounds. Two
# genuinely separate sessions in the same sport beginning inside two minutes is
# not a thing that happens, so the start time carries most of the weight here.
START_WINDOW_SECONDS = 120

# A second, deliberately loose guard. The observed hike pair differed by 66 s of
# moving time (2.75%) because the two recorders trimmed pauses differently, so
# this cannot be tight. It is here to stop a five-minute warm-up logged at the
# same moment as a two-hour ride from being called the same session — not to be
# precise.
DURATION_TOLERANCE = 0.20
DURATION_FLOOR_SECONDS = 60

ACTIVITY_URL = "https://www.strava.com/activities/{id}"


def _epoch(value: str) -> float:
    """Strava's local timestamps, as seconds. They carry a Z that isn't a zone."""
    return datetime.fromisoformat((value or "").replace("Z", "")).timestamp()


def _same_session(a, b) -> bool:
    if a["sport_group"] != b["sport_group"]:
        return False
    try:
        gap = abs(_epoch(b["start_date_local"]) - _epoch(a["start_date_local"]))
    except ValueError:
        return False
    if gap > START_WINDOW_SECONDS:
        return False

    first, second = a["moving_time"] or 0, b["moving_time"] or 0
    allowed = max(DURATION_FLOOR_SECONDS, max(first, second) * DURATION_TOLERANCE)
    return abs(first - second) <= allowed


def _out(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "sport_type": row["sport_type"],
        "distance": round((row["distance"] or 0.0) / 1000.0, 2),
        "minutes": (row["moving_time"] or 0) // 60,
        "start": row["start_date_local"],
        "url": ACTIVITY_URL.format(id=row["id"]),
    }


def find() -> list[dict]:
    """Every group of rows that looks like one session stored more than once.

    Sorted by sport and start time, then walked once comparing neighbours — at
    this size that is cheaper and far easier to read than expressing the same
    window in SQL date arithmetic.
    """
    with db.cursor() as conn:
        rows = conn.execute(
            "SELECT id, name, sport_type, sport_group, start_date_local, "
            "       local_date, distance, moving_time "
            "FROM activities "
            "ORDER BY sport_group, start_date_local, id"
        ).fetchall()

    groups: list[list] = []
    run: list = []
    for row in rows:
        if run and _same_session(run[-1], row):
            run.append(row)
        else:
            if len(run) > 1:
                groups.append(run)
            run = [row]
    if len(run) > 1:
        groups.append(run)

    out = []
    for run in groups:
        # What deleting all but one would give back: the surplus, not the total.
        # Keeping the longest is the assumption the numbers are stated under —
        # it is not a recommendation about which row to delete.
        times = [r["moving_time"] or 0 for r in run]
        dists = [(r["distance"] or 0.0) / 1000.0 for r in run]
        out.append({
            "key": "-".join(str(r["id"]) for r in run),
            "date": run[0]["local_date"],
            "sport": run[0]["sport_group"],
            "sport_label": GROUP_LABELS.get(run[0]["sport_group"], run[0]["sport_group"]),
            "count": len(run),
            "activities": [_out(r) for r in run],
            "extra_distance": round(sum(dists) - max(dists), 2),
            "extra_hours": round((sum(times) - max(times)) / 3600.0, 2),
        })

    out.sort(key=lambda g: g["date"], reverse=True)
    return out
