"""Read-only questions about what has been seen: signature notes, one source's history, the shift summary."""
from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException, Query, Response

from .. import insights
from ..settings import scale
from ..signature_notes import signature_notes

router = APIRouter(prefix="/api", tags=["insights"])
_IP = re.compile(r"^[0-9a-fA-F:.]{2,45}$")


@router.get("/signature-notes")
async def get_signature_notes(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return {"notes": signature_notes.entries()}


@router.get("/source-history")
async def get_source_history(response: Response, ip: str = Query(..., max_length=45)):
    response.headers["Cache-Control"] = "no-store"
    if not _IP.match(ip):
        raise HTTPException(status_code=400, detail="not an IP address")
    live = insights.pick("live")[1].source_history(ip)
    if live is not None:
        return {"source": "live", "history": live}
    sim = insights.pick("simulated")[1].source_history(ip)
    return {"source": "simulated" if sim else None, "history": sim}


@router.get("/summary")
async def get_summary(response: Response, hours: int = Query(8, ge=1, le=72), source: str = Query("auto", pattern="^(auto|live|simulated)$")):
    response.headers["Cache-Control"] = "no-store"
    name, store = insights.pick(source)
    return {"source": name, **store.summary(hours, scale.ids())}
