# What's left to do

The app itself is finished and tested. What remains is account setup and
getting it running on the always-on Mac. Roughly 30–40 minutes, most of it
waiting.

You can do all of this yourself with the steps below, or hand it to a Claude
Code session on the other Mac and point it at `SETUP.md` — that file is the
same process written as a runbook for an agent, including the bits it must ask
you to do rather than doing itself.

```
[ ] 1. Create a Strava API application
[ ] 2. Copy the app folder to the home Mac
[ ] 3. Install Python + dependencies
[ ] 4. Connect your Strava account and backfill
[ ] 5. Make it start on its own and stay on
[ ] 6. Put it on Tailscale
[ ] 7. Install it on your phone
[ ] 8. Check it works from outside the house
```

---

## 1. Create a Strava API application

Do this once, from any computer. It's free and takes two minutes.

1. Go to <https://www.strava.com/settings/api>
2. If asked to "create an application", fill in:

   | Field | What to put |
   |---|---|
   | Application Name | `Workouts` (anything) |
   | Category | `Data Importer` |
   | Club | leave blank |
   | Website | `http://localhost` |
   | Application Description | anything |
   | **Authorization Callback Domain** | **`localhost`** ← this one matters |

3. Upload any small image if it insists on an icon.
4. You now have a page showing **Client ID** (a number) and **Client Secret**
   (a long hex string, behind a "Show" link).

**Keep that page open, or copy both values somewhere safe.** You'll paste them
in step 4.

> The callback domain must be exactly `localhost`, with no `http://` and no
> port. If it's wrong, the login step fails with a redirect error. You can edit
> it later on the same page.

---

## 2. Copy the app folder to the home Mac

The folder to move is:

```
~/Desktop/TSC/private/strava-portable/
```

It's about 200 KB — the working copy on this laptop is bigger only because of
its virtualenv, which is machine-specific and deliberately excluded. There's
also `strava-portable.zip` next to it if that's easier to send.

AirDrop, USB stick, iCloud Drive — whatever's convenient. On the home Mac, put
it somewhere stable that isn't inside a synced folder, e.g.:

```
~/Applications/workouts/
```

Avoid `~/Desktop` and `~/Documents` if iCloud Drive is syncing them — a
database file being synced mid-write is a bad time.

> Keep this laptop's copy as your editing copy. Once the home Mac is running,
> that's where the real database lives; don't copy the folder back over it.

### One thing to be careful about: `pb.csv`

Your swim race results live in `pb.csv`, as a plain text file rather than in the
database — which is what lets you edit it by hand.

The catch is that it now exists in two places. **Once the home Mac is running,
its `pb.csv` is the real one.** If you add a race there and later re-copy the
folder from this laptop, you'd overwrite it and lose that race.

So: after a race, edit `pb.csv` **on the home Mac** (its copy is the one the app
serves), and if you want this laptop's copy to stay current, copy that file back
here — not the other way round.

`goals.json` works the same way, for the same reason — it is the other file the
app reads rather than generates. Change a target on the home Mac. Everything
else in the folder is either code or regenerated from Strava.

---

## 3. Install Python and the dependencies

On the home Mac, in the folder you just copied:

```bash
cd ~/Applications/workouts

# needs Python 3.11+. macOS ships 3.9, which is too old.
python3 --version

# if that shows 3.9 or older, install a newer one:
brew install python@3.12
# (no Homebrew? /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)")

/opt/homebrew/opt/python@3.12/bin/python3.12 -m venv venv
./venv/bin/pip install -r requirements.txt
```

Check it worked:

```bash
./venv/bin/python -c "import fastapi, uvicorn, httpx; print('ok')"
```

---

## 4. Connect Strava and pull your history

Paste in the credentials from step 1:

```bash
cp config.example.json config.json
open -e config.json          # or nano config.json
```

Make it look like this, with your own values:

```json
{
  "client_id": "12345",
  "client_secret": "your40characterhexsecret"
}
```

Save, then protect it and log in:

```bash
chmod 600 config.json
./venv/bin/python -m app.cli authorize
```

A browser opens with Strava's permission screen.

> **Leave every box ticked**, in particular *"View data about your private
> activities"*. Without it, anything you marked private is invisible to the
> app. It refuses to continue if you untick that one, so you can't get it
> silently wrong.

Then pull everything:

```bash
./venv/bin/python -m app.cli sync --full
./venv/bin/python -m app.cli status
```

`status` prints a per-sport table. **Look at it.** If the counts and distances
look wrong, that's the moment to say so, not after everything else is set up.

Try it before making it permanent:

```bash
./venv/bin/python -m app.cli serve
```

Open <http://localhost:8720>. Check both tabs in the header:

- **Training** — the charts from Strava
- **Races** — your swim times from `pb.csv`

If a banner appears at the top of the Races tab, a row in `pb.csv` has a typo;
it names the line number. Everything else still works — bad rows are skipped,
not fatal.

Ctrl-C to stop.

---

## 5. Make it start on its own and stay awake

```bash
./deploy/install.sh
```

That installs two background jobs: the web server (restarted automatically if
it ever dies) and an hourly sync. Check them:

```bash
launchctl list | grep workouts
curl -s localhost:8720/healthz          # expect {"ok":true}
```

Logs are in `logs/`. To remove both later: `./deploy/install.sh remove`.

