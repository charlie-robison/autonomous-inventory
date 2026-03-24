import os
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.database import (
    add_or_increment_item,
    close_db,
    connect_db,
    create_pallet,
    create_vehicle,
    create_warehouse,
    get_all_pallets,
    get_all_vehicles,
    get_all_warehouses,
    get_inventory_collection,
    get_item_observations,
    get_pallet,
)
from app.load_pipeline import load_pallet
from app.mode_selection import get_current_mode, select_mode
from app.processing import process_frame
from app.receive_pipeline import receive_pallet
from app.stream_consumer import stream_consumer
from app.audio_router import router as audio_router
from app.stream_router import router as stream_router

UPLOADS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "uploads")
FRONTEND_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "frontend", "out"
)


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
    if os.path.isdir(FRONTEND_DIR):
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))
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


# ---------------------------------------------------------------------------
# Mode selection
# ---------------------------------------------------------------------------

class ModeRequest(BaseModel):
    text: str


@app.post("/api/mode/select")
async def api_select_mode(req: ModeRequest):
    """Parse a mode from transcribed speech and set it as the current session mode."""
    return await select_mode(req.text)


@app.get("/api/mode")
async def api_get_mode():
    """Return the current session mode."""
    mode = await get_current_mode()
    return {"current_mode": mode}


# ---------------------------------------------------------------------------
# Vehicles
# ---------------------------------------------------------------------------

class VehicleCreate(BaseModel):
    name: str


@app.post("/api/vehicles")
async def api_create_vehicle(body: VehicleCreate):
    return await create_vehicle(body.name)


@app.get("/api/vehicles")
async def api_get_vehicles():
    return await get_all_vehicles()


# ---------------------------------------------------------------------------
# Warehouses
# ---------------------------------------------------------------------------

class WarehouseCreate(BaseModel):
    name: str


@app.post("/api/warehouses")
async def api_create_warehouse(body: WarehouseCreate):
    return await create_warehouse(body.name)


@app.get("/api/warehouses")
async def api_get_warehouses():
    return await get_all_warehouses()


# ---------------------------------------------------------------------------
# Pallets
# ---------------------------------------------------------------------------

class PalletCreate(BaseModel):
    name: str
    status: str = "on_port"
    warehouse_fk: Optional[str] = None
    vehicle_fk: Optional[str] = None


class ReceivePalletRequest(BaseModel):
    pallet_id: str  # pallet name from QR code (e.g. "H123")
    lat: float
    lon: float


class LoadPalletRequest(BaseModel):
    pallet_id: str  # pallet name from QR code (e.g. "H123")
    vehicle_name: str


@app.post("/api/pallets")
async def api_create_pallet(body: PalletCreate):
    return await create_pallet(name=body.name, status=body.status, warehouse_fk=body.warehouse_fk, vehicle_fk=body.vehicle_fk)


@app.get("/api/pallets")
async def api_get_pallets():
    return await get_all_pallets()


@app.get("/api/pallets/{pallet_id}")
async def api_get_pallet(pallet_id: str):
    pallet = await get_pallet(pallet_id)
    if pallet is None:
        return {"error": "Pallet not found"}
    return pallet


@app.post("/api/pallets/receive")
async def api_receive_pallet(body: ReceivePalletRequest):
    """Receive pipeline: mark a pallet as received at a warehouse based on geo coordinates."""
    try:
        return await receive_pallet(body.pallet_id, body.lat, body.lon)
    except ValueError as e:
        return {"error": str(e)}


@app.post("/api/pallets/load")
async def api_load_pallet(body: LoadPalletRequest):
    """Load pipeline: mark a pallet as loaded onto a vehicle/truck."""
    try:
        return await load_pallet(body.pallet_id, body.vehicle_name)
    except ValueError as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# Serve the Next.js static export (must be after all API/WS routes)
# ---------------------------------------------------------------------------

if os.path.isdir(FRONTEND_DIR):
    # Serve known sub-pages as HTML
    @app.get("/inventory")
    async def _inventory_page():
        return FileResponse(os.path.join(FRONTEND_DIR, "inventory.html"))

    @app.get("/stream")
    async def _stream_page():
        return FileResponse(os.path.join(FRONTEND_DIR, "stream.html"))

    # Serve static assets (_next/*, etc.)
    app.mount("/_next", StaticFiles(directory=os.path.join(FRONTEND_DIR, "_next")), name="frontend_next")

    # Catch-all: serve index.html for the root and any unknown paths (SPA fallback)
    @app.get("/{full_path:path}")
    async def _spa_fallback(request: Request, full_path: str):
        # Try exact file first
        file_path = os.path.join(FRONTEND_DIR, full_path)
        if os.path.isfile(file_path):
            return FileResponse(file_path)
        # Fallback to index.html
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))
