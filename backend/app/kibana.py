"""Builds a Kibana Discover deep link for one Elastic document.

Only used when config.yaml's kibana.base_url and kibana.data_view_id are
both set. The link filters on the document's _id inside a window around
the alert's own timestamp, so Discover opens straight onto that hit.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from urllib.parse import quote


def _rison_str(value: str) -> str:
    return "'" + value.replace("!", "!!").replace("'", "!'") + "'"


def _kql_str(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _parse_ts(raw: Any) -> Optional[datetime]:
    if not isinstance(raw, str):
        return None
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def discover_url(kibana_cfg: dict[str, Any], doc_id: str, alert_time: Any, window_minutes: int = 15) -> Optional[str]:
    base = (kibana_cfg.get("base_url") or "").rstrip("/")
    data_view = kibana_cfg.get("data_view_id") or ""
    if not base or not data_view or not doc_id:
        return None

    ts = _parse_ts(alert_time) or datetime.now(timezone.utc)
    start = (ts - timedelta(minutes=window_minutes)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    end = (ts + timedelta(minutes=window_minutes)).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    g = f"(time:(from:{_rison_str(start)},to:{_rison_str(end)}))"
    a = (
        f"(columns:!(),index:{_rison_str(data_view)},"
        f"query:(language:kuery,query:{_rison_str('_id : ' + _kql_str(doc_id))}))"
    )
    safe = "!()*',:@$~"
    return f"{base}/app/discover#/?_g={quote(g, safe=safe)}&_a={quote(a, safe=safe)}"
