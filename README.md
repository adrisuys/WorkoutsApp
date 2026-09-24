# Workouts

A small self-hosted PWA that pulls your Strava activities into SQLite and
charts what Strava doesn't: distance, time, climb and session counts per sport,
per week / month / year / lifetime, with year-on-year comparisons.

Runs on a Mac at home. No paid services, no cloud, no build step, no npm.

> **Setting this up for the first time?** Read **`TODO.md`** — the account
> setup and install, step by step. **`SETUP.md`** is the same process written
> as a runbook for a Claude Code session on the target machine.

```
Strava API ──hourly──▶ SQLite ──▶ FastAPI ──▶ PWA (installable on your phone)
                                              exposed over HTTPS by Tailscale
```

---

## 1. Set up (once)

### Create a Strava API application

1. Go to <https://www.strava.com/settings/api> and create an application.
2. Set **Authorization Callback Domain** to `localhost` — this is what lets the
   one-shot login below work.
3. Copy the **Client ID** and **Client Secret** into `config.json`:

```bash
cd ~/Desktop/TSC/private/strava
cp config.example.json config.json
$EDITOR config.json
```

### Install

```bash
/opt/homebrew/opt/python@3.12/bin/python3.12 -m venv venv
./venv/bin/pip install -r requirements.txt
```

### Connect and backfill

```bash
./venv/bin/python -m app.cli authorize     # opens a browser, one time only
./venv/bin/python -m app.cli sync --full   # pulls your entire history
./venv/bin/python -m app.cli status        # what landed
```

`authorize` needs the **View data about your private activities** permission —
without it, anything you marked private is invisible to the API. The command
refuses to continue if that box is unticked.

Tokens go in `data/tokens.json` (mode 600) and refresh themselves from then on.
`config.json`, `data/` and `logs/` are all gitignored.

### Run it

```bash
./venv/bin/python -m app.cli serve         # http://127.0.0.1:8720
```

---

## 2. Keep it running

```bash
./deploy/install.sh
```

That writes two launchd agents into `~/Library/LaunchAgents`:

| Job | What it does |
|---|---|
| `com.workouts.web` | runs the server, restarts it on crash and at login |
| `com.workouts.sync` | incremental sync every hour |

Logs land in `logs/`. Remove both with `./deploy/install.sh remove`.

Stop the Mac sleeping while it's plugged in:

```bash
sudo pmset -c sleep 0 disablesleep 0
```

(The display can still sleep — that costs nothing.)

---

## 3. Reach it from your phone

