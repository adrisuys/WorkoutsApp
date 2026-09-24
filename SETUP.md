# Runbook — installing this on the home Mac

**This file is written for a Claude Code session running on the target machine.**
If you are that session: read the whole file first, then work through the steps
in order. Each step states what to run, what success looks like, and what to do
when it doesn't. Stop and ask the human at every point marked **ASK**.

If you are a human reading this: you probably want `TODO.md` instead, which is
the same process written for a person.

---

## What you are installing

A self-hosted PWA that pulls Strava activities into SQLite and charts them.
Python 3.12 + FastAPI + SQLite on the backend, static HTML/JS on the front.
No Docker, no Node, no paid services.

End state:

- the app runs on `127.0.0.1:8720`, restarted by launchd on crash and at login
- an hourly launchd job syncs new activities from Strava
- Tailscale publishes it over HTTPS to the user's own devices only
- the user has installed it to their phone's home screen

---

## Rules for you, the agent

1. **Never perform the Strava login yourself.** Step 4 opens a browser for an
   OAuth consent screen. The human clicks Authorize. You run the command and
   wait; you do not type into Strava's login form.
2. **Never type the Strava client secret from memory or invent one.** Ask the
   human to paste it, then write it to `config.json`.
3. **Do not run `sudo` commands yourself.** Steps 7 and 8 need sudo. Print the
   command and ask the human to run it in their own terminal (in Claude Code
   they can prefix it with `!`).
4. **Do not install Tailscale for the user or sign them in.** Ask them to do it
   through the app; you may run `tailscale serve` afterwards.
5. If a step fails twice in a row, stop and report — don't improvise around it.

---

## Step 0 — Where you are

Confirm the app folder is present and intact:

```bash
ls -1
```

Expect: `README.md  SETUP.md  TODO.md  app/  config.example.json  deploy/
pb.csv  requirements.txt  scripts/  static/`

`pb.csv` holds hand-maintained swim race results and is **real data, not a
sample** — it is the only file here the human edits directly, and there is no
other copy of it once this becomes the live machine. Never overwrite or
regenerate it.

There should be **no** `venv/`, `data/` or `config.json` yet — those are created
here, on this machine. If `venv/` exists it was copied from another Mac and is
broken (virtualenvs hardcode absolute paths): delete it with `rm -rf venv`.

---

## Step 1 — Python

Needs **Python 3.11 or newer** (3.12 recommended). macOS ships 3.9, which is
too old — `X | None` type syntax and `zip()` usage in this codebase need 3.10+.

```bash
python3 --version
ls /opt/homebrew/opt/python@3.12/bin/python3.12 2>/dev/null || echo "no brew python 3.12"
```

If there is no Homebrew Python 3.12:

```bash
# only if Homebrew itself is missing:
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

brew install python@3.12
```

**ASK** before installing Homebrew — it is a large, system-wide install and the
human may prefer python.org or an existing pyenv. Any interpreter ≥ 3.11 works;
just use its path in the next step.

---

## Step 2 — Virtual environment

```bash
/opt/homebrew/opt/python@3.12/bin/python3.12 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt
```

Verify:

```bash
./venv/bin/python -c "import fastapi, uvicorn, httpx; print('deps ok')"
```

Expect `deps ok`. Three packages plus their transitive dependencies; nothing
else is needed.

---

## Step 3 — Strava credentials

The human must have created a Strava API application first (see `TODO.md` § 1).
It gives them a **Client ID** (a number) and a **Client Secret** (a 40-character
hex string).

**ASK** the human for both values. Then:

```bash
cp config.example.json config.json
```

Edit `config.json` so it reads:

```json
{
  "client_id": "12345",
  "client_secret": "the40charhexstringtheygaveyou"
}
```

Then lock it down — it holds a secret:

```bash
chmod 600 config.json
```

Sanity-check the shape without printing the secret:

```bash
./venv/bin/python -c "from app.config import load_config; c=load_config(); print('client_id', c['client_id'], '· secret length', len(c['client_secret']))"
```

