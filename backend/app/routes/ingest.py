"""Upload any CSV/JSON: preview how its columns will be read, then load it."""
from __future__ import annotations

from collections import Counter
from typing import Any, Optional

from fastapi import APIRouter, Form, HTTPException, UploadFile

from ..models import TrafficEvent
from ..normalize import Mapping, TARGETS, detect_mapping, record_to_event
from ..records import Parsed, columns_of, read_records
from ..settings import home, scale
from ..severity import PRESETS, UNKNOWN_ID, SeverityMapper
from ..sources.csv_source import csv_source
from ..status import status

router = APIRouter(prefix="/api/ingest", tags=["ingest"])

MAX_BYTES = 100 * 1024 * 1024
SAMPLE_ROWS = 5
SEVERITY_VALUES_SHOWN = 30


async def _read(file: UploadFile) -> tuple[Parsed, str]:
    raw = await file.read()
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, "That file is larger than 100 MB")
    try:
        return read_records(raw, file.filename or ""), file.filename or "upload"
    except ValueError as exc:
        raise HTTPException(400, str(exc))


def _mapping(parsed: Parsed, raw_mapping: Optional[str]) -> tuple[Mapping, bool]:
    """The mapping the client sent, or a fresh auto-detection. The bool says which."""
    cols = columns_of(parsed.records)
    if raw_mapping:
        try:
            m = Mapping.model_validate_json(raw_mapping)
            return m.model_copy(update={"columns": {t: (m.columns.get(t) if m.columns.get(t) in cols else None) for t in TARGETS}}), False
        except ValueError:
            raise HTTPException(400, "Couldn't read the column mapping")
    return Mapping(columns=detect_mapping(cols, parsed.records[:200])), True


def _mapper(m: Mapping, parsed: Parsed) -> SeverityMapper:
    """Explicit choices win; the rest of the distinct values get the suggestion."""
    col = m.columns.get("severity")
    suggestion: dict[str, str] = {}
    if col:
        values = [str(v) for v in dict.fromkeys(r.get(col) for r in parsed.records if r.get(col) not in (None, ""))]
        base = SeverityMapper(scale, preset=m.severity_preset)
        suggestion = base.suggest(values[:500])
    return SeverityMapper(scale, explicit={**suggestion, **m.severity_map}, preset=m.severity_preset, default=m.severity_default)


def _convert(parsed: Parsed, m: Mapping):
    sev = _mapper(m, parsed)
    events: list[TrafficEvent] = []
    skipped: Counter[str] = Counter()
    assumed = 0
    for rec in parsed.records:
        ev, reason = record_to_event(rec, m.columns, sev, home, "csv")
        if ev is None:
            skipped[reason or "bad_row"] += 1
        else:
            events.append(ev)
            assumed += 1 if ev.geo_note else 0
    return events, skipped, assumed


@router.post("/preview")
async def preview(file: UploadFile, mapping: Optional[str] = Form(None)) -> dict[str, Any]:
    parsed, filename = await _read(file)
    m, detected = _mapping(parsed, mapping)
    events, skipped, assumed = _convert(parsed, m)

    sev_col = m.columns.get("severity")
    severity_values: list[dict[str, Any]] = []
    if sev_col:
        counts = Counter(str(r.get(sev_col)) for r in parsed.records if r.get(sev_col) not in (None, ""))
        mapper = _mapper(m, parsed)
        severity_values = [{"value": v, "count": n, "level": mapper.normalize(v)} for v, n in counts.most_common(SEVERITY_VALUES_SHOWN)]

    return {
        "filename": filename,
        "format": parsed.format,
        "truncated": parsed.truncated,
        "total_rows": len(parsed.records),
        "columns": columns_of(parsed.records),
        "detected": detected,
        "mapping": m.model_dump(),
        "severity_values": severity_values,
        "severity_presets": {k: label for k, (label, _) in PRESETS.items()},
        "levels": scale.public(),
        "home": home,
        "stats": {
            "usable": len(events),
            "skipped": dict(skipped),
            "home_assumed": assumed,
            "by_severity": dict(Counter(e.severity for e in events)),
        },
        "sample": [
            {
                "src_ip": e.src_ip, "dst_ip": e.dst_ip, "severity": e.severity, "signature": e.signature,
                "src": [e.src_lat, e.src_lon], "dst": [e.dst_lat, e.dst_lon], "note": e.geo_note,
            }
            for e in events[:SAMPLE_ROWS]
        ],
    }


@router.post("/load")
async def load(file: UploadFile, mapping: str = Form(...)) -> dict[str, Any]:
    parsed, filename = await _read(file)
    m, _ = _mapping(parsed, mapping)
    events, skipped, assumed = _convert(parsed, m)
    if not events:
        raise HTTPException(
            400,
            "None of the rows had a usable location. Check the location columns in the mapping "
            "(a location of exactly 0,0 is treated as missing).",
        )
    csv_source.load_events(events)
    status.csv_loaded(len(events), filename)
    return {"rows": len(events), "filename": filename, "skipped": dict(skipped), "home_assumed": assumed}
