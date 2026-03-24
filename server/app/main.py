import os
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.database import add_or_increment_item, connect_db, close_db, get_inventory_collection, get_item_observations
from app.processing import process_frame
from app.stream_consumer import stream_consumer
from app.audio_router import router as audio_router
from app.stream_router import router as stream_router

UPLOADS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "uploads")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await connect_db()
    yield
    await stream_consumer.stop()
    await close_db()


app = FastAPI(title="Autonomous Inventory API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(audio_router)
app.include_router(stream_router)
app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")


class Item(BaseModel):
    id: Optional[int] = None
    name: str
    description: str = ""
    quantity: int = 0


class InventoryUpdate(BaseModel):
    name: str
    count: int = 1
    confidence_level: Optional[int] = None
    explanation: Optional[str] = None


# In-memory placeholder list
items: list[Item] = []


@app.get("/")
def root():
    return {"message": "Autonomous Inventory API"}


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.get("/api/items")
def get_items():
    return items


@app.post("/api/items")
def create_item(item: Item):
    items.append(item)
    return item


@app.post("/api/inventory")
async def update_inventory(update: InventoryUpdate):
    """Add a new item to inventory count or increment an existing item's count."""
    result = await add_or_increment_item(
        update.name, update.count, update.confidence_level, update.explanation,
    )
    return result


@app.get("/api/inventory")
async def get_inventory():
    """Get all inventory counts."""
    collection = get_inventory_collection()
    cursor = collection.find({}, {"_id": 0, "name": 1, "count": 1, "confidence_level": 1, "explanation": 1})
    return await cursor.to_list(length=None)


@app.get("/api/inventory/{name}/observations")
async def get_observations(name: str):
    """Get the observation history for an item, including past explanations and image references."""
    observations = await get_item_observations(name)
    return {"name": name, "observations": observations}


@app.post("/api/inventory/frame")
async def process_single_frame(file: UploadFile):
    """Accept a single image frame, run it through the VLM, and update inventory counts."""
    image_bytes = await file.read()
    results = await process_frame(image_bytes)
    return {"items_updated": results}


TEST_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "test")
os.makedirs(TEST_DIR, exist_ok=True)

_frame_counter = 0


@app.websocket("/ws/video-stream")
async def video_stream(websocket: WebSocket):
    """Stream video frames over WebSocket.

    Client sends raw image bytes per message.
    Each frame is saved to server/test/ for inspection.
    Server responds with updated inventory counts per frame.
    """
    global _frame_counter
    await websocket.accept()
    try:
        while True:
            image_bytes = await websocket.receive_bytes()

            # Save frame to test/ directory
            _frame_counter += 1
            frame_path = os.path.join(TEST_DIR, f"frame_{_frame_counter:05d}.jpg")
            with open(frame_path, "wb") as f:
                f.write(image_bytes)

            results = await process_frame(image_bytes)
            await websocket.send_json({"items_updated": results})
    except WebSocketDisconnect:
        pass
