from fastapi import APIRouter, Response

from ..known_good import known_good

router = APIRouter(prefix="/api", tags=["known-good"])


@router.get("/known-good")
async def get_known_good(response: Response):
    """The known-good source list the browser mutes against.

    Not cached: an edit to known_good.yaml should reach the wall within a
    minute (the page re-reads this on a timer), not whenever a cache expires.
    """
    response.headers["Cache-Control"] = "no-store"
    return {"entries": known_good.entries(), **known_good.info()}
