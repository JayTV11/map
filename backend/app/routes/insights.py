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


@router.get("/source-dossier")
async def get_source_dossier(response: Response, ip: str = Query(..., max_length=45), hours: int = Query(24, ge=1, le=72)):
    """Everything one source has done, plus its place in the response (containment tracker)."""
    response.headers["Cache-Control"] = "no-store"
    if not _IP.match(ip):
        raise HTTPException(status_code=400, detail="not an IP address")
    for name in ("live", "simulated"):
        d = insights.pick(name)[1].dossier(ip, hours)
        if d is not None:
            return {"source": name, "dossier": d}
    return {"source": None, "dossier": None}


@router.get("/campaigns")
async def get_campaigns(response: Response, minutes: int = Query(60, ge=5, le=180), source: str = Query("auto", pattern="^(auto|live|simulated)$")):
    """Activity that looks coordinated (one source sweeping many targets, or many sources hitting one)."""
    response.headers["Cache-Control"] = "no-store"
    name, store = insights.pick(source)
    return {"source": name, **store.campaigns(minutes, scale.ids())}
