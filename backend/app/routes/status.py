from fastapi import APIRouter, Response

from ..assets import directory
from ..config import config
from ..known_good import known_good
from ..status import status

router = APIRouter(prefix="/api", tags=["status"])


@router.get("/status")
async def get_status(response: Response):
    # Never cached: a stale "all healthy" answer is worse than no answer.
    response.headers["Cache-Control"] = "no-store"
    snap = status.snapshot(
        poll_interval_seconds=config.get("elastic", {}).get("poll_interval_seconds", 3),
        buffer_cfg=config.get("buffer", {}),
    )
    snap["assets"] = directory.info()
    snap["known_good"] = known_good.info()
    return snap
