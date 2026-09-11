from fastapi import APIRouter, HTTPException, UploadFile

from ..sources.csv_source import csv_source

router = APIRouter(prefix="/api", tags=["upload"])


@router.post("/upload")
async def upload_csv(file: UploadFile):
    raw = await file.read()
    try:
        row_count = csv_source.load(raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"rows": row_count, "filename": file.filename}