Expect a numeric client_id and a secret length of about 40. If it raises
`ConfigError`, the file is missing or a field is blank.

**Critical:** the Strava application's *Authorization Callback Domain* must be
exactly `localhost`. If it is anything else, Step 4 fails with a redirect error.
The human sets this at <https://www.strava.com/settings/api>.

---

## Step 4 — Connect the Strava account

```bash
./venv/bin/python -m app.cli authorize
```

This opens a browser and waits on `http://localhost:8721/callback`.

**ASK the human to complete it.** Tell them explicitly: *leave every permission
ticked, especially "View data about your private activities"* — without it the
API hides anything they marked private, and the command will refuse to finish.

Success looks like:

```
Connected as <First> <Last> (athlete 12345678).
Tokens stored in data/tokens.json — they refresh themselves from now on.
```

If it hangs with no browser: give them the URL the command printed and ask them
to open it manually.

If it errors with a redirect/callback mismatch: the callback domain is wrong.
Back to Step 3.

---

## Step 5 — Backfill the history

```bash
./venv/bin/python -m app.cli sync --full
```

A decade of activities is roughly 10 API calls and finishes in seconds. Strava's
limit is 200 requests per 15 minutes; the client backs off automatically on 429.

Then:

```bash
./venv/bin/python -m app.cli status
```

Expect a per-sport table with counts, km and hours. **Show this to the human and
ask them whether the numbers look right** — they are the only one who can tell.

If a sport is in the wrong bucket, edit `SPORT_GROUPS` in `app/config.py` and
run `./venv/bin/python -m app.cli reclassify`. (Walks are deliberately grouped
with hikes.)

---

## Step 6 — Run it once by hand

```bash
./venv/bin/python -m app.cli serve
```

In another shell:

```bash
curl -s localhost:8720/healthz
curl -s "localhost:8720/api/overview" | head -c 400
```

Expect `{"ok":true}` and a JSON blob with `activity_count` matching Step 5.

Then open <http://localhost:8720> in a browser and confirm the charts render.

Check the race data too — it comes from `pb.csv`, not from Strava, so it works
even before the sync:

```bash
curl -s localhost:8720/api/races | ./venv/bin/python -c "import json,sys; d=json.load(sys.stdin); print('races', d['count'], '| events', d['totals']['events'], '| problems', d['problems'])"
```

Expect a race count and **an empty `problems` list**. If `problems` is not
empty, a row in `pb.csv` is malformed — report the messages to the human
verbatim and let them decide; do not edit their race data to make the warning
go away. Switch to the **Races** tab in the browser and confirm the personal
bests table looks right.

Stop the server with Ctrl-C when satisfied.

---

## Step 7 — Make it always-on

Check what would be installed before installing it. `dry-run` writes the two
plists to `logs/dry-run/` and validates them, without touching launchd:

```bash
./deploy/install.sh dry-run
cat logs/dry-run/com.workouts.web.plist
```

Confirm the paths in `ProgramArguments` and `WorkingDirectory` point at this
folder's venv. Then install for real:

```bash
./deploy/install.sh
```

This writes two launchd agents to `~/Library/LaunchAgents` and starts them:
`com.workouts.web` (server, `KeepAlive`) and `com.workouts.sync` (hourly).

Verify:

```bash
launchctl list | grep workouts
sleep 3 && curl -s localhost:8720/healthz
tail -20 logs/com.workouts.web.log
```

Expect both labels listed with exit status `0`, and `{"ok":true}`.

Then the power settings — **these need sudo, so ask the human to run them**:

```bash
sudo pmset -a disablesleep 1     # never sleep, even with the lid shut
sudo pmset -a autorestart 1      # come back up after a power cut
```

**ASK** first, and explain the tradeoff: `disablesleep 1` means the machine
never sleeps at all. That is the point for an always-on server, but it is a
real change to how the laptop behaves. To undo: `sudo pmset -a disablesleep 0`.

