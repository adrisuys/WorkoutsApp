"""Aggregations — every chart on the dashboard is one query in here."""

from __future__ import annotations

import re
import sqlite3
import unicodedata
from datetime import date, timedelta

from . import db, duplicates
from .config import GROUP_LABELS, GROUP_ORDER, OTHER_GROUP

# Metric -> (SQL aggregate over the activities table, unit, label)
METRICS: dict[str, tuple[str, str, str]] = {
    "distance":  ("SUM(distance) / 1000.0",             "km", "Distance"),
    "time":      ("SUM(moving_time) / 3600.0",          "h",  "Moving time"),
    "elevation": ("SUM(total_elevation_gain)",          "m",  "Elevation gain"),
    "count":     ("COUNT(*)",                           "",   "Sessions"),
}

# Bucket -> SQL expression yielding the bucket's *start date* as YYYY-MM-DD.
BUCKET_SQL: dict[str, str] = {
    "week":  "date(local_date, 'weekday 0', '-6 days')",   # Monday of that week
    "month": "strftime('%Y-%m-01', local_date)",
    "year":  "strftime('%Y-01-01', local_date)",
}

# Peaks are asked at one grain finer than the charts: a single day is a
# meaningful record even though it makes a useless x-axis over ten years.
RECORD_BUCKET_SQL: dict[str, str] = {"day": "local_date", **BUCKET_SQL}

# A grain is only offered once the period is long enough to hold one of it —
# "best year in the last 12 weeks" is a question with no content.
RECORD_MIN_DAYS: dict[str, int] = {"day": 1, "week": 7, "month": 28, "year": 365}


class BadRequest(ValueError):
    pass


def _check(metric: str, bucket: str | None = None) -> None:
    if metric not in METRICS:
        raise BadRequest(f"Unknown metric {metric!r}; expected one of {sorted(METRICS)}")
    if bucket is not None and bucket not in BUCKET_SQL:
        raise BadRequest(f"Unknown bucket {bucket!r}; expected one of {sorted(BUCKET_SQL)}")


def _parse_day(value: str | None, fallback: date) -> date:
    if not value:
        return fallback
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise BadRequest(f"Invalid date {value!r}, expected YYYY-MM-DD") from exc


def _group_filter(groups: list[str] | None) -> tuple[str, list]:
    """Build the optional `AND sport_group IN (...)` clause."""
    if not groups:
        return "", []
    unknown = [g for g in groups if g not in GROUP_ORDER]
    if unknown:
        raise BadRequest(f"Unknown sport group(s): {unknown}")
    return f" AND sport_group IN ({', '.join('?' * len(groups))})", list(groups)


def bucket_starts(start: date, end: date, bucket: str) -> list[str]:
    """Every bucket start between start and end, so charts show empty periods."""
    out: list[str] = []
    if bucket == "week":
        cur = start - timedelta(days=start.weekday())
        while cur <= end:
            out.append(cur.isoformat())
            cur += timedelta(days=7)
    elif bucket == "month":
        y, m = start.year, start.month
        while date(y, m, 1) <= end:
            out.append(date(y, m, 1).isoformat())
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    else:  # year
        for y in range(start.year, end.year + 1):
            out.append(date(y, 1, 1).isoformat())
    return out


# --------------------------------------------------------------------------

def overview() -> dict:
    """What the dashboard needs before it can draw anything."""
    with db.cursor() as conn:
        row = conn.execute(
            "SELECT MIN(local_date) AS first, MAX(local_date) AS last, COUNT(*) AS n "
            "FROM activities"
        ).fetchone()
        per_group = conn.execute(
            "SELECT sport_group, COUNT(*) AS n FROM activities GROUP BY sport_group"
        ).fetchall()
        counts = {r["sport_group"]: r["n"] for r in per_group}
        last_sync = db.get_meta(conn, "last_sync")

    # Keep the canonical order; only surface groups that actually have data.
    groups = [
        {"key": g, "label": GROUP_LABELS[g], "count": counts.get(g, 0)}
        for g in GROUP_ORDER
        if counts.get(g, 0) > 0
    ]
    return {
        "first_date": row["first"],
        "last_date": row["last"],
        "activity_count": row["n"],
        "groups": groups,
        "last_sync": last_sync,
        # Sessions Strava holds twice. Every total on every view counts those
        # twice too, so this rides along with the thing every client fetches
        # first rather than waiting to be asked for.
        "duplicates": duplicates.find(),
        "metrics": {k: {"unit": v[1], "label": v[2]} for k, v in METRICS.items()},
    }


