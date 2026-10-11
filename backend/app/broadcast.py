"""In-memory event fan-out: every ingestion source calls `publish()`,
every connected browser tab gets it over its WebSocket. Nothing is
persisted -- Elastic (or the uploaded CSV) is the only system of record.

Two things happen with the rolling buffer of recent events:

1. A tab that connects mid-session gets backfilled with it, so it isn't
   staring at an empty map (this existed from the start).
2. A background loop keeps re-firing events out of it at a steady pace
   (see _replay_loop) so the map stays visually alive when real traffic
   is genuinely sparse, rather than going blank between hits. Only real
   Elastic events are buffered/replayed -- CSV mode already produces its
   own continuous stream and doesn't need this.

Replays are flagged (TrafficEvent.is_replay) so the frontend can render
them identically to a fresh hit while keeping them out of the event log
and stat counters -- see frontend/src/main.ts.
"""
from __future__ import annotations

import asyncio
import random
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import uuid4

from fastapi import WebSocket

from .anomaly import score_event
from .assets import directory
from .config import config
from .insights import observe_event
from .known_good import known_good
from .models import TrafficEvent
from .status import status


class Broadcaster:
    def __init__(
        self,
        buffer_window_minutes: int = 10,
        replay_enabled: bool = True,
        replay_interval_seconds: float = 5.0,
    ):
        self._clients: set[WebSocket] = set()
        self._buffer: deque[TrafficEvent] = deque()
        self._window = timedelta(minutes=buffer_window_minutes)
        self._lock = asyncio.Lock()
        self._replay_enabled = replay_enabled
        self._replay_interval = replay_interval_seconds
        self._replay_task: Optional[asyncio.Task] = None

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._clients.add(ws)
        for event in list(self._buffer):
            await ws.send_text(event.model_dump_json())

    def disconnect(self, ws: WebSocket) -> None:
        self._clients.discard(ws)

    async def publish(self, event: TrafficEvent) -> None:
        status.event(event.source)  # replays bypass publish(), so this only ever counts genuinely new events
        directory.enrich(event)  # before buffering, so replayed copies carry the names too
        event.anomaly = score_event(event)  # same reason: a replay shows the score the event had when it happened
        observe_event(event, known_good.matches(event.src_ip) or known_good.matches_signature(event.signature))
        # Only real Elastic events get buffered/replayed -- CSV mode is
        # already a continuous synthetic stream and doesn't need help.
        if event.source == "elastic":
            async with self._lock:
                self._buffer.append(event)
                self._trim_buffer_locked()

        await self._send_to_all(event)

    def start_replay_loop(self) -> Optional[asyncio.Task]:
        if not self._replay_enabled:
            return None
        self._replay_task = asyncio.create_task(self._replay_loop())
        return self._replay_task

    def _trim_buffer_locked(self) -> None:
        """Caller must hold self._lock. Drops events older than the
        lookback window -- this is what makes replays stop once the
        real event they're based on has genuinely aged out."""
        cutoff = datetime.now(timezone.utc) - self._window
        while self._buffer and self._buffer[0].timestamp < cutoff:
            self._buffer.popleft()

    async def _replay_loop(self) -> None:
        while True:
            await asyncio.sleep(self._replay_interval)

            async with self._lock:
                self._trim_buffer_locked()
                original = random.choice(self._buffer) if self._buffer else None

            if original is None:
                continue

            # A fresh id/timestamp for display purposes, but deliberately
            # NOT re-appended to the buffer -- a replay must not reset its
            # own source event's aging-out clock, or it would repeat
            # forever instead of stopping once genuinely stale.
            replay = original.model_copy(
                update={
                    "id": uuid4().hex,
                    "timestamp": datetime.now(timezone.utc),
                    "is_replay": True,
                }
            )
            await self._send_to_all(replay)

    async def _send_to_all(self, event: TrafficEvent) -> None:
        payload = event.model_dump_json()
        dead: list[WebSocket] = []
        for ws in self._clients:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


_buffer_cfg = config.get("buffer", {})
broadcaster = Broadcaster(
    buffer_window_minutes=_buffer_cfg.get("window_minutes", 10),
    replay_enabled=_buffer_cfg.get("replay_enabled", True),
    replay_interval_seconds=_buffer_cfg.get("replay_interval_seconds", 5.0),
)