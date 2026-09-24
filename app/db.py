"""SQLite storage.

One row per Strava activity, with the full API payload kept in `raw`. That
blob is the point: when you think of a new statistic next year, you query
SQLite instead of re-crawling Strava.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from typing import Any, Iterator

from .config import DATA_DIR, DB_PATH, sport_group

SCHEMA = """
CREATE TABLE IF NOT EXISTS activities (
    id                   INTEGER PRIMARY KEY,
    name                 TEXT,
    sport_type           TEXT,
    sport_group          TEXT,
    start_date           TEXT,   -- UTC, ISO8601
    start_date_local     TEXT,   -- athlete local time, ISO8601
    local_date           TEXT,   -- YYYY-MM-DD, derived from start_date_local
    distance             REAL,   -- metres
    moving_time          INTEGER,-- seconds
    elapsed_time         INTEGER,-- seconds
    total_elevation_gain REAL,   -- metres
    average_speed        REAL,   -- m/s
    max_speed            REAL,
    average_heartrate    REAL,
    max_heartrate        REAL,
    suffer_score         REAL,
    trainer              INTEGER,
    commute              INTEGER,
    raw                  TEXT,   -- full JSON payload as returned by Strava
    fetched_at           TEXT
);

CREATE INDEX IF NOT EXISTS idx_activities_local_date  ON activities(local_date);
CREATE INDEX IF NOT EXISTS idx_activities_group       ON activities(sport_group);
CREATE INDEX IF NOT EXISTS idx_activities_group_date  ON activities(sport_group, local_date);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""

_COLUMNS = (
    "id", "name", "sport_type", "sport_group", "start_date", "start_date_local",
    "local_date", "distance", "moving_time", "elapsed_time",
    "total_elevation_gain", "average_speed", "max_speed", "average_heartrate",
    "max_heartrate", "suffer_score", "trainer", "commute", "raw", "fetched_at",
)


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    # WAL lets the web server read while the sync job writes.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def cursor() -> Iterator[sqlite3.Connection]:
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with cursor() as conn:
        conn.executescript(SCHEMA)


def get_meta(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def _to_row(activity: dict[str, Any], fetched_at: str) -> tuple:
    # Older activities predate `sport_type` and only carry the legacy `type`.
    sport_type = activity.get("sport_type") or activity.get("type") or "Unknown"
    start_local = activity.get("start_date_local") or ""
    return (
        activity["id"],
        activity.get("name"),
        sport_type,
        sport_group(sport_type),
        activity.get("start_date"),
        start_local,
        start_local[:10] or None,
        activity.get("distance"),
        activity.get("moving_time"),
        activity.get("elapsed_time"),
        activity.get("total_elevation_gain"),
        activity.get("average_speed"),
        activity.get("max_speed"),
        activity.get("average_heartrate"),
        activity.get("max_heartrate"),
        activity.get("suffer_score"),
        1 if activity.get("trainer") else 0,
        1 if activity.get("commute") else 0,
        json.dumps(activity, separators=(",", ":")),
        fetched_at,
    )


def upsert_activities(
    conn: sqlite3.Connection, activities: list[dict[str, Any]], fetched_at: str
) -> int:
    """Insert or refresh activities. Returns the number of rows written."""
    if not activities:
        return 0
    placeholders = ", ".join("?" * len(_COLUMNS))
    updates = ", ".join(f"{c} = excluded.{c}" for c in _COLUMNS if c != "id")
    conn.executemany(
        f"INSERT INTO activities ({', '.join(_COLUMNS)}) VALUES ({placeholders}) "
        f"ON CONFLICT(id) DO UPDATE SET {updates}",
        [_to_row(a, fetched_at) for a in activities],
    )
    return len(activities)


def delete_activities(conn: sqlite3.Connection, ids: list[int]) -> int:
    """Remove rows by id. Only `prune` calls this — syncing never deletes."""
    if not ids:
        return 0
    conn.executemany("DELETE FROM activities WHERE id = ?", [(i,) for i in ids])
    return len(ids)


def reclassify_sports(conn: sqlite3.Connection) -> int:
    """Recompute sport_group for every row after editing the taxonomy."""
    rows = conn.execute("SELECT id, sport_type FROM activities").fetchall()
    conn.executemany(
        "UPDATE activities SET sport_group = ? WHERE id = ?",
        [(sport_group(r["sport_type"]), r["id"]) for r in rows],
    )
    return len(rows)
