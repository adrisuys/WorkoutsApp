#!/bin/bash
# Install the two launchd jobs that keep this thing alive:
#   * the web server (restarted on crash and on login)
#   * the hourly Strava sync
#
#   ./deploy/install.sh          install / reinstall
#   ./deploy/install.sh remove   uninstall
#   ./deploy/install.sh dry-run  write the plists to ./logs/dry-run and stop,
#                                without touching launchd — use this to check
#                                what would be installed
#
# launchd agents run as you, on login. The Mac must therefore be logged in —
# which it is, if it just sits at home plugged into the wall.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
PYTHON="$APP_DIR/venv/bin/python"
WEB_LABEL="com.workouts.web"
SYNC_LABEL="com.workouts.sync"
PORT="${STRAVA_PORT:-8720}"
UID_NUM="$(id -u)"
MODE="${1:-install}"

if [ "$MODE" = "dry-run" ]; then
  AGENTS_DIR="$APP_DIR/logs/dry-run"
fi

unload() {
  local label="$1"
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
}

if [ "$MODE" = "remove" ]; then
  unload "$WEB_LABEL"
  unload "$SYNC_LABEL"
  rm -f "$AGENTS_DIR/$WEB_LABEL.plist" "$AGENTS_DIR/$SYNC_LABEL.plist"
  echo "Removed both launchd jobs."
  exit 0
fi

if [ ! -x "$PYTHON" ]; then
  echo "No virtualenv at $PYTHON — create it first (see README)." >&2
  exit 1
fi

mkdir -p "$AGENTS_DIR" "$APP_DIR/logs"

write_plist() {
  local label="$1" plist="$AGENTS_DIR/$1.plist"
  shift
  local schedule="$1"
  shift

  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0">'
    echo '<dict>'
    echo "  <key>Label</key><string>$label</string>"
    echo '  <key>ProgramArguments</key>'
    echo '  <array>'
    for arg in "$@"; do
      echo "    <string>$arg</string>"
    done
    echo '  </array>'
    echo "  <key>WorkingDirectory</key><string>$APP_DIR</string>"
    echo "  <key>StandardOutPath</key><string>$APP_DIR/logs/$label.log</string>"
    echo "  <key>StandardErrorPath</key><string>$APP_DIR/logs/$label.log</string>"
    echo '  <key>EnvironmentVariables</key>'
    echo "  <dict><key>STRAVA_PORT</key><string>$PORT</string></dict>"
    echo '  <key>RunAtLoad</key><true/>'
    echo "$schedule"
    echo '</dict>'
    echo '</plist>'
  } > "$plist"

  plutil -lint "$plist" > /dev/null || { echo "generated a malformed plist: $plist" >&2; exit 1; }

  if [ "$MODE" = "dry-run" ]; then
    echo "  wrote $plist (not loaded)"
    return
  fi

  unload "$label"
  launchctl bootstrap "gui/$UID_NUM" "$plist"
  echo "  loaded $label"
}

if [ "$MODE" = "dry-run" ]; then
  echo "Dry run — writing plists to $AGENTS_DIR, launchd untouched"
else
  echo "Installing launchd jobs from $APP_DIR"
fi

# KeepAlive: bring the server back if it exits for any reason.
write_plist "$WEB_LABEL" '  <key>KeepAlive</key><true/>' \
  "$PYTHON" -m app.cli serve --host 127.0.0.1 --port "$PORT"

# StartInterval: an incremental sync every hour. It also runs at load.
write_plist "$SYNC_LABEL" '  <key>StartInterval</key><integer>3600</integer>' \
  "$PYTHON" -m app.cli sync

if [ "$MODE" = "dry-run" ]; then
  echo
  echo "Dry run complete. Nothing was installed. Inspect the files above, then"
  echo "run ./deploy/install.sh for real."
  exit 0
fi

cat <<EOF

Done. The app is on http://127.0.0.1:$PORT and syncs hourly.
Logs: $APP_DIR/logs/

Stop the Mac from sleeping while on mains power:
  sudo pmset -c sleep 0 disablesleep 0

Publish it to your own devices over HTTPS:
  tailscale serve --bg $PORT
  tailscale serve status
EOF
