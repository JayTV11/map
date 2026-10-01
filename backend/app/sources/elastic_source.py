"""Polls an Elastic index (a Suricata alert pipeline, in this case) for
new documents and turns each into a TrafficEvent.

Cursor design (why it isn't a plain "timestamp > last seen"):

  * Many alerts can share one timestamp, and a poll page can end in the
    middle of them. A strict `>` cursor silently drops the rest.
  * Documents are indexed with some delay, so a doc stamped slightly
    BEFORE the newest one we've seen can still show up late.

So each poll re-reads a small overlap window (`overlap_seconds`) behind
the cursor and de-duplicates by (_index, _id). Nothing is dropped at a
page or timestamp boundary, and nothing is published twice. The overlap
is also the longest ingest delay this tolerates: a doc that reaches
Elastic more than `overlap_seconds` after its own timestamp can be
missed.

On startup it begins `initial_lookback_minutes` ago (default 2), not at
the start of the index, so connecting to a large index doesn't replay
history. Set it to 0 to start from "now".

Field names are whatever your index mapping actually uses -- see
config.yaml's elastic.field_mapping. Nothing here does IP geolocation;
this assumes lat/lon are already present on the document (e.g. via a
GeoIP processor upstream in your ingest pipeline).
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from elasticsearch import AsyncElasticsearch

from ..kibana import _parse_ts as parse_timestamp
from ..kibana import discover_url
from ..models import TrafficEvent
from .base import EventSource, Publisher


def _get(doc: dict[str, Any], dotted_path: str) -> Any:
    node: Any = doc
    for part in dotted_path.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def _opt(doc: dict[str, Any], fields: dict[str, str], key: str) -> Any:
    """Optional field: None when the mapping key is absent or the doc lacks it."""
    path = fields.get(key)
    return _get(doc, path) if path else None


def _opt_str(doc: dict[str, Any], fields: dict[str, str], key: str) -> Optional[str]:
    v = _opt(doc, fields, key)
    return None if v is None else str(v)


def _opt_int(doc: dict[str, Any], fields: dict[str, str], key: str) -> Optional[int]:
    v = _opt(doc, fields, key)
    try:
        return None if v is None else int(v)
    except (TypeError, ValueError):
        return None


def _normalize_severity(raw: Any) -> str:
    if raw is None:
        return "unknown"
    s = str(raw).strip().lower()
    return s if s in ("critical", "major", "high") else "unknown"


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class ElasticPollSource(EventSource):
    BASE_PAGE = 500
    MAX_PAGE = 10_000  # Elasticsearch's default index.max_result_window

    def __init__(self, cfg: dict[str, Any]) -> None:
        self._cfg = cfg
        self._fields = cfg["field_mapping"]
        self._kibana = cfg.get("kibana") or {}
        self._client: Optional[AsyncElasticsearch] = None
        self._running = False

        self._overlap = timedelta(seconds=cfg.get("overlap_seconds", 10))
        self._lookback = timedelta(minutes=cfg.get("initial_lookback_minutes", 2))
        self._since: datetime = datetime.now(timezone.utc) - self._lookback
        self._seen: dict[str, datetime] = {}  # "_index/_id" -> doc timestamp
        self._page = self.BASE_PAGE

    async def stop(self) -> None:
        self._running = False
        if self._client:
            await self._client.close()
            self._client = None

    async def run(self, publish: Publisher) -> None:
        self._client = AsyncElasticsearch(
            hosts=self._cfg["hosts"],
            api_key=self._cfg.get("api_key") or None,
        )
        self._running = True
        try:
            while self._running:
                try:
                    await self._poll_until_caught_up(publish)
                except Exception as exc:  # log and keep polling rather than crash the task
                    print(f"[elastic_source] poll failed: {exc!r}")
                await asyncio.sleep(self._cfg.get("poll_interval_seconds", 3))
        finally:
            # Runs on cancellation too, so shutdown doesn't leak the HTTP session.
            if self._client:
                await self._client.close()

    async def _poll_until_caught_up(self, publish: Publisher) -> None:
        """Keeps paging without sleeping while a full page of NEW docs comes
        back, so a burst is drained promptly instead of 500-per-interval."""
        poll_started = datetime.now(timezone.utc)
        while self._running:
            new_count, hit_count = await self._poll_once(publish)

            if hit_count < self._page:
                # Caught up. Everything stamped older than (poll start - overlap)
                # has had time to be indexed, so the window can move forward;
                # without this the window would grow forever on a quiet index.
                self._page = self.BASE_PAGE
                self._since = max(self._since, poll_started - self._overlap)
                self._evict_seen()
                return

            if new_count == 0:
                # A whole page of already-seen docs: the overlap window holds
                # more docs than one page. Widen the page so new ones fit.
                if self._page >= self.MAX_PAGE:
                    print(
                        f"[elastic_source] overlap window holds >{self.MAX_PAGE} docs; "
                        "events may be skipped. Lower overlap_seconds or poll_interval_seconds."
                    )
                    return
                self._page = min(self._page * 2, self.MAX_PAGE)

    async def _poll_once(self, publish: Publisher) -> tuple[int, int]:
        assert self._client is not None
        ts_field = self._fields["timestamp"]
        now = datetime.now(timezone.utc)

        resp = await self._client.search(
            index=self._cfg["index"],
            query={"range": {ts_field: {"gte": _iso(self._since - self._overlap)}}},
            sort=[{ts_field: {"order": "asc"}}],
            size=self._page,
        )
        hits = resp["hits"]["hits"]

        new_count = 0
        for hit in hits:
            key = f"{hit.get('_index', '')}/{hit.get('_id', '')}"
            if key in self._seen:
                continue

            doc = hit["_source"]
            doc_ts = parse_timestamp(_get(doc, ts_field)) or now
            # Recorded for EVERY new doc, including ones skipped below for
            # missing geo -- otherwise they'd be re-fetched on every poll.
            self._seen[key] = doc_ts
            if doc_ts > self._since:
                self._since = doc_ts
            new_count += 1

            event = self._to_event(hit, doc, doc_ts)
            if event is not None:
                await publish(event)

        return new_count, len(hits)

    def _evict_seen(self) -> None:
        cutoff = self._since - self._overlap
        for key in [k for k, ts in self._seen.items() if ts < cutoff]:
            del self._seen[key]

    def _to_event(self, hit: dict[str, Any], doc: dict[str, Any], doc_ts: datetime) -> Optional[TrafficEvent]:
        f = self._fields
        coords = [_get(doc, f[k]) for k in ("src_lat", "src_lon", "dst_lat", "dst_lon")]
        if None in coords:
            return None  # no geo on this doc -- can't plot it, skip
        try:
            src_lat, src_lon, dst_lat, dst_lon = (float(c) for c in coords)
        except (TypeError, ValueError):
            return None

        return TrafficEvent(
            # The alert's own time, so the replay buffer ages events by when
            # they happened, not when we happened to ingest them.
            timestamp=doc_ts,
            src_lat=src_lat, src_lon=src_lon,
            dst_lat=dst_lat, dst_lon=dst_lon,
            severity=_normalize_severity(_get(doc, f["severity"])),
            src_ip=_get(doc, f["src_ip"]),
            dst_ip=_get(doc, f["dst_ip"]),
            signature=_opt_str(doc, f, "signature"),
            signature_id=_opt_str(doc, f, "signature_id"),
            category=_opt_str(doc, f, "category"),
            protocol=_opt_str(doc, f, "protocol"),
            src_port=_opt_int(doc, f, "src_port"),
            dst_port=_opt_int(doc, f, "dst_port"),
            action=_opt_str(doc, f, "action"),
            alert_time=_opt_str(doc, f, "timestamp"),
            kibana_url=discover_url(self._kibana, hit.get("_id", ""), _get(doc, f["timestamp"])),
            source="elastic",
        )