### Stop the Mac from sleeping

```bash
sudo pmset -a disablesleep 1     # never sleep, even with the lid closed
sudo pmset -a autorestart 1      # restart itself after a power cut
```

`disablesleep 1` is what lets you shut the lid and shove it on a shelf. The
screen still turns off; the machine doesn't. Undo with `sudo pmset -a
disablesleep 0`.

### One catch worth knowing about reboots

These background jobs run **as you, once you're logged in**. After an
unattended reboot — a power cut, a macOS update — nothing starts until someone
logs into that Mac.

To make reboots fully hands-off you need **automatic login**
(System Settings → Users & Groups → Automatic login → your account), and that
requires **FileVault to be off**, because FileVault demands a password at boot
before any login can happen.

That's a genuine security tradeoff on a machine sitting at home:

- **FileVault off + auto-login** — survives reboots unattended. If the laptop
  is stolen, its disk is readable.
- **FileVault on** — disk encrypted, but after any reboot you walk over and log
  in before your stats come back.

Your call. Nothing else in the setup depends on it. If you keep FileVault on,
just remember that "the app is down" after a power cut usually means "the Mac
is sitting at the login screen".

---

## 6. Put it on Tailscale

You already have Tailscale on your phone and on this laptop, so this is just
the home Mac.

1. Install it from <https://tailscale.com/download> and sign in with **the same
   account** as your phone.
2. Then:

```bash
tailscale status                 # confirm it's connected
tailscale serve --bg 8720
tailscale serve status
```

That last command prints your URL — something like:

```
https://mac-air.tailXXXX.ts.net/
```

If `tailscale` isn't found, the binary is inside the app:

```bash
alias tailscale="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
```

`serve` gives you a real HTTPS certificate and keeps the app private to your
own devices. There's no login screen because there doesn't need to be — nobody
else can reach it.

> Don't use `tailscale funnel`. That publishes it to the entire internet, and
> the app has no authentication of its own. If you ever want to show it to
> someone, tell me and I'll add a password first.

---

## 7. Install it on your phone

1. Open the `https://…ts.net` URL in **Safari** (iOS) or Chrome (Android).
2. Share → **Add to Home Screen**.
3. It gets the bar-chart icon and opens full-screen, with no browser chrome.

It caches the last view, so opening it on a plane still shows your numbers —
they'll just be as of the last sync.

---

## 8. Check it actually works from outside

The real test, in order:

- [ ] `curl -s localhost:8720/healthz` on the home Mac → `{"ok":true}`
- [ ] the Tailscale URL opens from this laptop
- [ ] **from your phone on cellular data, with wifi off** — this is the one
      that proves it's going over Tailscale and not your home network
- [ ] the home-screen icon opens it full-screen
- [ ] the totals match what Strava shows you
- [ ] close the lid on the home Mac, wait a minute, load it again from the phone
- [ ] tomorrow: the header says "synced Xh ago", proving the hourly job runs

---

## Adding a race later

On the home Mac, append a line to `pb.csv` and reload the page. That's it — no
sync, no restart.

```csv
Date,Distance,Nage,Bassin,Temps
04/10/2026,200,breast,SCM,3:18:44
```

- **Date** — `DD/MM/YYYY`
- **Distance** — metres
- **Nage** — `free`, `back`, `breast`, `fly`, `IM` (or `brasse`, `papillon`,
  `dos`, `4 nages`)
- **Bassin** — `SCM` for a 25 m pool, `LCM` for 50 m, `OW` for open water
- **Temps** — the last group is hundredths, as on a scoreboard: `3:18:44` is
  3 min 18.44 s. For a long open-water swim add an hours group:
  `1:08:55:80`. A decimal point also works (`3:18.44`).

The app treats each distance + stroke + pool as its own event, so a 100 m
breaststroke in a 25 m pool never gets compared against one in a 50 m pool.

If you mistype something, the Races tab tells you which line and skips it — it
won't break the page or corrupt anything.

## Changing a goal later

Same deal, in `goals.json` on the home Mac — edit the number, reload the page.
Weekly and monthly targets are independent, so if you want them to agree, do the
arithmetic: a month is 4.35 weeks, so 100 km a month is 23 km a week.

A typo is named in a banner at the top of the Goals tab and that entry is
skipped; the rest still work.

## Later, if you want

Not needed, just things the shape of the app makes easy:

- **More statistics.** Every activity's full Strava payload is stored, so new
  charts are SQL queries, not another API crawl. Heart-rate zones over time,
  pace distribution, weekday-vs-weekend splits, consistency streaks.
- **Personal records** — fastest 5/10 km, longest ride per year.
- **Weekly summary** — a push notification or email each Monday.
- **Backups.** The whole thing is one SQLite file, `data/strava.db`. Copying it
  somewhere weekly is a complete backup. Worth doing once your history is in
  there, since a full re-sync depends on Strava still being reachable.

---

## If something breaks

`SETUP.md` has a troubleshooting table covering the common failures — expired
tokens, wrong callback domain, port conflicts, launchd jobs flapping, the app
not coming back after a reboot.

Quickest general reset, keeping your data:

```bash
./deploy/install.sh remove
./venv/bin/python -m app.cli status      # is the data still there?
./venv/bin/python -m app.cli serve       # does it run in the foreground?
```

If that works, the app is fine and the problem is launchd or Tailscale.