Your home IP is dynamic and possibly behind CGNAT, and a PWA needs **HTTPS** to
be installable. [Tailscale](https://tailscale.com/download) solves both on its
free tier, without port forwarding or dynamic DNS.

```bash
# on the Mac, after installing Tailscale and signing in
tailscale serve --bg 8720
tailscale serve status          # prints your https://<machine>.<tailnet>.ts.net URL
```

Install Tailscale on your phone, sign in with the same account, open that URL,
and **Share → Add to Home Screen**. It gets an icon, opens full-screen, and
caches the last view so it still shows your numbers when the Mac is off.

The app is only reachable by your own devices — the tailnet *is* the
authentication, which is why there is no login screen. If you ever run
`tailscale funnel` to put it on the public internet, add authentication first.

---

## 4. Using it

One filter row scopes everything below it:

- **Period** — 12 weeks, 6 months, 12 months, this year, 3 years, all time.
  Each preset also picks a sensible grain, which you can then override.
- **Grouped by** — week / month / year buckets.
- **Measure** — distance, time, climb, sessions.
- **Sports** — toggle any sport in or out.

The switch in the header picks the view: **Goals**, **This week**, **Training**,
**Workouts**, **Races**, as five icons — a target, a calendar, bars, a list and a
trophy. Targets, the week in progress, long-term volume, the session log and race
results answer different questions and don't share a filter model, so they are
separate views rather than more cards on one page. **Goals** and **Races** each
appear only once their file has something in it. Hovering an icon names it, and
the name is what a screen reader reads out. The two buttons on the right — sync
and light/dark — are icons on the same terms.

In **Goals**:

- **This week** / **This month** — one row per target: how much you've done
  against how much you meant to, as a bar. Part-way through a period the note
  underneath compares you with *pace* rather than with the whole target, because
  3 km of a 7 km week by Wednesday is on schedule, not 43% of a failure. The
  hairline on the bar is where an evenly-spread period would have you by now.
  Only a period that is actually over can be described as missed.
- **Past weeks** / **Past months** — the last twelve completed periods for each
  target, one small chart apiece, with the target as a dashed rule. `4 of 12 hit`
  above each. Bars are the sport's colour; the rule is red — see § Colour for
  why it is cased rather than plain.
- Session counts have no pace: one strength session a week is either done or
  not, and `0.43 sessions behind pace` is noise dressed as precision.
- An **`all`** goal measures every sport at once. Its bar is segmented by sport
  and its history chart is stacked by sport, in the same colours the rows
  beneath it use, so it needs no colour of its own — see § Colour.

Then, in **Training**:

- **Stat tiles** — period totals, each against the immediately preceding period
  of the same length.
- **Peak &lt;measure&gt;** — the biggest single day, week, month and year inside the
  period, for the chosen measure, summed across the selected sports. Grains too
  long for the period are left out, and a winning bucket the period only half
  covers says so rather than being compared against whole ones.
- **Typical &lt;measure&gt;** — the mean day, week, month and year, counted over whole
  periods only, for the same reason as above. **Two averages, on purpose.** The
  big number divides by *every* period in the window, so quiet ones count as
  zero — a fortnight off is part of your typical week rather than an exception
  to it. Underneath, the count of periods you actually trained in and the same
  total divided by *those*. "A typical week" and "a typical week I trained" are
  different questions, and the distance between the two answers is the part
  worth seeing: over all time the mean day is 3.3 km but the mean *active* day
  is 5.7 km, which tells you the rest days are doing the work. The second figure
  is dropped when every period was active, since it would just repeat the first.
  Folded away by default — click the head to open it.
- **Over time** — stacked columns, one colour per sport.
- **By sport** — the same data as small multiples, each sport on its own scale,
  so a 3 km swim week is still readable next to a 300 km cycling week. Foldable;
  open or shut, it stays that way next time.
- **Year on year** — cumulative totals since 1 January, one line per year. This
  is the "am I ahead of last year?" view. It deliberately ignores the period
  filter, because it always compares whole calendar years.
- **Numbers** — every figure as a table, including a per-period breakdown.

In **This week** — one Monday-to-Sunday week at a time:

- **Week** — back and forward a week at a time. The label reads *This week*,
  *Last week*, then the dates. Forward stops at the week you're in, and back
  stops once there's nothing older on file.
- **Sports** — only the sports that week contains, because a chip for a sport
  you didn't do is a control with nothing behind it. Unticking one takes it out
  of *both* sides of the comparison, so a swim-only week is measured against
  last week's swimming rather than against everything you did. What you untick
  is remembered as you step between weeks; a sport you've never had an opinion
  about arrives counted.
- **Stat tiles** — distance, time, sessions and climb, each against the *same
  stretch* of the week before rather than all of it. Comparing a Tuesday against
  a whole week reads as a slump every time, which is worse than useless. A week
  that is over is compared with the whole of the one before it.
- **Monday to Sunday** — one column per day, stacked by sport, in whichever
  measure you pick. In the current week the days still to come are drawn empty
  rather than left off, because how much of the week is left is part of the
  answer, and today's label is the bold one.
- **By sport** — sessions, distance, time and climb per sport, and how many days
  had anything in them.

There's no period preset: the period is always one week.

In **Workouts** — every session as a plain list, for when you want to find one
rather than count them:

- **Search** — one box over sport and date, accent- and case-insensitive:
  `swim`, `weight training`, `2025-09`. It matches what the row displays, so a
  hit always visibly contains what you typed.
- **Period and sports** — its own filters, independent of the Training tab.
- **Sortable columns** — date, distance, time or climb; click again to flip.
  The totals above the table cover the whole match, not just the page shown.
- **Naming** — Strava's own titles are ignored (a thousand rows of "Randonnée
  le matin" tells you nothing). A workout is called what it is: grouped sports
  take the group's name, so a Walk reads as a Hike, and anything that fell into
  Other keeps its real type.
- 50 rows at a time, each linking to the activity on Strava.

And in **Races** (from `pb.csv`, see below):

- **Personal bests** — best time per event, grouped by pool length, with pace
  per 100 m and how much you've taken off since your first attempt.
- **Progression** — events raced more than once, one small chart each. Lower is
  faster; the ringed mark is the best.
- **Every race** — the full log, each swim against your best in that same event.

Everything is keyboard reachable: focus a chart and use ←/→ to walk the
periods, Home/End to jump, Escape to dismiss.

---

## 5. Changing things

### Sport grouping

`app/config.py` → `SPORT_GROUPS`. Strava's ~50 `sport_type` values roll up into
Run / Ride / Swim / Hike / Strength, and anything unrecognised falls into
**Other**. Walks count as hiking; trail and treadmill runs count as running;
gravel, MTB and e-bike rides count as cycling; weight training, workouts and
Crossfit count as strength. Move a sport between groups and re-apply it to
what's already stored:

```bash
./venv/bin/python -m app.cli reclassify
launchctl kickstart -k "gui/$(id -u)/com.workouts.web"
```

Both steps, not just the first. `reclassify` fixes the database, but the launchd
web server read `SPORT_GROUPS` at import time and can be weeks old — and
`stats.py` only surfaces groups it finds in `GROUP_ORDER`, so until it restarts
the migrated rows exist and are invisible. If you also touched `app.js`,
`charts.js` or `styles.css`, bump `VERSION` in `static/sw.js`: they are
precached in the service worker shell, so a reload alone will keep serving the
old bundle.

And don't make a rendered element depend *only* on a new CSS rule. The shell can
serve you a stale stylesheet, and something that gets its colour or its size
from nothing else then renders as a blank track or a 0×0 box. Set it inline as
well — see `stackGradient` in `app.js`, which paints the progress bar even if
`.meter-seg` never arrives.

### Colour

The four sport hues are not arbitrary. They were picked as a *set* and checked
for colour-vision deficiency separation, lightness band, chroma and contrast
against both the light and the dark surface — including every pair, not just
neighbours, because small multiples put any two side by side.

| Sport | Light | Dark | |
|---|---|---|---|
| Swim | `#2a78d6` | `#3987e5` | hue |
| Ride | `#eda100` | `#c98500` | hue |
| Run | `#e87ba4` | `#d55181` | hue |
| Hike | `#008300` | `#008300` | hue |
| Strength | `#3d3b36` | `#b8b6ae` | achromatic |
| Other | `#898781` | `#898781` | achromatic, muted |

Four *hues* is the practical ceiling: no set of five or six from the source
palette clears the all-pairs gate in both modes — violet and magenta collide
with Swim and Run under protanopia and deuteranopia, teal collides with Swim
under tritanopia. So **Strength** separates on lightness instead of hue:
graphite on light, silver on dark. Achromatic values cannot collide with a hue
under any deficiency, which is why it can be added without spending the fifth
slot. It is deliberately *not* `--text-muted`; sharing that token is what made
the old grey read as chrome rather than data.

**Other** is the genuine unclassified tail and stays muted, because that is
what it now means. If you promote it to something people actually train at,
give it a name and a colour of its own rather than letting a real sport wear
the leftover slot.

If you add a fifth chromatic group, re-validate rather than eyeballing it.

Years use a single-hue blue ramp (ordinal — years are ordered, so hue would
misstate them), newest always the strongest step.

An **`all` goal wears no colour at all.** It would otherwise need a third
achromatic data value, and on the light surface both existing ones are already
dark — Strength is graphite, Other is mid-grey — so a third would land right on
top of them at 10 px. Instead it is drawn as what it actually is: its sports,
stacked, in their own validated colours. Its segments are parted by a black hairline
(`--meter-divider`) so two colours never touch — cheap where the pair is
obvious, and the thing that saves it where the pair isn't. Its key is a
miniature of that stack (equal bands, since the real proportions change every
week, and undivided — a hairline would eat a third of a band at 10 px), which is
also why the history facets carry no legend row — one would push that facet's plot out of
line with the ones beside it, and the sports are already named and coloured in
the card above. If you add another composite goal, do the same rather than
spending a colour on it.

**The goal rule** (`--target-rule`, red) is the one deliberate exception to
"chrome is achromatic, hue belongs to the data". It earns it by being a line you
are explicitly asked to compare bars *against*, so it has to be findable at a
glance rather than merely present. Red over green is the classic protanopia and
deuteranopia confusion pair, and this rule crosses the hiking bars — so it is
drawn **cased**: the same dashes go down first in `--surface-1`, a little
thicker, giving every dash a halo. That makes it separate on *lightness* as well
as hue, so it stays legible as a line whether or not the red reads as red, and
over any bar colour rather than only the pale ones. A plain red hairline would
have failed exactly where it matters most. If you add another chromatic rule,
case it the same way.

### Swim races (`pb.csv`)

Race results are hand-maintained in `pb.csv` at the root of this folder, and
shown in the **Races** view. They are deliberately *not* in the database: the
file is read fresh on every request, so editing it and reloading the page is the
whole workflow — no import, no sync, no restart.

```csv
Date,Distance,Nage,Bassin,Temps
21/09/2025,100,breast,SCM,1:31:51
26/09/2025,3800,free,OW,1:08:55:80
```

| Column | Meaning |
|---|---|
| `Date` | `DD/MM/YYYY` (`YYYY-MM-DD` also accepted) |
| `Distance` | metres, a whole number |
| `Nage` | `free`, `back`, `breast`, `fly`, `IM` — full names and French (`brasse`, `papillon`, `dos`, `4 nages`) work too |
| `Bassin` | `SCM` (25 m), `LCM` (50 m), `OW` (open water); `25`, `50`, `open water` also work |
| `Temps` | **the last colon-separated group is hundredths** |

Times follow the swimming convention: `1:31:51` is 1 min 31.51 s, and
`1:08:55:80` is 1 h 08 min 55.80 s. A decimal point works too (`1:31.51`),
as does a bare `40.73` for a sub-minute swim.

An **event** is one distance + stroke + pool. Pool length is part of the key on
purpose — a 25 m pool is faster than a 50 m pool over the same distance, so the
app never compares the two or merges their bests.

A row that can't be parsed is **skipped and reported in a banner at the top of
the Races view**, rather than breaking the page. Since the file is edited by
hand, reload after an edit and glance at the top: if there's no banner, every
row was read.

### Goals (`goals.json`)

Training targets are hand-maintained in `goals.json` at the root of this folder,
on exactly the same terms as `pb.csv`: read fresh on every request, so editing it
and reloading the page is the whole workflow. Delete the file and the **Goals**
view disappears.

```json
[
  { "sport": "all",      "period": "week",  "metric": "time",     "target": 8 },
  { "sport": "swim",     "period": "week",  "metric": "distance", "target": 7 },
  { "sport": "hike",     "period": "week",  "metric": "distance", "target": 23 },
  { "sport": "strength", "period": "week",  "metric": "count",    "target": 1 },

  { "sport": "swim",     "period": "month", "metric": "distance", "target": 30 },
  { "sport": "hike",     "period": "month", "metric": "distance", "target": 100 }
]
```

| Field | Meaning |
|---|---|
| `sport` | one of the groups in `SPORT_GROUPS` — `run`, `ride`, `swim`, `hike`, `strength`, `other` — or `all` for your whole programme |
| `period` | `week` (Monday–Sunday) or `month` (calendar) |
| `metric` | `distance`, `time`, `elevation` or `count` |
| `target` | the amount in one such period: km, hours, metres, or sessions |

Weekly and monthly targets are **independent**, not derived from each other. If
you want them to agree, do the arithmetic yourself: a month averages 4.35 weeks,
so 100 km a month is 23 km a week, and 30 km a month is 7 km a week.

History covers *completed* periods only, and stops at your first activity — so a
new database shows a short history rather than a run of zeros that would read as
missed goals. A streak counts back from now, and the period in progress joins it
only once it has actually been hit, so a fresh Monday never looks like it broke
a run you're still extending.

A malformed entry is **skipped and reported in a banner at the top of the Goals
view**, naming its position in the file, rather than breaking the page.

### New statistics

Every activity's full Strava payload is kept in `activities.raw` as JSON. When
you want a statistic you didn't think of today, query SQLite — you do not need
to re-crawl Strava:

```bash
sqlite3 data/strava.db \
  "SELECT sport_group, ROUND(AVG(average_heartrate)) FROM activities
   WHERE local_date >= '2026-01-01' GROUP BY sport_group"
```

Add the aggregate to `app/stats.py`, expose it in `app/main.py`, chart it in
`static/app.js`.

> After editing anything in `static/`, the first page load still shows the old
> version — the service worker serves its cache, then fetches the update in the
> background, so a second reload picks it up. To skip that, bump `VERSION` in
> `static/sw.js`.

---

## API

| Endpoint | Returns |
|---|---|
| `GET /api/overview` | date range, per-sport counts, last sync, auth state, suspected double uploads |
| `GET /api/series?metric&bucket&start&end&sports` | dense time series per sport |
| `GET /api/totals?start&end&sports` | period totals + preceding period |
| `GET /api/records?metric&start&end&sports` | biggest day / week / month / year |
| `GET /api/averages?metric&start&end&sports` | mean day / week / month / year |
| `GET /api/week?offset=` | one Monday-to-Sunday week, per day and per sport, all four measures at once. `offset` counts weeks back; 0 is this week and the future is refused |
| `GET /api/activities?q&sports&start&end&sort&direction&limit&offset` | the workout log, searchable |
| `GET /api/cumulative?metric&group&years` | running total by day of year |
| `GET /api/goals` | targets: progress this week and month, plus the last twelve completed periods |
| `GET /api/races` | swim races: bests per event, progression, full log |
| `POST /api/sync?full=` | trigger a sync |
| `GET /api/docs` | OpenAPI browser |

---

## Layout

```
app/            config, db, strava client, sync, stats, races, goals, duplicates, FastAPI app, CLI
static/         the PWA — index.html, styles.css, charts.js, app.js, sw.js
scripts/        icon generator (stdlib only)
deploy/         launchd installer
pb.csv          hand-maintained swim race results
goals.json      hand-maintained training targets
data/           SQLite database + OAuth tokens   (gitignored)
```

`static/charts.js` is a small hand-written SVG chart library — about 400 lines,
no dependencies, so nothing here rots when a charting library ships a major
version.

---

## Notes

- **Rate limits.** Strava allows 200 requests per 15 minutes. A full backfill of
  a decade is roughly 10 requests; an hourly delta is 1. The client backs off
  automatically on 429.
- **Late edits.** Each incremental sync re-reads the last 10 days, so activities
  uploaded or corrected after the fact are picked up. `sync --full` re-reads
  everything.
- **Backdated activities.** A *backdated* upload — a session added today but
  dated months ago — falls outside that 10-day window, so the hourly job will
  never see it. The sync button in the header — two circled arrows, which turn
  while it works — therefore triggers a full re-read
  (`POST /api/sync?full=true`), which is ~8 API calls against a limit of 200 per
  15 minutes. The hourly job stays incremental at 1 call.
- **Double uploads.** Apple Health, a watch app and Strava's own recorder can
  each push the same session. Strava keeps them as separate activities with
  separate ids, this app upserts by id, and every total then counts that session
  twice. Each sync checks for them and a banner names them at the top of the
  app, with a link to each copy on Strava.

  Two rows are called one session when they are the **same sport group, start
  within two minutes, and last within 20% (or 60 s) of each other**. The start
  time does most of the work: a re-upload keeps it, and both real cases so far
  matched to within a *second*. The duration check is loose on purpose — the
  recorders trim pauses differently, so one observed pair differed by 66 s — and
  is only there to stop a warm-up logged alongside a long ride from being called
  the same thing.

  **They are reported, never deleted.** Strava is the source of truth: a row
  dropped on import would return on the next `sync --full` and the app would
  disagree with Strava indefinitely, and a false positive would silently lose a
  real session. So delete the extra copy on Strava — which fixes its own totals
  too — and the next sync clears it from here by itself. Nothing is stored: the
  check re-runs on each call, so it can't go stale after a sync or a reclassify.

- **Deleted activities.** Every sync removes what Strava no longer has —
  **within the window it actually looked at**. Asking for everything after a
  cutoff makes Strava's answer complete for that window, so a row we hold inside
  it that didn't come back has been deleted upstream. Outside the window nothing
  was asked and nothing is touched. In practice the hourly job tidies the last
  ten days at no extra API cost, and `sync --full` tidies the lot.

  A deletion you make on Strava today is therefore picked up on its own. One you
  made a year ago needs a `sync --full` to be noticed, because no incremental
  run ever looks that far back. `--no-prune` keeps the old add-only behaviour.

  Two guards stop a bad answer from emptying the database, both in
  `_prune_seen_window`:

  | guard | what it catches |
  |---|---|
  | nothing returned at all | a failure that happened to come back `200` — never diffed against |
  | more than 10% of rows missing | a truncated walk (`MAX_PRUNE_FRACTION` in `app/sync.py`) |

  Neither can fire mid-walk: the diff only runs once every page has been read,
  so an exception part-way through leaves the database alone.

  `prune` is still there for a full audit on demand, and is the only way to
  delete more than the guard allows:

  ```bash
  ./venv/bin/python -m app.cli prune --dry-run   # list what Strava no longer has
  ./venv/bin/python -m app.cli prune             # same, then delete on confirmation
  ./venv/bin/python -m app.cli prune --force     # override the 10% guard
  ```
- **Strava's terms** restrict showing *other people's* data to third parties.
  A private app showing you your own activities is what the API is for.
