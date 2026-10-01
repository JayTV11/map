"""Feed health: what each source is actually doing right now.

The map looks identical whether it's drawing real alerts, a CSV demo, or
replays of old alerts -- and a BROKEN feed looks exactly like a quiet
network. On a wall display that's dangerous: management would read a dead
Elastic connection as "all clear". So every source records its health here
and the UI says so out loud (see frontend/src/status.ts).

Only coarse error CATEGORIES are exposed, never raw exception text: a wall
display (and an unauthenticated endpoint) shouldn't leak hostnames or
internals. The full error still goes to the server log.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


def classify_error(exc: BaseException) -> str:
    """Coarse, display-safe reason for a failed poll. Matches on class names
    (walking the MRO) so it doesn't depend on which elasticsearch /
    elastic-transport version is installed."""
    names = {c.__name__ for c in type(exc).__mro__}
    if names & {"AuthenticationException"}:
        return "authentication failed"
    if names & {"AuthorizationException"}:
        return "access denied"
    if names & {"NotFoundError"}:
        return "index not found"
    if names & {"ConnectionError", "ConnectionTimeout", "TlsError", "ConnectionRefusedError", "TimeoutError", "OSError"}:
        return "unreachable"
    return "poll error"


class FeedStatus:
    def __init__(self) -> None:
        self.elastic_configured = False
        self.elastic_last_poll_ok: Optional[datetime] = None
        self.elastic_error: Optional[str] = None
        self.elastic_error_since: Optional[datetime] = None
        self.elastic_skipped_no_geo = 0  # alerts that had no usable location and so are not on the map
        self.last_event: dict[str, Optional[datetime]] = {"elastic": None, "csv": None}
        self.csv_rows = 0
        self.csv_filename: Optional[str] = None

    # ---- written by the sources -------------------------------------------------
    def poll_ok(self) -> None:
        self.elastic_last_poll_ok = _now()
        self.elastic_error = None
        self.elastic_error_since = None

    def poll_failed(self, exc: BaseException) -> None:
        kind = classify_error(exc)
        if self.elastic_error != kind or self.elastic_error_since is None:
            self.elastic_error_since = _now()  # when THIS kind of failure began, not each retry
        self.elastic_error = kind

    def event(self, source: str) -> None:
        if source in self.last_event:
            self.last_event[source] = _now()

    def csv_loaded(self, rows: int, filename: Optional[str]) -> None:
        self.csv_rows = rows
        self.csv_filename = (filename or "").replace("\\", "/").split("/")[-1] or None

    def csv_cleared(self) -> None:
        self.csv_rows = 0
        self.csv_filename = None
        self.last_event["csv"] = None

    # ---- read by GET /api/status ------------------------------------------------
    def snapshot(self, poll_interval_seconds: float, buffer_cfg: dict[str, Any]) -> dict[str, Any]:
        return {
            "server_time": _iso(_now()),
            "poll_interval_seconds": poll_interval_seconds,
            "elastic": {
                "configured": self.elastic_configured,
                "last_poll_ok_at": _iso(self.elastic_last_poll_ok),
                "last_event_at": _iso(self.last_event["elastic"]),
                "error": self.elastic_error,
                "error_since": _iso(self.elastic_error_since),
                "skipped_no_geo": self.elastic_skipped_no_geo,
            },
            "csv": {
                "loaded": self.csv_rows > 0,
                "rows": self.csv_rows,
                "filename": self.csv_filename,
                "last_event_at": _iso(self.last_event["csv"]),
            },
            "replay": {
                "enabled": bool(buffer_cfg.get("replay_enabled", True)),
                "window_minutes": buffer_cfg.get("window_minutes", 10),
            },
        }


status = FeedStatus()
