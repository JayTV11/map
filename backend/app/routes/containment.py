from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from ..containment import STATUSES, ContainmentRefused, containment, settings

router = APIRouter(prefix="/api", tags=["containment"])


def _who(request: Request) -> str:
    cfg = settings()
    if not cfg["enabled"]:
        raise HTTPException(403, "The containment tracker is turned off (containment: enabled: false in config.yaml).")
    if request.headers.get("x-sightline-edit") != "1":
        raise HTTPException(403, "Edit requests must come from the Sightline page.")
    if cfg["user_header"]:
        user = request.headers.get(cfg["user_header"], "").strip()
        if not user:
            raise HTTPException(401, "Sign-in required.")
        return user[:80]
    return "unknown (no user header configured)"


@router.get("/containment")
async def get_containment(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return {"enabled": settings()["enabled"], "statuses": list(STATUSES), "entries": containment.entries()}


class SetBody(BaseModel):
    ip: str = Field(max_length=64)
    status: str = Field(max_length=30)
    note: str = Field(default="", max_length=300)


@router.put("/containment")
async def set_containment(body: SetBody, request: Request):
    user = _who(request)
    try:
        return containment.set(body.ip, body.status, body.note, user)
    except ContainmentRefused as exc:
        raise HTTPException(400, str(exc)) from None


@router.delete("/containment")
async def clear_containment(request: Request, ip: Optional[str] = None):
    user = _who(request)
    try:
        containment.clear(ip or "", user)
    except ContainmentRefused as exc:
        raise HTTPException(400, str(exc)) from None
    return {"cleared": ip}
