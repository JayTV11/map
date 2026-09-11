"""Entrypoint FastAPI app: serves the built frontend, the upload/control
REST routes, and the WebSocket both ingestion sources broadcast onto.

Run with `python run.py` from the backend/ directory (see README).
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .broadcast import broadcaster
from .config import config
from .routes import controls, upload, ws
from .sources.csv_source import csv_source
from .sources.elastic_source import ElasticPollSource

FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"

_background_tasks: list[asyncio.Task] = []


@asynccontextmanager
async def lifespan(app: FastAPI):
    # CSV source always runs -- idle (no rows loaded) until POST /api/upload
    _background_tasks.append(asyncio.create_task(csv_source.run(broadcaster.publish)))

    # Elastic source only if hosts are configured in config.yaml
    if config.get("elastic", {}).get("hosts"):
        elastic_source = ElasticPollSource(config["elastic"])
        _background_tasks.append(asyncio.create_task(elastic_source.run(broadcaster.publish)))

    # Keeps the map visually alive on sparse real Elastic traffic by
    # re-firing recent buffered hits -- see buffer.replay_enabled in
    # config.yaml and Broadcaster._replay_loop in broadcast.py.
    replay_task = broadcaster.start_replay_loop()
    if replay_task:
        _background_tasks.append(replay_task)

    yield

    for task in _background_tasks:
        task.cancel()


app = FastAPI(title="Traffic Map", lifespan=lifespan)

app.include_router(upload.router)
app.include_router(controls.router)
app.include_router(ws.router)

if FRONTEND_DIST.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIST), html=True), name="frontend")