def series(
    metric: str,
    bucket: str,
    start: str | None = None,
    end: str | None = None,
    groups: list[str] | None = None,
) -> dict:
    """A dense time series per sport group — the main chart."""
    _check(metric, bucket)
    agg, unit, label = METRICS[metric]
    today = date.today()

    with db.cursor() as conn:
        span = conn.execute(
            "SELECT MIN(local_date) AS first, MAX(local_date) AS last FROM activities"
        ).fetchone()
        first = _parse_day(span["first"], today)
        start_d = _parse_day(start, first)
        end_d = _parse_day(end, today)
        if end_d < start_d:
            raise BadRequest("`end` is before `start`")

        clause, params = _group_filter(groups)
        rows = conn.execute(
            f"SELECT {BUCKET_SQL[bucket]} AS bucket, sport_group, {agg} AS value "
            f"FROM activities "
            f"WHERE local_date >= ? AND local_date <= ?{clause} "
            f"GROUP BY bucket, sport_group",
            [start_d.isoformat(), end_d.isoformat(), *params],
        ).fetchall()

    buckets = bucket_starts(start_d, end_d, bucket)
    index = {b: i for i, b in enumerate(buckets)}
    present = [g for g in GROUP_ORDER if any(r["sport_group"] == g for r in rows)]
    data = {g: [0.0] * len(buckets) for g in present}

    for r in rows:
        pos = index.get(r["bucket"])
        if pos is not None:  # a bucket can fall outside the range at the edges
            data[r["sport_group"]][pos] = round(r["value"] or 0.0, 2)

    return {
        "metric": metric,
        "unit": unit,
        "label": label,
        "bucket": bucket,
        "start": start_d.isoformat(),
        "end": end_d.isoformat(),
        "buckets": buckets,
        "series": [
            {"key": g, "label": GROUP_LABELS[g], "values": data[g]} for g in present
        ],
    }


def _totals_for(
    conn: sqlite3.Connection, start: date, end: date, groups: list[str] | None
) -> dict[str, dict]:
    clause, params = _group_filter(groups)
    rows = conn.execute(
        "SELECT sport_group, "
        "       COUNT(*)                          AS count, "
        "       SUM(distance) / 1000.0            AS distance, "
        "       SUM(moving_time) / 3600.0         AS time, "
        "       SUM(total_elevation_gain)         AS elevation "
        "FROM activities "
        f"WHERE local_date >= ? AND local_date <= ?{clause} "
        "GROUP BY sport_group",
        [start.isoformat(), end.isoformat(), *params],
    ).fetchall()
    return {
        r["sport_group"]: {
            "count": r["count"],
            "distance": round(r["distance"] or 0.0, 2),
            "time": round(r["time"] or 0.0, 2),
            "elevation": round(r["elevation"] or 0.0, 0),
        }
        for r in rows
    }


