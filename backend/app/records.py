"""Reads an uploaded file into a list of flat records (dicts).

Accepts CSV/TSV (delimiter sniffed), a JSON array, NDJSON (one object per
line), an Elastic search response (hits.hits[]._source), or a JSON object
wrapping a list of events. Nested objects are flattened to dotted keys
("source.geo.location.lat") so every format reaches the mapper the same way.
"""
from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass
from typing import Any, Optional

MAX_ROWS = 200_000
MAX_DEPTH = 6


@dataclass
class Parsed:
    format: str
    records: list[dict[str, Any]]
    truncated: bool = False
    bad_lines: int = 0


def flatten(obj: dict[str, Any], prefix: str = "", depth: int = 0) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in obj.items():
        key = f"{prefix}.{k}" if prefix else str(k)
        if isinstance(v, dict) and depth < MAX_DEPTH:
            out.update(flatten(v, key, depth + 1))
        else:
            out[key] = v
    return out


def _decode(raw: bytes) -> str:
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


def _find_event_list(obj: Any, depth: int = 0) -> Optional[list[Any]]:
    """Finds the list of events inside a wrapper object."""
    if isinstance(obj, list):
        return obj if obj and all(isinstance(x, dict) for x in obj[:20]) else None
    if not isinstance(obj, dict) or depth > 3:
        return None
    hits = obj.get("hits")
    if isinstance(hits, dict) and isinstance(hits.get("hits"), list):
        return [h.get("_source", h) if isinstance(h, dict) else h for h in hits["hits"]]
    for v in obj.values():
        found = _find_event_list(v, depth + 1)
        if found:
            return found
    return None


def read_records(raw: bytes, filename: str = "") -> Parsed:
    text = _decode(raw)
    head = text.lstrip()[:1]
    if not head:
        raise ValueError("The file is empty")

    if head in "[{":
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return _read_ndjson(text)
        items = _find_event_list(data)
        if items is None and isinstance(data, dict):
            items = [data]
        if not items:
            raise ValueError("Couldn't find a list of events in this JSON")
        recs = [flatten(x) for x in items if isinstance(x, dict)]
        return _finish("json", recs)

    return _read_csv(text)


def _read_ndjson(text: str) -> Parsed:
    recs: list[dict[str, Any]] = []
    bad = 0
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            bad += 1
            continue
        if isinstance(obj, dict):
            recs.append(flatten(obj))
        else:
            bad += 1
        if len(recs) > MAX_ROWS:
            break
    if not recs:
        raise ValueError("Couldn't read any JSON events from this file")
    p = _finish("ndjson", recs)
    p.bad_lines = bad
    return p


def _read_csv(text: str) -> Parsed:
    try:
        dialect = csv.Sniffer().sniff(text[:8192], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    if not reader.fieldnames:
        raise ValueError("The file has no header row")
    recs: list[dict[str, Any]] = []
    for row in reader:
        recs.append({(k or "").strip(): v for k, v in row.items() if k is not None})
        if len(recs) > MAX_ROWS:
            break
    if not recs:
        raise ValueError("The file has a header but no data rows")
    return _finish("csv", recs)


def _finish(fmt: str, recs: list[dict[str, Any]]) -> Parsed:
    truncated = len(recs) > MAX_ROWS
    return Parsed(fmt, recs[:MAX_ROWS], truncated=truncated)


def columns_of(records: list[dict[str, Any]], sample: int = 500) -> list[str]:
    seen: dict[str, None] = {}
    for r in records[:sample]:
        for k in r:
            seen.setdefault(k, None)
    return list(seen)
