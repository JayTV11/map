"""Turns an uploaded dataset into a continuous synthetic event stream.

An uploaded file has no live time dimension to replay, so every row is a
candidate event: rows are sampled with probability proportional to
sqrt(count), and firing rate is governed by `intensity` (1..10). The feed is
labelled SIMULATED everywhere (see status.py); it is a way to demo or
rehearse with a dataset, never presented as live traffic.

The file -> events conversion (column mapping, severity, geo) lives in
normalize.py and routes/ingest.py; this class just fires what it's given.
`parse_csv` is kept for the original fixed-format POST /api/upload.
"""
from __future__ import annotations

import asyncio
import math
import random
from datetime import datetime, timezone
from uuid import uuid4

from ..models import TrafficEvent
from ..normalize import record_to_event
from ..records import read_records
from ..settings import home, scale
from ..severity import SeverityMapper
from .base import EventSource, Publisher

REQUIRED_COLUMNS = {
    "src_lat", "src_lon", "dst_lat", "dst_lon", "severity", "count", "src_ip", "dst_ip",
}
OPTIONAL_COLUMNS = ["signature", "category", "protocol", "src_port", "dst_port", "action"]


def parse_csv(raw: bytes) -> list[TrafficEvent]:
    """The original fixed format: exactly these column names. New uploads go through /api/ingest."""
    parsed = read_records(raw)
    if parsed.format != "csv":
        raise ValueError("Expected a CSV file")
    columns = set(parsed.records[0].keys())
    missing = REQUIRED_COLUMNS - columns
    if missing:
        raise ValueError(f"CSV is missing required columns: {sorted(missing)}")

    mapping = {c: c for c in REQUIRED_COLUMNS | {c for c in OPTIONAL_COLUMNS if c in columns}}
    mapping["src_lat"], mapping["src_lon"] = "src_lat", "src_lon"
    sev = SeverityMapper(scale)
    events: list[TrafficEvent] = []
    for rec in parsed.records:
        event, _ = record_to_event(rec, mapping, sev, home, "csv")
        if event is not None:
            events.append(event)
    if not events:
        raise ValueError("CSV had no usable rows")
    return events


class CSVReplaySource(EventSource):
    """Idle until a dataset is loaded (POST /api/upload or /api/ingest/load)."""

    def __init__(self) -> None:
        self._events: list[TrafficEvent] = []
        self._weights: list[float] = []
        self._intensity: int = 5
        self._running = False

    def load_events(self, events: list[TrafficEvent]) -> int:
        self._events = events
        # sqrt-dampened rather than raw count: a row with count=500 should
        # still fire more often than one with count=3, but not ~166x more
        # often -- at that ratio the same route re-fires before its guide
        # line finishes fading, which visually "burns in" that one path.
        self._weights = [math.sqrt(max(1, e.count)) for e in events]
        return len(events)

    def load(self, raw: bytes) -> int:
        return self.load_events(parse_csv(raw))

    def unload(self) -> None:
        """Back to idle: no rows, so run() stops firing events."""
        self._events = []
        self._weights = []

    def set_intensity(self, intensity: int) -> None:
        self._intensity = max(1, min(10, intensity))

    async def stop(self) -> None:
        self._running = False

    async def run(self, publish: Publisher) -> None:
        self._running = True
        while self._running:
            if not self._events:
                await asyncio.sleep(0.5)
                continue

            template = random.choices(self._events, weights=self._weights, k=1)[0]
            await publish(template.model_copy(update={"id": uuid4().hex, "timestamp": datetime.now(timezone.utc)}))

            base, floor = 0.9, 0.06  # seconds, same curve validated in the mockup
            delay = base - (base - floor) * ((self._intensity - 1) / 9)
            await asyncio.sleep(delay * random.uniform(0.6, 1.4))


csv_source = CSVReplaySource()