def totals(
    start: str | None = None,
    end: str | None = None,
    groups: list[str] | None = None,
) -> dict:
    """Per-sport totals for the period, plus the period immediately before it."""
    today = date.today()
    with db.cursor() as conn:
        span = conn.execute(
            "SELECT MIN(local_date) AS first FROM activities"
        ).fetchone()
        start_d = _parse_day(start, _parse_day(span["first"], today))
        end_d = _parse_day(end, today)
        if end_d < start_d:
            raise BadRequest("`end` is before `start`")

        length = (end_d - start_d).days + 1
        prev_end = start_d - timedelta(days=1)
        prev_start = prev_end - timedelta(days=length - 1)

        current = _totals_for(conn, start_d, end_d, groups)
        previous = _totals_for(conn, prev_start, prev_end, groups)

    empty = {"count": 0, "distance": 0.0, "time": 0.0, "elevation": 0.0}
    present = [g for g in GROUP_ORDER if g in current or g in previous]
    rows = [
        {
            "key": g,
            "label": GROUP_LABELS[g],
            "current": current.get(g, empty),
            "previous": previous.get(g, empty),
        }
        for g in present
    ]
    grand = {
        field: round(sum(r["current"][field] for r in rows), 2)
        for field in ("count", "distance", "time", "elevation")
    }
    grand_prev = {
        field: round(sum(r["previous"][field] for r in rows), 2)
        for field in ("count", "distance", "time", "elevation")
    }
    return {
        "start": start_d.isoformat(),
        "end": end_d.isoformat(),
        "previous_start": prev_start.isoformat(),
        "previous_end": prev_end.isoformat(),
        "rows": rows,
        "total": grand,
        "previous_total": grand_prev,
    }


WEEK_FIELDS = ("count", "distance", "time", "elevation")


def _round_totals(values: dict) -> dict:
    return {
        "count": int(values["count"]),
        "distance": round(values["distance"], 2),
        "time": round(values["time"], 2),
        "elevation": round(values["elevation"], 0),
    }


def week(offset: int = 0) -> dict:
    """One calendar week, Monday to Sunday, day by day and sport by sport.

    `offset` counts weeks back from the current one: 0 is this week, -1 last
    week. Future weeks are refused — there is nothing in them.

    Days still to come are part of the week and come back as zeros: the empty
    end of the chart is how much of the week is left. The comparison is against
    the week before *to the same weekday*, because a part week measured against
    a whole one reads as a slump every Monday morning. A week that is over is
    compared with the whole of the one before it.

    Every metric comes back at once, per sport and in total — there are at most
    seven days times a handful of sports in here, so switching measure or
    unticking a sport is a client-side choice rather than another round trip.
    """
    if offset > 0:
        raise BadRequest("`offset` cannot be in the future")

    today = date.today()
    monday = today - timedelta(days=today.weekday()) + timedelta(weeks=offset)
    sunday = monday + timedelta(days=6)
    days = [(monday + timedelta(days=i)).isoformat() for i in range(7)]

    # How much of this week has happened: all of it once it is behind us.
    elapsed = 7 if sunday < today else max(0, min(7, (today - monday).days + 1))
    prev_start = monday - timedelta(days=7)
    prev_end = prev_start + timedelta(days=elapsed - 1)

    with db.cursor() as conn:
        rows = conn.execute(
            "SELECT local_date, sport_group, "
            "       COUNT(*)                  AS count, "
            "       SUM(distance) / 1000.0    AS distance, "
            "       SUM(moving_time) / 3600.0 AS time, "
            "       SUM(total_elevation_gain) AS elevation "
            "FROM activities "
            "WHERE local_date >= ? AND local_date <= ? "
            "GROUP BY local_date, sport_group",
            [monday.isoformat(), sunday.isoformat()],
        ).fetchall()
        previous = _totals_for(conn, prev_start, prev_end, None)
        # Whether there is anywhere further back to go, so the UI can stop
        # offering weeks that were over before any of this was recorded.
        earlier = conn.execute(
            "SELECT 1 FROM activities WHERE local_date < ? LIMIT 1",
            [monday.isoformat()],
        ).fetchone() is not None

    index = {d: i for i, d in enumerate(days)}
    present = [g for g in GROUP_ORDER if any(r["sport_group"] == g for r in rows)]
    data = {g: {f: [0.0] * 7 for f in WEEK_FIELDS} for g in present}
    # Each sport's own total, added up before anything is rounded. Adding up the
    # rounded per-day figures instead can land a metre either side of the grand
    # total, and a table whose rows don't add up to its own footer is worse than
    # one that is a metre out.
    per_sport = {g: dict.fromkeys(WEEK_FIELDS, 0.0) for g in present}
    running = {f: 0.0 for f in WEEK_FIELDS}
    active: set[str] = set()

    for r in rows:
        pos = index[r["local_date"]]
        active.add(r["local_date"])
        for field in WEEK_FIELDS:
            value = r[field] or 0.0
            data[r["sport_group"]][field][pos] = round(value, 2)
            per_sport[r["sport_group"]][field] += value
            running[field] += value

    prev_total = {f: sum(v[f] for v in previous.values()) for f in WEEK_FIELDS}
    empty = dict.fromkeys(WEEK_FIELDS, 0.0)

    return {
        "offset": offset,
        "start": monday.isoformat(),
        "end": sunday.isoformat(),
        "today": today.isoformat(),
        "days": days,
        "elapsed_days": elapsed,
        "active_days": len(active),
        "has_earlier": earlier,
        "previous_start": prev_start.isoformat(),
        "previous_end": prev_end.isoformat(),
        # Each sport carries its own share of the comparison, so unticking one
        # can take it out of both sides of the sum rather than just this week's.
        "series": [
            {
                "key": g,
                "label": GROUP_LABELS[g],
                "totals": _round_totals(per_sport[g]),
                "previous": _round_totals(previous.get(g, empty)),
                **data[g],
            }
            for g in present
        ],
        "totals": _round_totals(running),
        "previous": _round_totals(prev_total),
    }


