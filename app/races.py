"""Swim race results, read from pb.csv.

Deliberately *not* stored in SQLite. The file is hand-maintained, so it is
parsed on every request: edit it, reload the page, done. At this size (tens of
rows) parsing costs nothing.

Expected columns — see README § Swim races:

    Date,Distance,Nage,Bassin,Temps
    21/09/2025,100,breast,SCM,1:31:51

`Temps` is the swimming convention where the last colon-separated group is
hundredths of a second: `1:31:51` is 1 min 31.51 s, and `1:08:55:80` is
1 h 08 min 55.80 s. `1:31.51` with a decimal point works too.

A malformed row is skipped and reported rather than breaking the page — the
file is edited by hand, so a typo is a question of when, not if.
"""

from __future__ import annotations

import csv
from datetime import date, datetime
from typing import Any

from .config import RACES_PATH

# Canonical stroke -> (display label, sort order)
STROKES: dict[str, tuple[str, int]] = {
    "free": ("Freestyle", 0),
    "back": ("Backstroke", 1),
    "breast": ("Breaststroke", 2),
    "fly": ("Butterfly", 3),
    "IM": ("Individual medley", 4),
}

_STROKE_ALIASES = {
    "free": "free", "freestyle": "free", "fr": "free", "crawl": "free", "nl": "free",
    "back": "back", "backstroke": "back", "bk": "back", "dos": "back",
    "breast": "breast", "breaststroke": "breast", "br": "breast", "brasse": "breast",
    "fly": "fly", "butterfly": "fly", "butter": "fly", "fl": "fly", "papillon": "fly",
    "im": "IM", "medley": "IM", "individual medley": "IM", "4n": "IM", "4 nages": "IM",
}

# Canonical course -> (display label, sort order)
COURSES: dict[str, tuple[str, int]] = {
    "SCM": ("25 m pool", 0),
    "LCM": ("50 m pool", 1),
    "OW": ("Open water", 2),
}

_COURSE_ALIASES = {
    "scm": "SCM", "25": "SCM", "25m": "SCM", "short": "SCM", "short course": "SCM",
    "lcm": "LCM", "50": "LCM", "50m": "LCM", "long": "LCM", "long course": "LCM",
    "ow": "OW", "open": "OW", "openwater": "OW", "open water": "OW", "oc": "OW",
}


class RaceParseError(ValueError):
    pass


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------

def parse_time(text: str) -> float:
    """Swim time -> seconds. Accepts M:SS:hh, H:MM:SS:hh and dotted variants."""
    raw = (text or "").strip()
    if not raw:
        raise RaceParseError("empty time")

    if "." in raw:                       # 1:31.51
        head, frac = raw.rsplit(".", 1)
        if not frac.isdigit():
            raise RaceParseError(f"bad fraction in {raw!r}")
        fraction = int(frac) / (10 ** len(frac))
        parts = head.split(":")
    else:
        parts = raw.split(":")
        fraction = 0.0
        if len(parts) >= 3:              # last group is hundredths
            tail = parts[-1]
            if not tail.isdigit():
                raise RaceParseError(f"bad fraction in {raw!r}")
            fraction = int(tail) / (10 ** len(tail)) if len(tail) != 2 else int(tail) / 100
            parts = parts[:-1]

    if not all(p.strip().isdigit() for p in parts) or not 1 <= len(parts) <= 3:
        raise RaceParseError(f"cannot read time {raw!r}")

    values = [int(p) for p in parts]
    while len(values) < 3:
        values.insert(0, 0)
    hours, minutes, seconds = values

    if minutes > 59 or seconds > 59:
        raise RaceParseError(f"time {raw!r} has a group above 59 — is a colon missing?")

    return hours * 3600 + minutes * 60 + seconds + fraction


def parse_day(text: str) -> date:
    """DD/MM/YYYY (what Excel gives) or YYYY-MM-DD."""
    raw = (text or "").strip()
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    raise RaceParseError(f"cannot read date {raw!r} — expected DD/MM/YYYY")


