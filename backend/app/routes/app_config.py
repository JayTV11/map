from fastapi import APIRouter, Response

from ..settings import home, scale, threat_level

router = APIRouter(prefix="/api", tags=["config"])


@router.get("/config")
async def get_config(response: Response):
    """What the frontend needs to draw itself: the severity scale, the home site, and (optionally) the threat-level thresholds."""
    response.headers["Cache-Control"] = "no-store"
    return {"severity": scale.public(), "home": home, "threat_level": threat_level}