def _bucket_end(start: date, bucket: str) -> date:
    """Last day covered by the bucket that starts on `start`."""
    if bucket == "day":
        return start
    if bucket == "week":
        return start + timedelta(days=6)
    if bucket == "month":
        y, m = (start.year + 1, 1) if start.month == 12 else (start.year, start.month + 1)
        return date(y, m, 1) - timedelta(days=1)
    return date(start.year, 12, 31)


def records(
    metric: str,
    start: str | None = None,
    end: str | None = None,
    groups: list[str] | None = None,
) -> dict:
    """The biggest single day, week, month and year inside the period.

    One metric, summed across the selected sports — the same total the tiles
    show, asked as "when was it highest?" instead of "how much overall?".
    """
    _check(metric)
    agg, unit, label = METRICS[metric]
    today = date.today()

    with db.cursor() as conn:
        span = conn.execute(
            "SELECT MIN(local_date) AS first FROM activities"
        ).fetchone()
        start_d = _parse_day(start, _parse_day(span["first"], today))
        end_d = _parse_day(end, today)
        if end_d < start_d:
            raise BadRequest("`end` is before `start`")

        clause, params = _group_filter(groups)
        length = (end_d - start_d).days + 1
        out: list[dict] = []

        for bucket, expr in RECORD_BUCKET_SQL.items():
            if length < RECORD_MIN_DAYS[bucket]:
                continue
            row = conn.execute(
                f"SELECT {expr} AS bucket, {agg} AS value, COUNT(*) AS sessions "
                f"FROM activities "
                f"WHERE local_date >= ? AND local_date <= ?{clause} "
                f"GROUP BY bucket ORDER BY value DESC, bucket DESC LIMIT 1",
                [start_d.isoformat(), end_d.isoformat(), *params],
            ).fetchone()
            if row is None or not row["value"]:
                out.append({"bucket": bucket, "value": None})
                continue

            b_start = date.fromisoformat(row["bucket"])
            b_end = _bucket_end(b_start, bucket)
            out.append({
                "bucket": bucket,
                "start": b_start.isoformat(),
                "end": b_end.isoformat(),
                "value": round(row["value"] or 0.0, 2),
                "sessions": row["sessions"],
                # A window can clip the winning bucket — the best "month" of the
                # last 12 months may be the half of one the period starts in.
                "complete": b_start >= start_d and b_end <= end_d,
            })

    return {
        "metric": metric,
        "unit": unit,
        "label": label,
        "start": start_d.isoformat(),
        "end": end_d.isoformat(),
        "records": out,
    }


