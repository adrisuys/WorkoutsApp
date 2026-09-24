"""Training goals, read from goals.json.

Deliberately *not* stored in SQLite, for the same reason `pb.csv` isn't: the
file is hand-maintained, so it is parsed on every request. Edit it, reload the
page, done. At this size (a handful of entries) parsing costs nothing.

    [
      { "sport": "swim", "period": "week", "metric": "distance", "target": 7 }
    ]

`sport` is one of the groups in `config.SPORT_GROUPS`, `period` is `week` or
`month`, `metric` is any of `stats.METRICS`, and `target` is the amount you
mean to do in one such period — kilometres for distance, hours for time,
metres for elevation, sessions for count.

A malformed entry is skipped and reported rather than breaking the page, and a
missing file is a valid state rather than an error: no goals, no Goals view.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import date, timedelta

from . import db, stats
from .config import GOALS_PATH, GROUP_LABELS, GROUP_ORDER

PERIODS = ("week", "month")

# A goal against your whole programme rather than one sport. Not a member of
# GROUP_ORDER, so it can never collide with a real group.
ALL_SPORTS = "all"
ALL_SPORTS_LABEL = "All sports"

# How far back the history goes, per period. Twelve of each: a quarter of weeks
# and a year of months, both of which fit a small chart without thinning.
HISTORY = {"week": 12, "month": 12}

# Floats that came from summing kilometres shouldn't miss a target they landed
# exactly on.
EPS = 1e-9


class GoalError(ValueError):
    pass


# --------------------------------------------------------------------------
# The file
# --------------------------------------------------------------------------

def _one(entry: object, index: int) -> dict:
    """Validate a single entry, or raise with something worth reading."""
    where = f"entry {index + 1}"
    if not isinstance(entry, dict):
        raise GoalError(f"{where}: expected an object, got {type(entry).__name__}")

    missing = [k for k in ("sport", "period", "metric", "target") if k not in entry]
    if missing:
        raise GoalError(f"{where}: missing {', '.join(missing)}")

    sport, period, metric = entry["sport"], entry["period"], entry["metric"]
    if sport != ALL_SPORTS and sport not in GROUP_ORDER:
        raise GoalError(
            f"{where}: unknown sport {sport!r}, expected {ALL_SPORTS!r} "
            f"or one of {GROUP_ORDER}"
        )
    if period not in PERIODS:
        raise GoalError(f"{where}: unknown period {period!r}, expected 'week' or 'month'")
    if metric not in stats.METRICS:
        raise GoalError(
            f"{where}: unknown metric {metric!r}, expected one of {sorted(stats.METRICS)}"
        )

    target = entry["target"]
    # bool is an int in Python, and `"target": true` is a typo, not a target.
    if isinstance(target, bool) or not isinstance(target, (int, float)):
        raise GoalError(f"{where}: target must be a number, got {target!r}")
    if target <= 0:
        raise GoalError(f"{where}: target must be greater than zero, got {target}")

    return {
        "key": f"{period}-{sport}-{metric}",
        "sport": sport,
        "sport_label": ALL_SPORTS_LABEL if sport == ALL_SPORTS else GROUP_LABELS[sport],
        "period": period,
        "metric": metric,
        "metric_label": stats.METRICS[metric][2],
        "unit": stats.METRICS[metric][1],
        "target": float(target),
    }


def load() -> tuple[list[dict], list[str]]:
    """Every valid goal in the file, plus a complaint about each one that isn't."""
    if not GOALS_PATH.exists():
        return [], []

    try:
        raw = json.loads(GOALS_PATH.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return [], [f"{GOALS_PATH.name} could not be read: {exc}"]

    if isinstance(raw, dict):            # tolerate {"goals": [...]}
        raw = raw.get("goals", raw)
    if not isinstance(raw, list):
        return [], [f"{GOALS_PATH.name}: expected a list of goals"]

    goals: list[dict] = []
    problems: list[str] = []
    seen: set[str] = set()
    for index, entry in enumerate(raw):
        try:
            goal = _one(entry, index)
        except GoalError as exc:
            problems.append(str(exc))
            continue
        if goal["key"] in seen:
            problems.append(
                f"entry {index + 1}: a {goal['period']}ly {goal['sport']} "
                f"{goal['metric']} goal is already set — the later one is ignored"
            )
            continue
        seen.add(goal["key"])
        goals.append(goal)

    return goals, problems


# --------------------------------------------------------------------------
# Periods
# --------------------------------------------------------------------------

def _bounds(period: str, today: date, back: int) -> tuple[date, date]:
    """The period `back` periods before the one containing `today`."""
    if period == "week":
        monday = today - timedelta(days=today.weekday()) - timedelta(weeks=back)
        return monday, monday + timedelta(days=6)

    month = today.month - 1 - back
    year = today.year + month // 12
    month = month % 12 + 1
    start = date(year, month, 1)
    next_y, next_m = (year + 1, 1) if month == 12 else (year, month + 1)
    return start, date(next_y, next_m, 1) - timedelta(days=1)


def _aggregate(
    conn: sqlite3.Connection, period: str, start: date, end: date
) -> dict[tuple[str, str], dict]:
    """Every metric, per period-bucket and sport, in one pass."""
    rows = conn.execute(
        f"SELECT {stats.BUCKET_SQL[period]} AS bucket, sport_group, "
        "       COUNT(*)                  AS count, "
        "       SUM(distance) / 1000.0    AS distance, "
        "       SUM(moving_time) / 3600.0 AS time, "
        "       SUM(total_elevation_gain) AS elevation "
        "FROM activities "
        "WHERE local_date >= ? AND local_date <= ? "
        "GROUP BY bucket, sport_group",
        [start.isoformat(), end.isoformat()],
    ).fetchall()
    return {(r["bucket"], r["sport_group"]): r for r in rows}


def _value(agg: dict, bucket: date, sport: str, metric: str) -> float:
    row = agg.get((bucket.isoformat(), sport))
    return round((row[metric] or 0.0) if row else 0.0, 2)


# --------------------------------------------------------------------------

def overview() -> dict:
    """Current progress against every goal, and how the last few went.

    History covers *completed* periods only — the one in progress is the
    headline, not a data point, and a Tuesday counted alongside finished weeks
    would read as a miss every time. It also stops at the first activity on
    file: twelve weeks of zeros from before you had any data is not twelve
    missed goals.
    """
    goals, problems = load()
    if not goals:
        return {
            "available": False,
            "path": GOALS_PATH.name,
            "problems": problems,
            "periods": [],
        }

    today = date.today()
    out: list[dict] = []

    with db.cursor() as conn:
        span = conn.execute(
            "SELECT MIN(local_date) AS first FROM activities"
        ).fetchone()
        first = date.fromisoformat(span["first"]) if span and span["first"] else None

        for period in PERIODS:
            here = [g for g in goals if g["period"] == period]
            if not here:
                continue

            start, end = _bounds(period, today, 0)
            total_days = (end - start).days + 1
            elapsed = max(1, min(total_days, (today - start).days + 1))

            # Oldest first, so the charts read left to right like every other
            # one in the app.
            past = [_bounds(period, today, back) for back in range(HISTORY[period], 0, -1)]
            if first is not None:
                past = [w for w in past if w[0] >= first]
            else:
                past = []

            window_start = past[0][0] if past else start
            agg = _aggregate(conn, period, window_start, end)

            rows = []
            for goal in here:
                metric = goal["metric"]
                whole = goal["sport"] == ALL_SPORTS

                # Every goal carries the same shape: one entry per sport that
                # contributes to it. A single-sport goal has exactly one, so
                # the client draws both kinds the same way and an all-sports
                # goal stacks by sport instead of needing a colour of its own.
                # Sports with nothing in them are dropped from a whole-
                # programme goal — a legend entry for a sport you didn't do is
                # a label with no mark against it — but a single-sport goal
                # keeps its entry even at zero, because that *is* the goal.
                contributors = GROUP_ORDER if whole else [goal["sport"]]
                series = []
                for group in contributors:
                    current = _value(agg, start, group, metric)
                    trend = [_value(agg, s, group, metric) for s, _ in past]
                    if whole and not current and not any(trend):
                        continue
                    series.append({
                        "key": group,
                        "label": GROUP_LABELS[group],
                        "actual": current,
                        "history": trend,
                    })

                # Summed before rounding, so the total never disagrees with the
                # segments it is made of by a rounding step.
                actual = round(sum(s["actual"] for s in series), 2)
                history = [
                    round(sum(s["history"][i] for s in series), 2)
                    for i in range(len(past))
                ]
                hits = [v + EPS >= goal["target"] for v in history]

                # Counting back from now: the current period joins the streak
                # only once it has actually been hit, so a fresh Monday never
                # breaks a run you're still in the middle of extending.
                streak = 0
                if actual + EPS >= goal["target"]:
                    streak += 1
                for hit in reversed(hits):
                    if not hit:
                        break
                    streak += 1

                rows.append({
                    **goal,
                    "series": series,
                    "actual": actual,
                    "hit": actual + EPS >= goal["target"],
                    "remaining": round(max(0.0, goal["target"] - actual), 2),
                    # Where you'd be if the period were spread evenly. The
                    # honest comparison part-way through: 3 km of a 7 km week
                    # by Wednesday is on pace, not 43% of a failure.
                    "pace": round(goal["target"] * elapsed / total_days, 2),
                    "history": history,
                    "hits": sum(hits),
                    "tracked": len(hits),
                    "streak": streak,
                })

            out.append({
                "period": period,
                "start": start.isoformat(),
                "end": end.isoformat(),
                "today": today.isoformat(),
                "elapsed_days": elapsed,
                "total_days": total_days,
                "buckets": [{"start": s.isoformat(), "end": e.isoformat()} for s, e in past],
                "goals": rows,
            })

    return {
        "available": True,
        "path": GOALS_PATH.name,
        "problems": problems,
        "periods": out,
    }
