"""Command line: authorize, sync, prune, serve, status, reclassify."""

from __future__ import annotations

import argparse
import sys
import webbrowser

from . import db, duplicates, strava, sync
from .config import WEB_PORT, ConfigError


def cmd_authorize(args) -> int:
    """One-time OAuth. Opens a browser, catches the redirect locally."""
    url = strava.authorize_url()
    print("Opening Strava authorisation in your browser.")
    print("If nothing opens, paste this URL yourself:\n")
    print(f"  {url}\n")
    print("Make sure every permission stays ticked — 'View data about your private "
          "activities' in particular.\n")
    try:
        webbrowser.open(url)
    except Exception:
        pass

    print(f"Waiting for the redirect on {strava.REDIRECT_URI} …")
    code = strava.wait_for_code()
    strava.exchange_code(code)

    me = strava.athlete()
    print(f"\nConnected as {me.get('firstname', '')} {me.get('lastname', '')} "
          f"(athlete {me.get('id')}).")
    print("Tokens stored in data/tokens.json — they refresh themselves from now on.")
    print("\nNext:  ./venv/bin/python -m app.cli sync --full")
    return 0


def cmd_sync(args) -> int:
    sync.run_sync(full=args.full, prune=not args.no_prune)
    return 0


def cmd_prune(args) -> int:
    """Drop rows for activities that were deleted on Strava.

    Syncing upserts and never deletes, so a deletion upstream leaves a row
    behind here indefinitely. This is the one command that removes anything.
    """
    result = sync.find_orphans()
    orphans = result["orphans"]

    print(f"\nStrava returns {result['live']} activities · "
          f"the database holds {result['held']}.")

    if not orphans:
        print("Nothing to prune — every row here still exists on Strava.")
        return 0

    print(f"\n{len(orphans)} row(s) no longer on Strava:\n")
    for o in orphans:
        minutes = (o["moving_time"] or 0) // 60
        print(f"  {o['local_date']}  {o['sport_type']:<16}{minutes:>5} min  {o['name']}")

    if result["blocked"] and not args.force:
        share = int(sync.MAX_PRUNE_FRACTION * 100)
        print(f"\nRefusing to delete {len(orphans)} rows — that is more than {share}% "
              f"of the database ({result['limit']}). A number that large usually "
              f"means the walk of the API came back short, not that this much was "
              f"really deleted.")
        print("Check the list above, then re-run with --force if it is genuinely right.")
        return 1

    if args.dry_run:
        print("\nDry run — nothing deleted. Re-run without --dry-run to remove them.")
        return 0

    if not args.yes:
        try:
            answer = input(f"\nDelete {len(orphans)} row(s)? [y/N] ").strip().lower()
        except EOFError:  # non-interactive: say no rather than guess
            answer = ""
        if answer not in ("y", "yes"):
            print("Left alone.")
            return 0

    deleted = sync.delete_orphans([o["id"] for o in orphans])
    print(f"\nDeleted {deleted} row(s) — {result['held'] - deleted} activities remain.")
    return 0


def cmd_status(args) -> int:
    db.init_db()
    with db.cursor() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n, MIN(local_date) AS first, MAX(local_date) AS last "
            "FROM activities"
        ).fetchone()
        groups = conn.execute(
            "SELECT sport_group, COUNT(*) AS n, "
            "       ROUND(SUM(distance) / 1000.0, 1) AS km, "
            "       ROUND(SUM(moving_time) / 3600.0, 1) AS hours "
            "FROM activities GROUP BY sport_group ORDER BY n DESC"
        ).fetchall()
        last_sync = db.get_meta(conn, "last_sync", "never")

    print(f"Authorised : {'yes' if strava.is_authorised() else 'no'}")
    print(f"Last sync  : {last_sync}")
    print(f"Activities : {row['n']}")
    if row["n"]:
        print(f"Range      : {row['first']} → {row['last']}")
        print()
        print(f"{'sport':<10}{'count':>8}{'km':>12}{'hours':>10}")
        for g in groups:
            print(f"{g['sport_group']:<10}{g['n']:>8}{g['km'] or 0:>12}{g['hours'] or 0:>10}")

    dupes = duplicates.find()
    if dupes:
        km = round(sum(d["extra_distance"] for d in dupes), 2)
        print(f"\n! {len(dupes)} session(s) look like they are in Strava twice, "
              f"inflating the figures above by {km} km.")
        for d in dupes:
            print(f"    {d['date']}  {d['sport_label']:<9}"
                  f"{', '.join(str(a['id']) for a in d['activities'])}")
        print("  Delete the extra copy on Strava, then:  "
              "./venv/bin/python -m app.cli prune")
    return 0


def cmd_reclassify(args) -> int:
    """Re-apply the sport taxonomy after editing SPORT_GROUPS in config.py."""
    with db.cursor() as conn:
        n = db.reclassify_sports(conn)
    print(f"Reclassified {n} activities.")
    return 0


def cmd_serve(args) -> int:
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="app.cli", description="Strava stats")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("authorize", help="one-time Strava OAuth").set_defaults(func=cmd_authorize)

    p_sync = sub.add_parser("sync", help="fetch activities into SQLite")
    p_sync.add_argument("--full", action="store_true",
                        help="walk the entire history instead of just recent activity")
    p_sync.add_argument("--no-prune", action="store_true",
                        help="keep rows for activities deleted on Strava")
    p_sync.set_defaults(func=cmd_sync)

    p_prune = sub.add_parser("prune", help="remove rows for activities deleted on Strava")
    p_prune.add_argument("--dry-run", action="store_true",
                         help="list what would go, delete nothing")
    p_prune.add_argument("--yes", action="store_true",
                         help="skip the confirmation prompt")
    p_prune.add_argument("--force", action="store_true",
                         help="allow a prune larger than the safety limit")
    p_prune.set_defaults(func=cmd_prune)

    sub.add_parser("status", help="what is in the database").set_defaults(func=cmd_status)
    sub.add_parser("reclassify", help="re-apply the sport taxonomy").set_defaults(func=cmd_reclassify)

    p_serve = sub.add_parser("serve", help="run the web app")
    p_serve.add_argument("--host", default="127.0.0.1")
    p_serve.add_argument("--port", type=int, default=WEB_PORT)
    p_serve.add_argument("--reload", action="store_true")
    p_serve.set_defaults(func=cmd_serve)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (ConfigError, strava.StravaError) as exc:
        print(f"\nError: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
