from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..broadcast import broadcaster

router = APIRouter()


@router.websocket("/ws")
async def traffic_ws(websocket: WebSocket):
    await broadcaster.connect(websocket)
    try:
        while True:
            await websocket.receive_text()  # frontend doesn't send anything meaningful; just keeps the socket open
    except WebSocketDisconnect:
        broadcaster.disconnect(websocket)
