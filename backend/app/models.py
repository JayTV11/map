"""Core data contract shared by every ingestion source and the frontend.

Whether an event comes from Elastic (real alert time, single real
occurrence) or from the CSV-driven simulator (synthetic timestamp,
sampled occurrence), it becomes one of these before it ever reaches the
broadcaster -- the WebSocket layer and the frontend never know which
source produced it.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Optional
from uuid import uuid4

from pydantic import BaseModel, Field

Severity = Literal["critical", "major", "high", "unknown"]
SourceKind = Literal["csv", "elastic"]


class TrafficEvent(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    src_lat: float
    src_lon: float
    dst_lat: float
    dst_lon: float

    severity: Severity = "unknown"
    count: int = 1

    src_ip: Optional[str] = None
    dst_ip: Optional[str] = None

    source: SourceKind
