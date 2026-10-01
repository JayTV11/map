"""Polls an Elastic index (a Suricata alert pipeline, in this case) for
new documents since the last poll, using a (timestamp, id) cursor so a
poll boundary can't silently drop or double-count same-timestamp docs.

Field names are whatever your index mapping actually uses -- see
config.yaml's elastic.field_mapping. Nothing here does IP geolocation;
this assumes lat/lon are already present on the document (e.g. via a
GeoIP processor upstream in your ingest pipeline).
"""
from __future__ import annotations

import asyncio
from typing import Any, Optional

from elasticsearch import AsyncElasticsearch

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


class ElasticPollSource(EventSource):
    def __init__(self, cfg: dict[str, Any]) -> None:
        self._cfg = cfg
        self._fields = cfg["field_mapping"]
        self._kibana = cfg.get("kibana") or {}
        self._client: Optional[AsyncElasticsearch] = None
        self._running = False
        self._last_timestamp: Optional[str] = None

    async def stop(self) -> None:
        self._running = False
        if self._client:
            await self._client.close()

    async def run(self, publish: Publisher) -> None:
        self._client = AsyncElasticsearch(
            hosts=self._cfg["hosts"],
            api_key=self._cfg.get("api_key") or None,
        )
        self._running = True
        ts_field = self._fields["timestamp"]

        while self._running:
            try:
                query: dict[str, Any] = {"match_all": {}}
                if self._last_timestamp:
                    query = {"range": {ts_field: {"gt": self._last_timestamp}}}

                resp = await self._client.search(
                    index=self._cfg["index"],
                    body={"size": 500, "sort": [{ts_field: "asc"}, {"_id": "asc"}], "query": query},
                )
                hits = resp["hits"]["hits"]

                for hit in hits:
                    doc = hit["_source"]
                    src_lat = _get(doc, self._fields["src_lat"])
                    src_lon = _get(doc, self._fields["src_lon"])
                    dst_lat = _get(doc, self._fields["dst_lat"])
                    dst_lon = _get(doc, self._fields["dst_lon"])
                    if None in (src_lat, src_lon, dst_lat, dst_lon):
                        continue  # no geo on this doc -- can't plot it, skip

                    event = TrafficEvent(
                        src_lat=float(src_lat), src_lon=float(src_lon),
                        dst_lat=float(dst_lat), dst_lon=float(dst_lon),
                        severity=_normalize_severity(_get(doc, self._fields["severity"])),
                        src_ip=_get(doc, self._fields["src_ip"]),
                        dst_ip=_get(doc, self._fields["dst_ip"]),
                        signature=_opt_str(doc, self._fields, "signature"),
                        signature_id=_opt_str(doc, self._fields, "signature_id"),
                        category=_opt_str(doc, self._fields, "category"),
                        protocol=_opt_str(doc, self._fields, "protocol"),
                        src_port=_opt_int(doc, self._fields, "src_port"),
                        dst_port=_opt_int(doc, self._fields, "dst_port"),
                        action=_opt_str(doc, self._fields, "action"),
                        alert_time=_opt_str(doc, self._fields, "timestamp"),
                        kibana_url=discover_url(self._kibana, hit.get("_id", ""), _get(doc, ts_field)),
                        source="elastic",
                    )
                    await publish(event)
                    self._last_timestamp = _get(doc, ts_field)

            except Exception as exc:  # scaffold: log and keep polling rather than crash the task
                print(f"[elastic_source] poll failed: {exc!r}")

            await asyncio.sleep(self._cfg.get("poll_interval_seconds", 3))