def _grain_windows(start: date, end: date, bucket: str) -> list[tuple[date, date]]:
    """Every bucket of this grain that touches the range, as (start, end)."""
    if bucket == "day":
        starts = []
        cur = start
        while cur <= end:
            starts.append(cur)
            cur += timedelta(days=1)
    else:
        starts = [date.fromisoformat(s) for s in bucket_starts(start, end, bucket)]
    return [(s, _bucket_end(s, bucket)) for s in starts]


def averages(
    metric: str,
    start: str | None = None,
    end: str | None = None,
    groups: list[str] | None = None,
) -> dict:
    """The typical day, week, month and year inside the period.

    Part-buckets at either end count in proportion to how much of them the
    period actually covers: a window ending on the 30th counts that August as
    30/31 of a month, against the 38.5 km you swam in it. Dropping them instead
    would be the bigger lie — on any period ending today the current month is
    always the part-bucket, so the monthly figure would silently ignore up to
    thirty days of the most recent training. Weighting also keeps the grains
    telling the same story: per week is per day times seven, by construction.

    Buckets with nothing in them still count: a month with two rest weeks *is*
    a quieter month, and hiding that would make the number meaningless.
    """
    _check(metric)
    agg, unit, label = METRICS[metric]
    today = date.today()

    with db.cursor() as conn:
        span = conn.execute(
            "SELECT MIN(local_date) AS first FROM activities"
        ).fetchone()
        start_d = _parse_day(start, _parse_day(span["first"], today))
        end_d = _parse_day(end, today)
        if end_d < start_d:
            raise BadRequest("`end` is before `start`")

        clause, params = _group_filter(groups)
        length = (end_d - start_d).days + 1
        out: list[dict] = []

        for bucket, expr in RECORD_BUCKET_SQL.items():
            if length < RECORD_MIN_DAYS[bucket]:
                continue
            rows = conn.execute(
                f"SELECT {expr} AS bucket, {agg} AS value "
                f"FROM activities "
                f"WHERE local_date >= ? AND local_date <= ?{clause} "
                f"GROUP BY bucket",
                [start_d.isoformat(), end_d.isoformat(), *params],
            ).fetchall()
            values = {r["bucket"]: (r["value"] or 0.0) for r in rows}

            windows = _grain_windows(start_d, end_d, bucket)
            if not windows:
                out.append({"bucket": bucket, "value": None})
                continue

            # Each bucket weighs what the period covers of it. The totals come
            # back already clipped to the period, so a half-covered month is a
            # half month's worth of training over half a month of denominator.
            weighted = []
            for w_start, w_end in windows:
                covered = (min(w_end, end_d) - max(w_start, start_d)).days + 1
                weighted.append((
                    values.get(w_start.isoformat(), 0.0),
                    covered / ((w_end - w_start).days + 1),
                ))
            span = sum(weight for _, weight in weighted)
            active = [(total, weight) for total, weight in weighted if total > 0]
            active_span = sum(weight for _, weight in active)
            out.append({
                "bucket": bucket,
                "value": round(sum(t for t, _ in weighted) / span, 2),
                # The same total over only the buckets you did something in.
                # Reported alongside the mean rather than instead of it: "a
                # typical week" and "a typical week you trained" are different
                # questions, and the distance between the two answers is the
                # part worth seeing. Computed here rather than derived on the
                # client from `value`, which is already rounded.
                "active_value": (
                    round(sum(t for t, _ in active) / active_span, 2)
                    if active_span else None
                ),
                "buckets": len(windows),
                "active": len(active),
                # True when a part-bucket at either end was counted in proportion.
                "partial": any(weight < 1 for _, weight in weighted),
            })

    return {
        "metric": metric,
        "unit": unit,
        "label": label,
        "start": start_d.isoformat(),
        "end": end_d.isoformat(),
        "averages": out,
    }


