import base64
import json
import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import database
from .gemini_service import analyze_frame
from .qr_service import decode_qr
from app.audio_router import router as audio_router
from app.stream_router import router as stream_router

load_dotenv()

UPLOADS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "uploads")
FRONTEND_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "frontend", "out"
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    database.init_db()
    yield


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


# ---------- Health ----------


@app.get("/")
def root():
    if os.path.isdir(FRONTEND_DIR):
        return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))
    return {"message": "Autonomous Inventory API"}


@app.get("/health")
def health_check():
    return {"status": "ok"}


# ---------- App Mode ----------


class ModeRequest(BaseModel):
    mode: str


@app.get("/api/mode")
def get_mode():
    return {"mode": database.get_current_mode()}


@app.post("/api/mode")
def set_mode(req: ModeRequest):
    result = database.set_current_mode(req.mode)
    if not result:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid mode. Must be one of: {', '.join(database.VALID_MODES)}",
        )
    return {"mode": result}


# ---------- Warehouses ----------


@app.get("/api/warehouses")
def get_warehouses():
    return database.get_warehouses()


# ---------- Vehicles ----------


@app.get("/api/vehicles")
def get_vehicles():
    return database.get_vehicles()


# ---------- Pallets ----------


class ReceiveRequest(BaseModel):
    lat: float
    lng: float


class LoadRequest(BaseModel):
    vehicle_name: str


@app.get("/api/pallets")
def get_pallets(status: str | None = None):
    return database.get_pallets(status)


@app.get("/api/pallets/{pallet_id}")
def get_pallet(pallet_id: str):
    pallet = database.get_pallet(pallet_id)
    if not pallet:
        raise HTTPException(status_code=404, detail="Pallet not found")
    return pallet


