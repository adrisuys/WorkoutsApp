"""Strava API client: OAuth token lifecycle + activity listing."""

from __future__ import annotations

import json
import time
from typing import Any, Iterator

import httpx

from .config import OAUTH_PORT, SCOPES, TOKENS_PATH, load_config

API_BASE = "https://www.strava.com/api/v3"
OAUTH_AUTHORIZE = "https://www.strava.com/oauth/authorize"
OAUTH_TOKEN = "https://www.strava.com/oauth/token"

REDIRECT_URI = f"http://localhost:{OAUTH_PORT}/callback"

# Strava allows 200 per page; a decade of activities is then a handful of calls.
PAGE_SIZE = 200


class StravaError(RuntimeError):
    pass


class NotAuthorised(StravaError):
    pass


# --------------------------------------------------------------------------
# Tokens
# --------------------------------------------------------------------------

def authorize_url() -> str:
    cfg = load_config()
    params = {
        "client_id": cfg["client_id"],
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "approval_prompt": "auto",
        "scope": SCOPES,
    }
    return str(httpx.URL(OAUTH_AUTHORIZE, params=params))


def _save_tokens(payload: dict[str, Any]) -> dict[str, Any]:
    tokens = {
        "access_token": payload["access_token"],
        "refresh_token": payload["refresh_token"],
        "expires_at": payload["expires_at"],
    }
    TOKENS_PATH.parent.mkdir(parents=True, exist_ok=True)
    TOKENS_PATH.write_text(json.dumps(tokens, indent=2))
    TOKENS_PATH.chmod(0o600)
    return tokens


def load_tokens() -> dict[str, Any]:
    if not TOKENS_PATH.exists():
        raise NotAuthorised(
            "No Strava tokens yet. Run:  ./venv/bin/python -m app.cli authorize"
        )
    return json.loads(TOKENS_PATH.read_text())


def exchange_code(code: str) -> dict[str, Any]:
    """Trade the one-shot authorisation code for a token pair."""
    cfg = load_config()
    resp = httpx.post(
        OAUTH_TOKEN,
        data={
            "client_id": cfg["client_id"],
            "client_secret": cfg["client_secret"],
            "code": code,
            "grant_type": "authorization_code",
        },
        timeout=30,
    )
    if resp.status_code != 200:
        raise StravaError(f"Token exchange failed ({resp.status_code}): {resp.text}")
    return _save_tokens(resp.json())


def access_token() -> str:
    """Return a valid access token, refreshing it when it is about to expire."""
    tokens = load_tokens()
    if tokens.get("expires_at", 0) - 120 > time.time():
        return tokens["access_token"]

    cfg = load_config()
    resp = httpx.post(
        OAUTH_TOKEN,
        data={
            "client_id": cfg["client_id"],
            "client_secret": cfg["client_secret"],
            "refresh_token": tokens["refresh_token"],
            "grant_type": "refresh_token",
        },
        timeout=30,
    )
    if resp.status_code != 200:
        raise NotAuthorised(
            f"Token refresh failed ({resp.status_code}): {resp.text}\n"
            f"Re-run:  ./venv/bin/python -m app.cli authorize"
        )
    return _save_tokens(resp.json())["access_token"]


def is_authorised() -> bool:
    return TOKENS_PATH.exists()


# --------------------------------------------------------------------------
# API calls
# --------------------------------------------------------------------------

def _get(client: httpx.Client, path: str, params: dict | None = None) -> Any:
    """GET with retry on rate-limit and transient server errors."""
    for attempt in range(5):
        resp = client.get(path, params=params)
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code == 401:
            raise NotAuthorised("Strava rejected the access token (401).")
        if resp.status_code == 429:
            # Short-term limit is per 15-minute window; wait for the next one.
            wait = min(900, 60 * (attempt + 1) ** 2)
            print(f"  rate-limited by Strava, sleeping {wait}s…", flush=True)
            time.sleep(wait)
            continue
        if resp.status_code >= 500:
            time.sleep(2 ** attempt)
            continue
        raise StravaError(f"GET {path} failed ({resp.status_code}): {resp.text}")
    raise StravaError(f"GET {path} still failing after retries")


def _client() -> httpx.Client:
    return httpx.Client(
        base_url=API_BASE,
        headers={"Authorization": f"Bearer {access_token()}"},
        timeout=60,
    )


def athlete() -> dict[str, Any]:
    with _client() as client:
        return _get(client, "/athlete")


def iter_activities(after: int | None = None) -> Iterator[list[dict[str, Any]]]:
    """Yield pages of summary activities, oldest-first when `after` is set.

    The summary payload already carries distance, moving_time, elevation,
    sport_type and average heart rate — everything the stats need — so there
    is no need for a detail call per activity.
    """
    with _client() as client:
        page = 1
        while True:
            params: dict[str, Any] = {"per_page": PAGE_SIZE, "page": page}
            if after:
                params["after"] = after
            batch = _get(client, "/athlete/activities", params)
            if not batch:
                return
            yield batch
            if len(batch) < PAGE_SIZE:
                return
            page += 1


# --------------------------------------------------------------------------
# One-shot local OAuth callback server
# --------------------------------------------------------------------------

def wait_for_code() -> str:
    """Serve http://localhost:<OAUTH_PORT>/callback once and return the code."""
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from urllib.parse import parse_qs, urlparse

    captured: dict[str, str] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - stdlib naming
            query = parse_qs(urlparse(self.path).query)
            body = "<h1>Something went wrong — check the terminal.</h1>"
            if "code" in query:
                captured["code"] = query["code"][0]
                captured["scope"] = query.get("scope", [""])[0]
                body = "<h1>Connected.</h1><p>You can close this tab.</p>"
            elif "error" in query:
                captured["error"] = query["error"][0]
                body = f"<h1>Denied: {captured['error']}</h1>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(
                f"<html><body style='font:16px system-ui;padding:3rem'>{body}</body></html>"
                .encode()
            )

        def log_message(self, *args):  # silence the default stderr logging
            pass

    server = HTTPServer(("127.0.0.1", OAUTH_PORT), Handler)
    while "code" not in captured and "error" not in captured:
        server.handle_request()
    server.server_close()

    if "error" in captured:
        raise StravaError(f"Authorisation denied: {captured['error']}")
    if "activity:read_all" not in captured.get("scope", ""):
        raise StravaError(
            "The 'activity:read_all' permission was not granted — private "
            "activities would be missing. Re-run and tick every box."
        )
    return captured["code"]
