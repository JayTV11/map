from fastapi import APIRouter, HTTPException, UploadFile

from ..sources.csv_source import csv_source
from ..status import status

router = APIRouter(prefix="/api", tags=["upload"])


@router.post("/upload")
async def upload_csv(file: UploadFile):
    raw = await file.read()
    try:
        row_count = csv_source.load(raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    status.csv_loaded(row_count, file.filename)
    return {"rows": row_count, "filename": file.filename}


@router.delete("/upload")
async def clear_csv():
    """Stops the simulated feed -- e.g. to go from a demo back to live data
    without restarting the server."""
    csv_source.unload()
    status.csv_cleared()
    return {"rows": 0}