@app.post("/api/pallets/{pallet_id}/receive")
def receive_pallet(pallet_id: str, req: ReceiveRequest):
    """Set pallet to received. Uses geo coordinates to find nearest warehouse."""
    from datetime import datetime, timezone

    warehouse = database.get_nearest_warehouse(req.lat, req.lng)
    if not warehouse:
        raise HTTPException(status_code=400, detail="No warehouses configured")

    database.receive_pallet(pallet_id, warehouse["id"])
    database.log_activity(
        "pallet_received",
        json.dumps({
            "pallet_id": pallet_id,
            "warehouse": warehouse["name"],
            "lat": req.lat,
            "lng": req.lng,
        }),
    )

    return {
        "pallet_id": pallet_id,
        "action": "receive",
        "status": "received",
        "warehouse_fk": f"WH-{warehouse['name'].upper().replace(' ', '-')}-{warehouse['id']:03d}",
        "vehicle_fk": None,
        "geo": {"lat": req.lat, "lng": req.lng},
        "island": warehouse["name"],
        "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


@app.post("/api/pallets/{pallet_id}/load")
def load_pallet(pallet_id: str, req: LoadRequest):
    """Set pallet to loaded. Looks up or creates the vehicle."""
    from datetime import datetime, timezone

    vehicle = database.get_or_create_vehicle(req.vehicle_name)
    database.load_pallet(pallet_id, vehicle["id"])
    database.log_activity(
        "pallet_loaded",
        json.dumps({
            "pallet_id": pallet_id,
            "vehicle": vehicle["name"],
            "vehicle_id": vehicle["id"],
        }),
    )

    return {
        "pallet_id": pallet_id,
        "action": "load",
        "status": "loaded",
        "warehouse_fk": None,
        "vehicle_fk": f"VH-{vehicle['id']:04d}",
        "vehicle_num": vehicle["name"],
        "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


# ---------- Items ----------


class DepthRequest(BaseModel):
    depth: int


@app.get("/api/items")
def get_items():
    return database.get_items()


@app.post("/api/items/{item_id}/depth")
def set_item_depth(item_id: int, req: DepthRequest):
    if req.depth < 1:
        raise HTTPException(status_code=400, detail="Depth must be at least 1")
    result = database.set_item_depth(item_id, req.depth)
    if not result:
        raise HTTPException(status_code=404, detail="Item not found")
    return result


# ---------- Shelf Depths ----------


class ShelfDepthRequest(BaseModel):
    product_name: str
    depth: int


@app.get("/api/shelf-depths")
def get_shelf_depths():
    return database.get_shelf_depths()


@app.post("/api/shelf-depths")
def set_shelf_depth(req: ShelfDepthRequest):
    if req.depth < 1:
        raise HTTPException(status_code=400, detail="Depth must be at least 1")
    return database.set_shelf_depth(req.product_name, req.depth)


# ---------- Activity Log ----------


@app.get("/api/activity")
def get_activity(limit: int = 50):
    return database.get_activity_log(limit)


@app.post("/api/activity/{activity_id}/approve")
def approve_activity(activity_id: int):
    database.approve_activity(activity_id)
    return {"status": "approved", "id": activity_id}


@app.post("/api/activity/{activity_id}/dismiss")
def dismiss_activity(activity_id: int):
    database.dismiss_activity(activity_id)
    return {"status": "dismissed", "id": activity_id}


# ---------- Frame Analysis ----------


class FrameRequest(BaseModel):
    image: str  # base64-encoded JPEG


@app.post("/api/scan-qr")
def scan_qr(req: FrameRequest):
    """Decode QR codes from a frame using qreader. No VLM involved."""
    try:
        image_bytes = base64.b64decode(req.image)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 image data")

    qr_codes = decode_qr(image_bytes)
    return {"qr_codes": qr_codes}


@app.post("/api/read")
async def read_frame(req: FrameRequest):
    """Process a single frame with VLM (count mode or load vehicle detection)."""
    try:
        image_bytes = base64.b64decode(req.image)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 image data")

    mode = database.get_current_mode()
    try:
        parsed, raw_text = await analyze_frame(image_bytes, mode)
    except Exception as e:
        raw_text = f"Gemini error: {e}"
        if mode == "load":
            parsed = {"vehicle_numbers": []}
        else:
            parsed = []

    if mode == "load":
        if isinstance(parsed, dict):
            vehicle_numbers = parsed.get("vehicle_numbers", [])
        else:
            vehicle_numbers = []
        return {
            "mode": "load",
            "vehicle_numbers": vehicle_numbers,
            "raw_response": raw_text,
        }

    # Count mode
    items_result = _process_count_items(parsed if isinstance(parsed, list) else [])
    return {
        "mode": "count",
        "items": items_result,
        "raw_response": raw_text,
    }


# ---------- WebSocket Stream ----------


@app.websocket("/ws/stream")
async def stream_endpoint(websocket: WebSocket):
    await websocket.accept()
    busy = False

    try:
        while True:
            data = await websocket.receive_text()

            if busy:
                continue

            busy = True
            try:
                if "," in data:
                    data = data.split(",", 1)[1]

                image_bytes = base64.b64decode(data)
                mode = database.get_current_mode()

                if mode in ("receive", "load"):
                    # QR decode only — no VLM
                    qr_codes = decode_qr(image_bytes)
                    await websocket.send_json({
                        "mode": mode,
                        "qr_codes": qr_codes,
                    })
                else:
                    # Count mode — use VLM
                    parsed, raw_text = await analyze_frame(image_bytes, mode)
                    items_result = _process_count_items(
                        parsed if isinstance(parsed, list) else []
                    )
                    await websocket.send_json({
                        "mode": "count",
                        "items": items_result,
                        "raw_response": raw_text,
                    })
            except Exception as e:
                await websocket.send_json({"error": str(e)})
            finally:
                busy = False
    except WebSocketDisconnect:
        pass


# ---------- Helpers ----------


def _process_count_items(raw_items: list[dict]) -> list[dict]:
    """Store each counted item via upsert and return results.

    Uses shelf_label_text as the dedup key so the same price tag
    seen across multiple frames is updated rather than duplicated.
    """
    results = []

    for item in raw_items:
        shelf_label = item.get("shelf_label_text", "")
        if not shelf_label:
            continue

        confidence = item.get("confidence", 0.0)
        if confidence < 0.3:
            continue

        facing_count = item.get("facing_count", 0)
        product_name = item.get("product_name", shelf_label)
        price = item.get("price")
        shelf_position = item.get("shelf_position", "")

        item_id, was_updated = database.upsert_item(
            shelf_label_text=shelf_label,
            product_name=product_name,
            facing_count=facing_count,
            price=price,
            confidence=confidence,
            shelf_position=shelf_position,
        )

        # Fetch the stored item to get the depth (may be from shelf_depths lookup)
        stored = database.get_item(item_id)
        depth = stored["depth"] if stored else 1

        results.append({
            "id": item_id,
            "shelf_label_text": shelf_label,
            "product_name": product_name,
            "facing_count": facing_count,
            "depth": depth,
            "price": price,
            "confidence": confidence,
            "shelf_position": shelf_position,
            "updated": was_updated,
        })

    if results:
        database.log_activity(
            "items_counted",
            json.dumps({"item_count": len(results)}),
        )

    return results


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
