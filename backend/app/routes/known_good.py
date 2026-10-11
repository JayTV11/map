from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from ..known_good import EditRefused, _kg_settings, known_good

router = APIRouter(prefix="/api", tags=["known-good"])


@router.get("/known-good")
async def get_known_good(response: Response):
    """The known-good source list the browser mutes against.

    Not cached: an edit to known_good.yaml should reach the wall within a
    minute (the page re-reads this on a timer), not whenever a cache expires.
    """
    response.headers["Cache-Control"] = "no-store"
    return {"entries": known_good.entries(), "editable": _kg_settings()["editable"], **known_good.info()}


class AddBody(BaseModel):
    ip: str = Field(max_length=64)
    note: str = Field(default="", max_length=200)


def _who(request: Request) -> str:
    """Checks editing is allowed and returns who is doing it.

    Off by default. When a user header is configured (the SSO proxy sets it), a request without it is
    refused, so only people who came through SSO can edit. The custom header requirement also stops a
    web page on another site from making a logged-in analyst's browser edit the list."""
    cfg = _kg_settings()
    if not cfg["editable"]:
        raise HTTPException(403, "Editing the known-good list from the screen is turned off. An admin can turn it on (known_good: editable: true in config.yaml).")
    if request.headers.get("x-sightline-edit") != "1":
        raise HTTPException(403, "Edit requests must come from the Sightline page.")
    if cfg["user_header"]:
        user = request.headers.get(cfg["user_header"], "").strip()
        if not user:
            raise HTTPException(401, "Sign-in required to edit the list.")
        return user[:80]
    return "unknown (no user header configured)"


@router.post("/known-good")
async def add_known_good(body: AddBody, request: Request):
    user = _who(request)
    try:
        return known_good.add(body.ip, body.note, user)
    except EditRefused as exc:
        raise HTTPException(400, str(exc)) from None


@router.delete("/known-good")
async def remove_known_good(request: Request, cidr: str):
    user = _who(request)
    try:
        known_good.remove(cidr, user)
    except EditRefused as exc:
        raise HTTPException(400, str(exc)) from None
    return {"removed": cidr}
