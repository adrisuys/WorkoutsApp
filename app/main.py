"""FastAPI app: JSON stats API + the static PWA."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import db, goals, races, stats, strava, sync
from .config import STATIC_DIR


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init_db()
    yield


app = FastAPI(
    title="Strava Stats",
    docs_url="/api/docs",
    redoc_url=None,
    lifespan=lifespan,
)


def _split(value: str | None) -> list[str] | None:
    if not value:
        return None
    return [part for part in (p.strip() for p in value.split(",")) if part]


@app.exception_handler(stats.BadRequest)
def _bad_request(_request, exc: stats.BadRequest):
    return JSONResponse({"detail": str(exc)}, status_code=400)


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------

@app.get("/api/overview")
def api_overview(response: Response):
    response.headers["Cache-Control"] = "no-store"
    data = stats.overview()
    data["authorised"] = strava.is_authorised()
    return data


@app.get("/api/series")
def api_series(
    response: Response,
    metric: str = Query("distance"),
    bucket: str = Query("month"),
    start: str | None = None,
    end: str | None = None,
    sports: str | None = None,
):
    response.headers["Cache-Control"] = "no-store"
    return stats.series(metric, bucket, start, end, _split(sports))


@app.get("/api/totals")
def api_totals(
    response: Response,
    start: str | None = None,
    end: str | None = None,
    sports: str | None = None,
):
    response.headers["Cache-Control"] = "no-store"
    return stats.totals(start, end, _split(sports))


@app.get("/api/week")
def api_week(response: Response, offset: int = Query(0, le=0, ge=-2600)):
    """A Monday-to-Sunday week, per day and per sport. `offset` counts weeks
    back from the current one; 0 is this week and the future is refused."""
    response.headers["Cache-Control"] = "no-store"
    return stats.week(offset)


@app.get("/api/records")
def api_records(
    response: Response,
    metric: str = Query("distance"),
    start: str | None = None,
    end: str | None = None,
    sports: str | None = None,
):
    response.headers["Cache-Control"] = "no-store"
    return stats.records(metric, start, end, _split(sports))


@app.get("/api/cumulative")
def api_cumulative(
    response: Response,
    metric: str = Query("distance"),
    group: str = Query("run"),
    years: int = Query(6, ge=1, le=25),
):
    response.headers["Cache-Control"] = "no-store"
    return stats.cumulative(metric, group, years)


@app.get("/api/averages")
def api_averages(
    response: Response,
    metric: str = Query("distance"),
    start: str | None = None,
    end: str | None = None,
    sports: str | None = None,
):
    response.headers["Cache-Control"] = "no-store"
    return stats.averages(metric, start, end, _split(sports))


@app.get("/api/activities")
def api_activities(
    response: Response,
    q: str | None = None,
    sports: str | None = None,
    start: str | None = None,
    end: str | None = None,
    sort: str = Query("date"),
    direction: str = Query("desc"),
    limit: int = Query(50, ge=1, le=stats.LOG_PAGE_MAX),
    offset: int = Query(0, ge=0),
):
    response.headers["Cache-Control"] = "no-store"
    return stats.activities(
        q, _split(sports), start, end, sort, direction, limit, offset
    )


@app.get("/api/races")
def api_races(response: Response):
    """Swim races, re-read from pb.csv on every call so edits show up at once."""
    response.headers["Cache-Control"] = "no-store"
    return races.overview()


@app.get("/api/goals")
def api_goals(response: Response):
    """Training targets, re-read from goals.json on every call so edits show up
    at once — the same deal as /api/races."""
    response.headers["Cache-Control"] = "no-store"
    return goals.overview()


@app.post("/api/sync")
def api_sync(full: bool = False):
    """Trigger a sync by hand. The cron job does this hourly anyway."""
    try:
        return sync.run_sync(full=full, verbose=False)
    except strava.NotAuthorised as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except strava.StravaError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/healthz")
def healthz():
    return {"ok": True}


# --------------------------------------------------------------------------
# Static PWA — mounted last so it never shadows /api
# --------------------------------------------------------------------------

@app.get("/sw.js", include_in_schema=False)
def service_worker():
    # Must be served from the root so its scope covers the whole app.
    return FileResponse(
        STATIC_DIR / "sw.js",
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"},
    )


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