# Sortable columns for the activity log. Anything not in here is rejected
# rather than interpolated into the query.
LOG_SORTS: dict[str, str] = {
    "date": "local_date",
    "distance": "distance",
    "time": "moving_time",
    "elevation": "total_elevation_gain",
}

LOG_PAGE_MAX = 200


def _fold(value: str | None) -> str:
    """Lowercase and strip accents, so 'randonnee' matches 'Randonnée'."""
    if not value:
        return ""
    decomposed = unicodedata.normalize("NFD", value.casefold())
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def log_label(group: str | None, sport_type: str | None) -> str:
    """What a workout is called in the log.

    Strava's own names are noise here ("Randonnée le matin" a thousand times
    over), so a workout is called what it is. Grouped sports take the group's
    name — a Walk is a Hike, by the same taxonomy the charts use — and anything
    that fell into Other keeps its real type, which is the only place the
    distinction between a weights session and a ski tour survives.
    """
    if group and group != OTHER_GROUP[0] and group in GROUP_LABELS:
        return GROUP_LABELS[group]
    spaced = re.sub(r"(?<!^)(?=[A-Z])", " ", sport_type or "Unknown")
    return spaced[:1].upper() + spaced[1:].lower()


def activities(
    q: str | None = None,
    groups: list[str] | None = None,
    start: str | None = None,
    end: str | None = None,
    sort: str = "date",
    direction: str = "desc",
    limit: int = 50,
    offset: int = 0,
) -> dict:
    """The plain list of workouts, searchable and sortable.

    Returns one page of rows plus the totals for the *whole* match, so the
    header can say what the filter found rather than what fits on screen.
    """
    if sort not in LOG_SORTS:
        raise BadRequest(f"Unknown sort {sort!r}; expected one of {sorted(LOG_SORTS)}")
    if direction not in ("asc", "desc"):
        raise BadRequest(f"Unknown direction {direction!r}; expected 'asc' or 'desc'")
    limit = max(1, min(limit, LOG_PAGE_MAX))
    offset = max(0, offset)

    where = ["1=1"]
    params: list = []
    if start:
        where.append("local_date >= ?")
        params.append(_parse_day(start, date.min).isoformat())
    if end:
        where.append("local_date <= ?")
        params.append(_parse_day(end, date.max).isoformat())

    clause, group_params = _group_filter(groups)
    if clause:
        where.append(clause.removeprefix(" AND "))
        params.extend(group_params)

    needle = (q or "").strip()
    if needle:
        # Matched against the label the row actually shows, plus the date, so a
        # hit is never a row whose visible text lacks what you typed. "hike",
        # "weight training" and "2025-09" all work.
        where.append("(fold(log_label(sport_group, sport_type)) LIKE ? OR local_date LIKE ?)")
        params.extend([f"%{_fold(needle)}%", f"%{needle}%"])

    sql_where = " AND ".join(where)
    # Ties broken by start time then id so paging can't repeat or skip a row.
    order = f"{LOG_SORTS[sort]} {direction.upper()}, start_date_local DESC, id DESC"

    with db.cursor() as conn:
        conn.create_function("fold", 1, _fold, deterministic=True)
        conn.create_function("log_label", 2, log_label, deterministic=True)
        summary = conn.execute(
            f"SELECT COUNT(*) AS count, "
            f"       SUM(distance) / 1000.0 AS distance, "
            f"       SUM(moving_time) AS seconds, "
            f"       SUM(total_elevation_gain) AS elevation "
            f"FROM activities WHERE {sql_where}",
            params,
        ).fetchone()
        rows = conn.execute(
            f"SELECT id, local_date, sport_type, sport_group, distance, "
            f"       moving_time, total_elevation_gain "
            f"FROM activities WHERE {sql_where} "
            f"ORDER BY {order} LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()

    total = summary["count"] or 0
    return {
        "query": needle,
        "sort": sort,
        "direction": direction,
        "limit": limit,
        "offset": offset,
        "total": total,
        "has_more": offset + len(rows) < total,
        "totals": {
            "count": total,
            "distance": round(summary["distance"] or 0.0, 2),
            "time": round((summary["seconds"] or 0) / 3600.0, 2),
            "elevation": round(summary["elevation"] or 0.0, 0),
        },
        "rows": [
            {
                "id": r["id"],
                "date": r["local_date"],
                "label": log_label(r["sport_group"], r["sport_type"]),
                "group": r["sport_group"],
                "distance": round((r["distance"] or 0.0) / 1000.0, 2),
                "seconds": r["moving_time"] or 0,
                "elevation": round(r["total_elevation_gain"] or 0.0, 0),
            }
            for r in rows
        ],
    }


def tracks(groups: list[str] | None = None) -> dict:
    """Every GPS trace on file, for the map of everywhere you've been.

    Strava's `map.summary_polyline` comes back with every activity in the list
    sync already stores, so this costs no API call at all. It is a simplified
    line — a few metres off at street level, which is plenty to see which
    streets you've walked — and is sent still encoded: decoding it is the
    browser's job, and the encoded form is a fraction of the size.

    Indoor and manual sessions have an empty polyline and are left out.
    """
    clause, params = _group_filter(groups)
    with db.cursor() as conn:
        rows = conn.execute(
            "SELECT id, local_date, sport_type, sport_group, distance, "
            "       json_extract(raw, '$.map.summary_polyline') AS line "
            "FROM activities "
            "WHERE COALESCE(json_extract(raw, '$.map.summary_polyline'), '') != ''"
            f"{clause} ORDER BY start_date_local",
            params,
        ).fetchall()
    return {
        "count": len(rows),
        "tracks": [
            {
                "id": r["id"],
                "date": r["local_date"],
                "label": log_label(r["sport_group"], r["sport_type"]),
                "group": r["sport_group"],
                "distance": round((r["distance"] or 0.0) / 1000.0, 2),
                "line": r["line"],
            }
            for r in rows
        ],
    }


def cumulative(metric: str, group: str, years: int = 6) -> dict:
    """Running total by day-of-year, one line per calendar year.

    The 'am I ahead of last year?' chart — the thing a per-period bar chart
    cannot show.
    """
    _check(metric)
    agg, unit, label = METRICS[metric]
    if group not in GROUP_ORDER:
        raise BadRequest(f"Unknown sport group {group!r}")

    today = date.today()
    first_year = today.year - years + 1

    with db.cursor() as conn:
        rows = conn.execute(
            f"SELECT CAST(strftime('%Y', local_date) AS INTEGER) AS yr, "
            f"       CAST(strftime('%j', local_date) AS INTEGER) AS doy, "
            f"       {agg} AS value "
            f"FROM activities "
            f"WHERE sport_group = ? AND local_date >= ? "
            f"GROUP BY yr, doy ORDER BY yr, doy",
            (group, date(first_year, 1, 1).isoformat()),
        ).fetchall()

    by_year: dict[int, list[dict]] = {}
    running: dict[int, float] = {}
    for r in rows:
        running[r["yr"]] = running.get(r["yr"], 0.0) + (r["value"] or 0.0)
        by_year.setdefault(r["yr"], []).append(
            {"doy": r["doy"], "value": round(running[r["yr"]], 2)}
        )

    # Each line starts at the origin so partial years don't appear to begin high.
    lines = []
    for yr in sorted(by_year):
        points = [{"doy": 0, "value": 0.0}, *by_year[yr]]
        lines.append({"year": yr, "points": points, "total": points[-1]["value"]})

    return {
        "metric": metric,
        "unit": unit,
        "label": label,
        "group": group,
        "group_label": GROUP_LABELS[group],
        "today_doy": int(today.strftime("%j")),
        "years": lines,
    }