def format_time(seconds: float) -> str:
    """Seconds -> 40.73 / 1:31.51 / 1:08:55.80."""
    total = round(seconds, 2)
    hours = int(total // 3600)
    rest = total - hours * 3600
    minutes = int(rest // 60)
    secs = rest - minutes * 60
    if hours:
        return f"{hours}:{minutes:02d}:{secs:05.2f}"
    if minutes:
        return f"{minutes}:{secs:05.2f}"
    return f"{secs:.2f}"


def format_pace(seconds_per_100: float) -> str:
    """Seconds per 100 m -> 1:48.8."""
    minutes = int(seconds_per_100 // 60)
    secs = seconds_per_100 - minutes * 60
    return f"{minutes}:{secs:04.1f}" if minutes else f"{secs:.1f}"


def format_gap(seconds: float) -> str:
    """A signed difference against a reference time."""
    sign = "+" if seconds > 0 else "−"
    value = abs(round(seconds, 2))
    if value < 60:
        return f"{sign}{value:.2f}"
    return f"{sign}{format_time(value)}"


def _normalise(value: str, aliases: dict[str, str]) -> tuple[str, bool]:
    key = (value or "").strip()
    mapped = aliases.get(key.lower())
    return (mapped, True) if mapped else (key, False)


def load_races() -> tuple[list[dict[str, Any]], list[str]]:
    """Read pb.csv. Returns (races, problems); never raises on bad rows."""
    if not RACES_PATH.exists():
        return [], []

    problems: list[str] = []
    races: list[dict[str, Any]] = []

    with RACES_PATH.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        missing = {"Date", "Distance", "Nage", "Bassin", "Temps"} - set(reader.fieldnames or [])
        if missing:
            return [], [
                f"{RACES_PATH.name}: missing column(s) {', '.join(sorted(missing))}. "
                f"Expected header: Date,Distance,Nage,Bassin,Temps"
            ]

        for line_no, row in enumerate(reader, start=2):
            if not any((value or "").strip() for value in row.values()):
                continue                      # blank line
            try:
                day = parse_day(row["Date"])
                seconds = parse_time(row["Temps"])
                distance_raw = (row["Distance"] or "").strip()
                if not distance_raw.isdigit() or int(distance_raw) <= 0:
                    raise RaceParseError(f"distance {distance_raw!r} is not a positive number")
                distance = int(distance_raw)

                stroke, known_stroke = _normalise(row["Nage"], _STROKE_ALIASES)
                course, known_course = _normalise(row["Bassin"], _COURSE_ALIASES)
                if not stroke or not course:
                    raise RaceParseError("stroke and pool are both required")
                if not known_stroke:
                    problems.append(f"line {line_no}: unrecognised stroke {stroke!r} — shown as-is")
                if not known_course:
                    problems.append(f"line {line_no}: unrecognised pool {course!r} — shown as-is")
            except RaceParseError as exc:
                problems.append(f"line {line_no}: {exc} — row skipped")
                continue

            races.append({
                "date": day,
                "distance": distance,
                "stroke": stroke,
                "course": course,
                "seconds": round(seconds, 2),
            })

    return races, problems


# --------------------------------------------------------------------------
# Aggregation
# --------------------------------------------------------------------------

def _stroke_label(stroke: str) -> str:
    return STROKES.get(stroke, (stroke.capitalize(), 99))[0]


def _stroke_order(stroke: str) -> int:
    return STROKES.get(stroke, (stroke, 99))[1]


def _course_label(course: str) -> str:
    return COURSES.get(course, (course, 99))[0]


def _course_order(course: str) -> int:
    return COURSES.get(course, (course, 99))[1]


def _race_out(race: dict[str, Any], best_seconds: float) -> dict[str, Any]:
    return {
        "date": race["date"].isoformat(),
        "seconds": race["seconds"],
        "display": format_time(race["seconds"]),
        "pace": format_pace(race["seconds"] / race["distance"] * 100),
        "is_best": race["seconds"] == best_seconds,
        "gap": None if race["seconds"] == best_seconds
               else format_gap(race["seconds"] - best_seconds),
    }


def overview() -> dict[str, Any]:
    """Everything the races view needs, in one payload."""
    races, problems = load_races()
    if not races:
        return {
            "available": False,
            "path": RACES_PATH.name,
            "count": 0,
            "problems": problems,
            "totals": {"races": 0, "events": 0, "bests_this_year": 0, "year": date.today().year},
            "courses": [],
            "progression": [],
            "log": [],
        }

    # Group into events: an event is one distance + stroke + pool. Times across
    # different pool lengths are not comparable, so the pool is part of the key.
    events: dict[tuple[int, str, str], list[dict[str, Any]]] = {}
    for race in races:
        events.setdefault((race["distance"], race["stroke"], race["course"]), []).append(race)

    this_year = date.today().year
    bests_this_year = 0
    by_course: dict[str, list[dict[str, Any]]] = {}
    progression: list[dict[str, Any]] = []

    for (distance, stroke, course), entries in events.items():
        entries.sort(key=lambda r: r["date"])
        best = min(entries, key=lambda r: r["seconds"])
        first, latest = entries[0], entries[-1]
        if best["date"].year == this_year:
            bests_this_year += 1

        event = {
            "key": f"{distance}-{stroke}-{course}",
            "distance": distance,
            "stroke": stroke,
            "stroke_label": _stroke_label(stroke),
            "course": course,
            "course_label": _course_label(course),
            "label": f"{distance} m {_stroke_label(stroke).lower()}",
            "races": len(entries),
            "best": _race_out(best, best["seconds"]),
            "first": _race_out(first, best["seconds"]),
            "latest": _race_out(latest, best["seconds"]),
            "pace": format_pace(best["seconds"] / distance * 100),
            # Time taken off since the first attempt. None when there is only
            # one race (nothing to compare) or when the debut is still the best
            # — which `best_on_debut` then says explicitly, since a bare dash
            # would read as missing data rather than as a fast first swim.
            "improvement": None if len(entries) < 2 or first["seconds"] <= best["seconds"]
                           else format_gap(-(first["seconds"] - best["seconds"])),
            "best_on_debut": len(entries) > 1 and first["seconds"] <= best["seconds"],
        }
        by_course.setdefault(course, []).append(event)

        if len(entries) > 1:
            progression.append({
                **event,
                "points": [_race_out(entry, best["seconds"]) for entry in entries],
            })

    def event_sort(event: dict[str, Any]) -> tuple:
        return (event["distance"], _stroke_order(event["stroke"]))

    courses = [
        {
            "key": course,
            "label": _course_label(course),
            "events": sorted(by_course[course], key=event_sort),
        }
        for course in sorted(by_course, key=_course_order)
    ]

    progression.sort(key=lambda e: (_course_order(e["course"]), *event_sort(e)))

    best_by_event = {
        (d, s, c): min(entries, key=lambda r: r["seconds"])["seconds"]
        for (d, s, c), entries in events.items()
    }
    log = [
        {
            "distance": race["distance"],
            "stroke_label": _stroke_label(race["stroke"]),
            "course": race["course"],
            "course_label": _course_label(race["course"]),
            **_race_out(race, best_by_event[(race["distance"], race["stroke"], race["course"])]),
        }
        for race in sorted(races, key=lambda r: (r["date"], r["distance"]), reverse=True)
    ]

    return {
        "available": True,
        "path": RACES_PATH.name,
        "count": len(races),
        "problems": problems,
        "totals": {
            "races": len(races),
            "events": len(events),
            "bests_this_year": bests_this_year,
            "year": this_year,
        },
        "courses": courses,
        "progression": progression,
        "log": log,
    }
