"""In-memory event fan-out: every ingestion source calls `publish()`,
every connected browser tab gets it over its WebSocket. Nothing is
persisted -- Elastic (or the uploaded CSV) is the only system of record.
A short rolling buffer lets a tab that connects mid-session catch up
without re-querying the source.
"""
from __future__ import annotations

import asyncio
from collections import deque
from datetime import datetime, timedelta, timezone

from fastapi import WebSocket

from .config import config
from .models import TrafficEvent


class Broadcaster:
    def __init__(self, buffer_window_minutes: int = 10):
        self._clients: set[WebSocket] = set()
        self._buffer: deque[TrafficEvent] = deque()
        self._window = timedelta(minutes=buffer_window_minutes)
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self._clients.add(ws)
        for event in list(self._buffer):
            await ws.send_text(event.model_dump_json())

    def disconnect(self, ws: WebSocket) -> None:
        self._clients.discard(ws)

    async def publish(self, event: TrafficEvent) -> None:
        async with self._lock:
            self._buffer.append(event)
            cutoff = datetime.now(timezone.utc) - self._window
            while self._buffer and self._buffer[0].timestamp < cutoff:
                self._buffer.popleft()

        payload = event.model_dump_json()
        dead: list[WebSocket] = []
        for ws in self._clients:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


broadcaster = Broadcaster(buffer_window_minutes=config.get("buffer", {}).get("window_minutes", 10))
