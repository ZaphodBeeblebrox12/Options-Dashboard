"""WebSocket connection manager for broadcasting live data."""
from typing import List, Dict
from fastapi import WebSocket
import json
import asyncio


class ConnectionManager:
    """Manages WebSocket connections and broadcasts messages.

    FIXED: Properly closes dead WebSocket connections without creating
    unhandled task exceptions.
    """

    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        """Remove connection from list. Don't try to close an already-dead socket."""
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        # Do NOT call websocket.close() here — if the client already disconnected,
        # close() throws WebSocketDisconnect which becomes an unhandled exception.
        # Uvicorn cleans up the underlying TCP socket automatically.

    async def broadcast(self, message: dict):
        """Broadcast a message to all connected clients."""
        if not self.active_connections:
            return

        json_msg = json.dumps(message)
        disconnected = []

        for connection in self.active_connections:
            try:
                await connection.send_text(json_msg)
            except Exception:
                disconnected.append(connection)

        # Clean up disconnected clients
        for conn in disconnected:
            self.disconnect(conn)

    async def send_personal_message(self, message: dict, websocket: WebSocket):
        """Send a message to a specific client."""
        try:
            await websocket.send_text(json.dumps(message))
        except Exception:
            self.disconnect(websocket)


manager = ConnectionManager()