**Also flag to the human:** launchd *agents* only run while their user is
logged in. For the app to come back after an unattended reboot they need
automatic login enabled (System Settings → Users & Groups → Automatic login),
**and** FileVault turned off — FileVault forces a password at boot before any
login happens. If they want FileVault on, the app simply won't restart on its
own after a reboot; someone has to log in. That is their call, not yours.

---

## Step 8 — Publish it over HTTPS with Tailscale

**ASK** the human to install Tailscale on this Mac from
<https://tailscale.com/download> and sign in with the same account as their
phone. You do not do this part — it involves their account credentials.

Once they confirm they are signed in:

```bash
tailscale status
tailscale serve --bg 8720
tailscale serve status
```

`tailscale serve status` prints the public-within-the-tailnet URL, of the form
`https://<machine-name>.<tailnet>.ts.net/`. Give that URL to the human.

If `tailscale` is not on PATH, it lives inside the app bundle:

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale status
```

Suggest an alias if so:

```bash
echo 'alias tailscale="/Applications/Tailscale.app/Contents/MacOS/Tailscale"' >> ~/.zshrc
```

**Do not run `tailscale funnel`.** That would expose the app to the whole
internet, and it has no authentication of its own — the tailnet *is* the
authentication. If the human asks for funnel, tell them auth must come first.

---

## Final verification

Run through all of these and report the results:

```bash
launchctl list | grep workouts                    # two jobs, status 0
curl -s localhost:8720/healthz                    # {"ok":true}
./venv/bin/python -m app.cli status               # activities + last sync time
curl -s localhost:8720/api/races | head -c 120    # races present, no problems
tailscale serve status                            # the https URL
ls -l config.json data/tokens.json                # both mode 600
```

Then ask the human to confirm, from their phone on cellular data (not wifi —
that proves it is really going over Tailscale):

1. the Tailscale URL opens and shows their charts
2. Share → Add to Home Screen gives an app icon that opens full-screen
3. the numbers match what Strava shows them

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ConfigError: Missing Strava credentials` | no `config.json`, or a blank field | redo Step 3 |
| authorize hangs forever | browser never opened | paste the printed URL manually |
| `redirect_uri` / callback error | callback domain isn't `localhost` | fix it at strava.com/settings/api |
| `NotAuthorised` on sync | refresh token revoked | re-run `app.cli authorize` |
| `activity:read_all was not granted` | a permission box was unticked | re-run authorize, tick everything |
| Charts empty, `status` shows 0 | backfill never ran | `app.cli sync --full` |
| Port 8720 in use | something else has it | `STRAVA_PORT=8730 ./deploy/install.sh` |
| launchd job flapping | check `logs/com.workouts.web.log` | usually a broken venv — redo Step 2 |
| Works on the Mac, not from the phone | Tailscale down or wrong account | `tailscale status` on both |
| App won't start after reboot | agents need a logged-in user | see the auto-login note in Step 7 |
| Sync stops after a while | Strava tokens revoked from the account page | re-run authorize |
| Races tab missing | `pb.csv` absent or has no readable rows | check the file is present next to `README.md` |
| Banner about unreadable rows | a typo in `pb.csv` | show the human the messages; see README § Swim races for the format |

---

## Design constraints worth not breaking

- `vendor/`-style rule for colours: the four sport hues were validated as a set
  for colour-vision deficiency and contrast in both themes. **Five or six
  chromatic sports do not pass.** A fifth group therefore has to be achromatic
  and separate on lightness — that is what "Strength" (graphite / silver) does.
  Don't add a fifth *hue* without re-validating, and keep sport colours off
  `--text-muted`, or they read as chrome instead of data.
- `activities.raw` holds each activity's full Strava JSON on purpose. New
  statistics are SQL queries against it, never a re-crawl of the API.
- `static/charts.js` is hand-written SVG with zero dependencies, deliberately.
  Don't swap in a charting library; it would be the only thing here that rots.
