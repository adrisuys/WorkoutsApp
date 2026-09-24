"""Pull activities from Strava into SQLite.

Two modes:
  * backfill  — walk the whole history once (no `after` filter)
  * incremental — only what happened since the newest activity we hold,
    minus a safety window, because activities get uploaded and edited late.

Both also **remove** what Strava no longer has, within the window they actually
looked at. Asking for everything after a cutoff means Strava's answer is the
complete truth for that window: a row we hold inside it that did not come back
has been deleted upstream. Outside the window we were told nothing and nothing
is touched, so an incremental run tidies the last few days and `--full` tidies
the lot. That keeps deletion honest without a nine-page walk every hour.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from . import db, duplicates, strava

# Re-fetch this far back on every incremental run so that late uploads and
# after-the-fact edits (renames, distance corrections) land in the database.
OVERLAP_DAYS = 10

# A prune deletes local rows on the strength of a single walk of the API. If
# that walk comes back short — a truncated page, a narrowed scope, an account
# in a bad state — the diff reads as "the athlete deleted everything". Anything
# bigger than this share of the database is treated as suspect, not as truth.
MAX_PRUNE_FRACTION = 0.10


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _latest_start(conn) -> datetime | None:
    row = conn.execute("SELECT MAX(start_date) AS m FROM activities").fetchone()
    if not row or not row["m"]:
        return None
    return datetime.fromisoformat(row["m"].replace("Z", "+00:00"))


def run_sync(full: bool = False, verbose: bool = True, prune: bool = True) -> dict:
    """Fetch activities and upsert them. Returns a small summary dict.

    `prune` removes rows Strava no longer has inside the window this run
    looked at. On by default — a session deleted upstream is a session that
    should stop being counted here without anyone having to ask.
    """
    # Fail before doing anything visible if we were never authorised.
    if not strava.is_authorised():
        raise strava.NotAuthorised(
            "No Strava tokens yet. Run:  ./venv/bin/python -m app.cli authorize"
        )

    db.init_db()
    started = _now_iso()

    with db.cursor() as conn:
        before = conn.execute("SELECT COUNT(*) AS c FROM activities").fetchone()["c"]

        after_epoch = None
        if not full:
            latest = _latest_start(conn)
            if latest:
                after_epoch = int((latest - timedelta(days=OVERLAP_DAYS)).timestamp())

        if verbose:
            scope = "full backfill" if after_epoch is None else (
                f"since {datetime.fromtimestamp(after_epoch, timezone.utc):%Y-%m-%d}"
            )
            print(f"Syncing ({scope})…", flush=True)

        fetched = 0
        pages = 0
        seen: set[int] = set()
        for batch in strava.iter_activities(after=after_epoch):
            db.upsert_activities(conn, batch, started)
            seen.update(a["id"] for a in batch)
            fetched += len(batch)
            pages += 1
            if verbose:
                print(f"  page {pages}: {len(batch)} activities", flush=True)

        # Counted before anything is removed. Upserts only ever add, so this is
        # the number of genuinely new activities; netting the removals off it
        # would report "-2 new" on a run whose only work was tidying up two
        # deletions.
        added = conn.execute(
            "SELECT COUNT(*) AS c FROM activities"
        ).fetchone()["c"] - before

        # Only after every page came back: a walk that raised part-way through
        # never reaches this, so a half-read history can't read as a deletion.
        pruned = (_prune_seen_window(conn, seen, after_epoch, verbose)
                  if prune else {"removed": [], "blocked": False})

        after_count = conn.execute("SELECT COUNT(*) AS c FROM activities").fetchone()["c"]
        db.set_meta(conn, "last_sync", _now_iso())
        db.set_meta(conn, "last_sync_fetched", str(fetched))

    # Checked after every import, because an import is exactly when a second
    # copy of a session arrives. Reported, not dropped — see app/duplicates.py.
    dupes = duplicates.find()
    summary = {
        "fetched": fetched,
        "new": added,
        "total": after_count,
        "full": full,
        "removed": len(pruned["removed"]),
        "removal_blocked": pruned["blocked"],
        "duplicates": len(dupes),
        "finished_at": _now_iso(),
    }
    if verbose:
        removed = summary["removed"]
        gone = f", {removed} removed" if removed else ""
        print(
            f"Done — {fetched} fetched, {summary['new']} new{gone}, "
            f"{after_count} activities in the database.",
            flush=True,
        )
        _report_duplicates(dupes)
    return summary


def _prune_seen_window(conn, seen: set[int], after_epoch: int | None,
                       verbose: bool) -> dict:
    """Drop rows Strava no longer holds, limited to what this run could see.

    `after_epoch` is the cutoff the fetch used, so rows starting after it were
    all in scope and Strava's answer for them is complete. Rows before it were
    never asked about and are left alone. A full run has no cutoff and so covers
    everything.
    """
    if after_epoch is None:
        rows = conn.execute("SELECT id FROM activities").fetchall()
    else:
        # Strictly after, matching how Strava reads `after` — a row sitting
        # exactly on the cutoff may legitimately not have been returned.
        cutoff = datetime.fromtimestamp(after_epoch, timezone.utc)
        rows = conn.execute(
            "SELECT id FROM activities WHERE start_date > ?",
            [cutoff.strftime("%Y-%m-%dT%H:%M:%SZ")],
        ).fetchall()

    in_scope = [r["id"] for r in rows]
    orphans = [i for i in in_scope if i not in seen]
    if not orphans:
        return {"removed": [], "blocked": False}

    # An empty answer covering rows we do hold is a failure that returned 200,
    # not an athlete who deleted the window. Never diff against nothing.
    if not seen:
        if verbose:
            print(f"  {len(orphans)} row(s) missing, but Strava returned no "
                  f"activities at all — leaving them alone.", flush=True)
        return {"removed": [], "blocked": True}

    total = conn.execute("SELECT COUNT(*) AS c FROM activities").fetchone()["c"]
    limit = max(1, int(total * MAX_PRUNE_FRACTION))
    if len(orphans) > limit:
        if verbose:
            print(f"  Refusing to remove {len(orphans)} row(s) — more than "
                  f"{int(MAX_PRUNE_FRACTION * 100)}% of the database. Check with:  "
                  f"./venv/bin/python -m app.cli prune --dry-run", flush=True)
        return {"removed": [], "blocked": True}

    gone = conn.execute(
        f"SELECT local_date, sport_type, name FROM activities "
        f"WHERE id IN ({', '.join('?' * len(orphans))}) ORDER BY local_date",
        orphans,
    ).fetchall()
    db.delete_activities(conn, orphans)
    if verbose:
        print(f"  {len(orphans)} row(s) no longer on Strava — removed:", flush=True)
        for r in gone:
            print(f"    {r['local_date']}  {r['sport_type']:<16}{r['name']}", flush=True)
    return {"removed": orphans, "blocked": False}


def _report_duplicates(dupes: list[dict]) -> None:
    """Name them on the way out. Nothing is deleted here — the fix belongs on
    Strava, where the duplicate also inflates their totals."""
    if not dupes:
        return
    km = round(sum(d["extra_distance"] for d in dupes), 2)
    hours = round(sum(d["extra_hours"] for d in dupes), 2)
    print(
        f"\n{len(dupes)} session(s) look like they are in Strava twice — "
        f"counting {km} km and {hours} h more than once:",
        flush=True,
    )
    for d in dupes:
        print(f"\n  {d['date']}  {d['sport_label']}")
        for a in d["activities"]:
            print(f"    {a['distance']:>7.2f} km  {a['minutes']:>3} min  "
                  f"{a['name']}\n             {a['url']}")
    print(
        "\nNothing was deleted. Delete the extra copy on Strava — that fixes its "
        "totals too — then:  ./venv/bin/python -m app.cli prune",
        flush=True,
    )


def find_orphans(verbose: bool = True) -> dict:
    """Rows we hold that Strava no longer returns, i.e. deleted upstream.

    Upserts never delete, so nothing else in the app notices a deletion. This
    walks the whole history once and diffs it against what is stored.
    """
    if not strava.is_authorised():
        raise strava.NotAuthorised(
            "No Strava tokens yet. Run:  ./venv/bin/python -m app.cli authorize"
        )

    db.init_db()
    if verbose:
        print("Walking the full history to see what Strava still holds…", flush=True)

    live: set[int] = set()
    pages = 0
    for batch in strava.iter_activities():
        live.update(a["id"] for a in batch)
        pages += 1
        if verbose:
            print(f"  page {pages}: {len(batch)} activities", flush=True)

    # No activities at all is a failure that happened to return 200, not an
    # athlete who deleted their entire history. Never diff against that.
    if not live:
        raise strava.StravaError(
            "Strava returned no activities at all — refusing to diff the "
            "database against an empty history."
        )

    with db.cursor() as conn:
        rows = conn.execute(
            "SELECT id, local_date, sport_group, sport_type, name, moving_time "
            "FROM activities ORDER BY local_date"
        ).fetchall()

    orphans = [dict(r) for r in rows if r["id"] not in live]
    limit = max(1, int(len(rows) * MAX_PRUNE_FRACTION))
    return {
        "live": len(live),
        "held": len(rows),
        "orphans": orphans,
        "limit": limit,
        "blocked": len(orphans) > limit,
    }


def delete_orphans(ids: list[int]) -> int:
    """Delete rows by id. Kept apart from the walk that found them, so the
    caller decides — nothing here deletes as a side effect of looking."""
    with db.cursor() as conn:
        return db.delete_activities(conn, ids)
