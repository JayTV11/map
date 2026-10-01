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

Severity = str  # a level id from the configured scale (see severity.py), or "unknown"
Criticality = Literal["low", "normal", "high", "critical"]
Direction = Literal["inbound", "outbound", "internal"]
SourceKind = Literal["csv", "elastic"]


class AssetRef(BaseModel):
    """A named business system an IP belongs to (see assets.py)."""
    name: str
    criticality: Criticality = "normal"


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

    # Alert detail -- all optional so CSV rows and older Elastic mappings
    # that don't carry these still produce a valid event.
    signature: Optional[str] = None
    signature_id: Optional[str] = None
    category: Optional[str] = None
    protocol: Optional[str] = None
    src_port: Optional[int] = None
    dst_port: Optional[int] = None
    action: Optional[str] = None          # e.g. allowed / blocked
    alert_time: Optional[str] = None      # the document's own timestamp (Elastic only)
    kibana_url: Optional[str] = None      # deep link to this doc in Discover, if configured

    # Filled in by the asset directory (assets.py) when the IP is in a known range.
    src_asset: Optional[AssetRef] = None
    dst_asset: Optional[AssetRef] = None
    # inbound = outside -> one of our systems, outbound = one of ours -> outside,
    # internal = between two of ours. None when neither side is a known asset.
    direction: Optional[Direction] = None

    source: SourceKind

    # Fields in the source data that weren't mapped to anything above, shown in the detail panel.
    extra: dict[str, str] = Field(default_factory=dict)
    # Set when a location was filled in from the home site because the data had none for that side.
    geo_note: Optional[str] = None

    # True when this is a re-fire of a real event still within the buffer's
    # lookback window (see Broadcaster._replay_loop in broadcast.py), rather
    # than a genuinely new occurrence. The frontend renders it identically
    # but skips the event log and stat counters for it -- see main.ts.
    is_replay: bool = False