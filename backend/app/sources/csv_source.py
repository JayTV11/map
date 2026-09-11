"""Turns an uploaded CSV (src/dst lat-lon, severity, count -- no
timestamp) into a continuous synthetic event stream.

The CSV has no time dimension, so there's nothing to literally "replay".
Instead every row is a candidate; rows are sampled with probability
proportional to `count`, and firing rate is governed by `intensity`
(1..10) rather than the raw count magnitudes, which can vary wildly
from file to file. This is the same model validated in the visualization
mockup, just moved server-side so the frontend only ever deals with a
plain event stream regardless of source.
"""
from __future__ import annotations

import asyncio
import csv
import io
import random
from dataclasses import dataclass

from ..models import TrafficEvent
from .base import EventSource, Publisher

REQUIRED_COLUMNS = {
    "src_lat", "src_lon", "dst_lat", "dst_lon", "severity", "count", "src_ip", "dst_ip",
}
_VALID_SEVERITIES = {"critical", "major", "high"}


@dataclass
class _Row:
    src_lat: float
    src_lon: float
    dst_lat: float
    dst_lon: float
    severity: str
    count: int
    src_ip: str
    dst_ip: str


def parse_csv(raw: bytes) -> list[_Row]:
    text = raw.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    missing = REQUIRED_COLUMNS - set(reader.fieldnames or [])
    if missing:
        raise ValueError(f"CSV is missing required columns: {sorted(missing)}")

    rows: list[_Row] = []
    for r in reader:
        severity = r["severity"].strip().lower()
        if severity not in _VALID_SEVERITIES:
            severity = "unknown"
        rows.append(
            _Row(
                src_lat=float(r["src_lat"]),
                src_lon=float(r["src_lon"]),
                dst_lat=float(r["dst_lat"]),
                dst_lon=float(r["dst_lon"]),
                severity=severity,
                count=max(1, int(float(r["count"]))),
                src_ip=r["src_ip"].strip(),
                dst_ip=r["dst_ip"].strip(),
            )
        )
    if not rows:
        raise ValueError("CSV had no data rows")
    return rows


class CSVReplaySource(EventSource):
    """Idle until a file is loaded via POST /api/upload (see routes/upload.py)."""

    def __init__(self) -> None:
        self._rows: list[_Row] = []
        self._weights: list[int] = []
        self._intensity: int = 5
        self._running = False

    def load(self, raw: bytes) -> int:
        rows = parse_csv(raw)
        self._rows = rows
        self._weights = [r.count for r in rows]
        return len(rows)

    def set_intensity(self, intensity: int) -> None:
        self._intensity = max(1, min(10, intensity))

    async def stop(self) -> None:
        self._running = False

    async def run(self, publish: Publisher) -> None:
        self._running = True
        while self._running:
            if not self._rows:
                await asyncio.sleep(0.5)
                continue

            row = random.choices(self._rows, weights=self._weights, k=1)[0]
            event = TrafficEvent(
                src_lat=row.src_lat, src_lon=row.src_lon,
                dst_lat=row.dst_lat, dst_lon=row.dst_lon,
                severity=row.severity, count=row.count,
                src_ip=row.src_ip, dst_ip=row.dst_ip,
                source="csv",
            )
            await publish(event)

            base, floor = 0.9, 0.06  # seconds, same curve validated in the mockup
            delay = base - (base - floor) * ((self._intensity - 1) / 9)
            await asyncio.sleep(delay * random.uniform(0.6, 1.4))


csv_source = CSVReplaySource()
