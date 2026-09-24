"""Paths, credentials and the sport taxonomy.

Everything the rest of the app needs to know about *where things live* and
*how Strava's ~50 sport types collapse into the handful of groups we chart*.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
STATIC_DIR = ROOT / "static"
DB_PATH = Path(os.environ.get("STRAVA_DB", DATA_DIR / "strava.db"))
TOKENS_PATH = DATA_DIR / "tokens.json"
CONFIG_PATH = ROOT / "config.json"

# Hand-maintained swim race results. Read fresh on every request, so editing
# the file is all it takes — no import step, no sync, no restart.
RACES_PATH = Path(os.environ.get("STRAVA_RACES_CSV", ROOT / "pb.csv"))

# Hand-maintained training targets, on the same terms as RACES_PATH: edit the
# file, reload the page. Absent is a valid state — the Goals view disappears.
GOALS_PATH = Path(os.environ.get("STRAVA_GOALS", ROOT / "goals.json"))

WEB_PORT = int(os.environ.get("STRAVA_PORT", "8720"))
OAUTH_PORT = int(os.environ.get("STRAVA_OAUTH_PORT", "8721"))

# `activity:read_all` is required to see activities you marked as private.
SCOPES = "read,activity:read_all"


class ConfigError(RuntimeError):
    pass


def load_config() -> dict:
    """Read client_id / client_secret from config.json (env vars win)."""
    cfg = {}
    if CONFIG_PATH.exists():
        cfg = json.loads(CONFIG_PATH.read_text())
    cfg["client_id"] = os.environ.get("STRAVA_CLIENT_ID", cfg.get("client_id", ""))
    cfg["client_secret"] = os.environ.get("STRAVA_CLIENT_SECRET", cfg.get("client_secret", ""))
    if not cfg["client_id"] or not cfg["client_secret"]:
        raise ConfigError(
            f"Missing Strava credentials.\n"
            f"Copy config.example.json to {CONFIG_PATH} and fill in client_id / client_secret\n"
            f"from https://www.strava.com/settings/api"
        )
    return cfg


# --------------------------------------------------------------------------
# Sport taxonomy
# --------------------------------------------------------------------------
# Strava reports a fine-grained `sport_type` (Run, TrailRun, VirtualRun, ...).
# We roll those up into the groups worth charting. The *order* here is the
# stacking order and the legend order, and it is deliberately fixed: a group
# always keeps its colour even when other groups are filtered out.
#
# Colours live in static/styles.css under --sport-<slug>. The four chromatic
# groups were validated as a set for colour-vision deficiency and contrast in
# both light and dark mode (see README § Colour). Moving a sport between
# groups is safe; ADDING a fifth chromatic group is not — no five-hue set
# clears the all-pairs gate, so a new group must be achromatic. "Strength"
# is exactly that: it earns a slot because it is a real, frequent sport, and
# it wears graphite rather than a hue. "Other" remains the genuine tail —
# unclassified sport types — and stays muted on purpose.
#
# After editing this list, run `python -m app.cli reclassify` to recompute
# sport_group for rows already in the database.

SPORT_GROUPS: list[tuple[str, str, tuple[str, ...]]] = [
    ("run", "Run", ("Run", "TrailRun", "VirtualRun")),
    (
        "ride",
        "Ride",
        (
            "Ride", "MountainBikeRide", "GravelRide", "VirtualRide",
            "EBikeRide", "EMountainBikeRide", "Handcycle", "Velomobile",
        ),
    ),
    ("swim", "Swim", ("Swim",)),
    # Walks count as hiking here — same activity, different shoes.
    ("hike", "Hike", ("Hike", "Walk", "Snowshoe")),
    # No distance and no pace, but frequent enough to deserve its own name
    # instead of hiding in the tail. Achromatic, so it costs no hue.
    ("strength", "Strength", ("WeightTraining", "Workout", "Crossfit")),
]

OTHER_GROUP = ("other", "Other")

GROUP_ORDER: list[str] = [slug for slug, _, _ in SPORT_GROUPS] + [OTHER_GROUP[0]]
GROUP_LABELS: dict[str, str] = {slug: label for slug, label, _ in SPORT_GROUPS}
GROUP_LABELS[OTHER_GROUP[0]] = OTHER_GROUP[1]

_SPORT_TO_GROUP: dict[str, str] = {
    sport: slug for slug, _, sports in SPORT_GROUPS for sport in sports
}


def sport_group(sport_type: str | None) -> str:
    """Map a Strava sport_type onto one of our groups."""
    return _SPORT_TO_GROUP.get(sport_type or "", OTHER_GROUP[0])
