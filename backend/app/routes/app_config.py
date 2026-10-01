from fastapi import APIRouter, Response

from ..settings import home, scale

router = APIRouter(prefix="/api", tags=["config"])


@router.get("/config")
async def get_config(response: Response):
    """What the frontend needs to draw itself: the severity scale and the home site."""
    response.headers["Cache-Control"] = "no-store"
    return {"severity": scale.public(), "home": home}
