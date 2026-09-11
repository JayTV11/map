from fastapi import APIRouter
from pydantic import BaseModel

from ..sources.csv_source import csv_source

router = APIRouter(prefix="/api/controls", tags=["controls"])


class IntensityBody(BaseModel):
    intensity: int


@router.post("/intensity")
async def set_intensity(body: IntensityBody):
    csv_source.set_intensity(body.intensity)
    return {"intensity": body.intensity}

# Live on/off and severity filtering are handled client-side (see
# frontend/src/controls.ts) since they only affect rendering, not
# ingestion -- no backend state needed for them.
