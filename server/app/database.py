import json
import os
from datetime import datetime, timezone
from pathlib import Path

from bson import ObjectId
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
MONGODB_DB_NAME = os.getenv("MONGODB_DB_NAME", "autonomous_inventory")

SHELF_DEPTHS_PATH = Path(__file__).parent.parent / "shelf_depths.json"

VALID_PALLET_STATUSES = ("on_boat", "at_port", "received", "loaded")
VALID_MODES = ("count", "receive", "load")

# Hawaiian island warehouse coordinates for geo lookup
WAREHOUSE_COORDS = {
    "Oahu": (21.4389, -158.0001),
    "Maui": (20.7984, -156.3319),
    "Big Island": (19.7241, -155.4315),
    "Kauai": (22.0964, -159.5261),
    "Molokai": (21.1333, -157.0167),
    "Lanai": (20.8333, -156.9167),
}

client: AsyncIOMotorClient = None
db = None


async def connect_db():
    global client, db
    client = AsyncIOMotorClient(MONGODB_URI)
    db = client[MONGODB_DB_NAME]


async def close_db():
    global client
    if client:
        client.close()


async def init_db():
    """Connect and seed the database with initial data."""
    await connect_db()

    # Seed Hawaiian island warehouses
    warehouses_col = db["warehouses"]
    for name in WAREHOUSE_COORDS:
        await warehouses_col.update_one(
            {"name": name},
            {"$setOnInsert": {"name": name, "created_at": datetime.now(timezone.utc)}},
            upsert=True,
        )

    # Seed default mode
    mode_col = db["app_mode"]
    existing = await mode_col.find_one({})
    if not existing:
        await mode_col.insert_one(
            {"current_mode": "receive", "updated_at": datetime.now(timezone.utc)}
        )

    # Seed shelf depths from JSON file
    if SHELF_DEPTHS_PATH.exists():
        shelf_col = db["shelf_depths"]
        shelf_data = json.loads(SHELF_DEPTHS_PATH.read_text())
        for entry in shelf_data:
            await shelf_col.update_one(
                {"product_name": entry["product_name"]},
                {"$setOnInsert": {
                    "product_name": entry["product_name"],
                    "depth": entry["depth"],
                }},
                upsert=True,
            )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _serialize(doc: dict) -> dict:
    """Convert MongoDB document to JSON-safe dict (ObjectId -> str)."""
    if doc is None:
        return None
    doc = dict(doc)
    if "_id" in doc:
        doc["id"] = str(doc.pop("_id"))
    return doc


# ---------------------------------------------------------------------------
# Collection accessors
# ---------------------------------------------------------------------------

def get_inventory_collection():
    return db["inventory"]


def get_vehicles_collection():
    return db["vehicles"]


def get_warehouses_collection():
    return db["warehouses"]


def get_pallets_collection():
    return db["pallets"]


def get_app_mode_collection():
    return db["app_mode"]


def get_items_collection():
    return db["items"]


def get_shelf_depths_collection():
    return db["shelf_depths"]


def get_activity_log_collection():
    return db["activity_log"]


# ---------------------------------------------------------------------------
# Inventory (original HEAD collection — used by processing.py)
# ---------------------------------------------------------------------------

async def add_or_increment_item(
    name: str,
    count: int = 1,
    confidence_level: int | None = None,
    explanation: str | None = None,
    image_path: str | None = None,
) -> dict:
    """Add a new item to inventory or increment its count if it already exists."""
    collection = get_inventory_collection()
    update: dict = {"$inc": {"count": count}}

    set_fields = {}
    if confidence_level is not None:
        set_fields["confidence_level"] = confidence_level
    if explanation is not None:
        set_fields["explanation"] = explanation
    if set_fields:
        update["$set"] = set_fields

    observation = {"timestamp": datetime.now(timezone.utc), "count": count}
    if confidence_level is not None:
        observation["confidence_level"] = confidence_level
    if explanation is not None:
        observation["explanation"] = explanation
    if image_path is not None:
        observation["image_path"] = image_path
    update["$push"] = {"observations": observation}

    result = await collection.find_one_and_update(
        {"name": name}, update, upsert=True, return_document=True,
    )
    return {
        "name": result["name"],
        "count": result["count"],
        "confidence_level": result.get("confidence_level"),
        "explanation": result.get("explanation"),
    }


async def get_item_observations(name: str) -> list[dict]:
    """Return the observation history for a given item."""
    collection = get_inventory_collection()
    doc = await collection.find_one({"name": name}, {"_id": 0, "observations": 1})
    if not doc:
        return []
    return doc.get("observations", [])


# ---------------------------------------------------------------------------
# App Mode
# ---------------------------------------------------------------------------

async def get_current_mode() -> str:
    collection = get_app_mode_collection()
    doc = await collection.find_one({}, {"_id": 0, "current_mode": 1})
    if not doc:
        return "receive"
    return doc.get("current_mode", "receive")


# Alias for mode_selection.py
async def get_app_mode() -> str:
    return await get_current_mode()


async def set_current_mode(mode: str) -> str | None:
    """Set mode, returns the mode string or None if invalid."""
    if mode not in VALID_MODES:
        return None
    collection = get_app_mode_collection()
    await collection.find_one_and_update(
        {},
        {"$set": {"current_mode": mode, "updated_at": datetime.now(timezone.utc)}},
        upsert=True,
    )
    return mode


async def set_app_mode(mode: str) -> dict:
    """Set mode, returns full document. Used by mode_selection.py."""
    mode = mode.lower()
    if mode not in VALID_MODES:
        raise ValueError(f"Invalid mode '{mode}'. Must be one of {VALID_MODES}")
    collection = get_app_mode_collection()
    result = await collection.find_one_and_update(
        {},
        {"$set": {"current_mode": mode, "updated_at": datetime.now(timezone.utc)}},
        upsert=True,
        return_document=True,
    )
    return {"current_mode": result["current_mode"], "updated_at": result["updated_at"]}


# ---------------------------------------------------------------------------
# Warehouses
# ---------------------------------------------------------------------------

async def get_warehouses() -> list[dict]:
    collection = get_warehouses_collection()
    cursor = collection.find({}).sort("name", 1)
    return [_serialize(doc) async for doc in cursor]


async def get_all_warehouses() -> list[dict]:
    return await get_warehouses()


async def create_warehouse(name: str) -> dict:
    collection = get_warehouses_collection()
    doc = {"name": name, "created_at": datetime.now(timezone.utc)}
    result = await collection.insert_one(doc)
    doc["_id"] = result.inserted_id
    return _serialize(doc)


async def get_warehouse_by_id(warehouse_id: str) -> dict | None:
    collection = get_warehouses_collection()
    doc = await collection.find_one({"_id": ObjectId(warehouse_id)})
    return _serialize(doc) if doc else None


async def get_warehouse_by_name(name: str) -> dict | None:
    collection = get_warehouses_collection()
    doc = await collection.find_one({"name": {"$regex": f"^{name}$", "$options": "i"}})
    return _serialize(doc) if doc else None


async def get_nearest_warehouse(lat: float, lng: float) -> dict | None:
    """Find the nearest Hawaiian island warehouse by coordinates."""
    warehouses = await get_warehouses()
    if not warehouses:
        return None

    best = None
    best_dist = float("inf")
    for wh in warehouses:
        coords = WAREHOUSE_COORDS.get(wh["name"])
        if not coords:
            continue
        dist = (lat - coords[0]) ** 2 + (lng - coords[1]) ** 2
        if dist < best_dist:
            best_dist = dist
            best = wh

    return best


# ---------------------------------------------------------------------------
# Vehicles
# ---------------------------------------------------------------------------

async def get_vehicles() -> list[dict]:
    collection = get_vehicles_collection()
    cursor = collection.find({}).sort("name", 1)
    return [_serialize(doc) async for doc in cursor]


async def get_all_vehicles() -> list[dict]:
    return await get_vehicles()


async def create_vehicle(name: str) -> dict:
    collection = get_vehicles_collection()
    doc = {"name": name, "created_at": datetime.now(timezone.utc)}
    result = await collection.insert_one(doc)
    doc["_id"] = result.inserted_id
    return _serialize(doc)


async def get_vehicle_by_id(vehicle_id: str) -> dict | None:
    collection = get_vehicles_collection()
    doc = await collection.find_one({"_id": ObjectId(vehicle_id)})
    return _serialize(doc) if doc else None


async def get_vehicle_by_name(name: str) -> dict | None:
    collection = get_vehicles_collection()
    doc = await collection.find_one({"name": {"$regex": f"^{name}$", "$options": "i"}})
    return _serialize(doc) if doc else None


async def get_or_create_vehicle(name: str) -> dict:
    vehicle = await get_vehicle_by_name(name)
    if vehicle:
        return vehicle
    return await create_vehicle(name)


# ---------------------------------------------------------------------------
# Pallets
# ---------------------------------------------------------------------------

async def create_pallet(
    name: str | None = None,
    status: str = "at_port",
    warehouse_fk: str | None = None,
    vehicle_fk: str | None = None,
) -> dict:
    if status not in VALID_PALLET_STATUSES:
        raise ValueError(f"Invalid status '{status}'. Must be one of {VALID_PALLET_STATUSES}")
    collection = get_pallets_collection()
    doc = {
        "name": name,
        "status": status,
        "warehouse_fk": warehouse_fk,
        "vehicle_fk": vehicle_fk,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    }
    result = await collection.insert_one(doc)
    doc["_id"] = result.inserted_id
    return _serialize(doc)


async def get_pallet(pallet_id: str) -> dict | None:
    """Look up a pallet by name (QR code value) or by _id."""
    collection = get_pallets_collection()
    doc = await collection.find_one({"name": pallet_id})
    if not doc:
        try:
            doc = await collection.find_one({"_id": ObjectId(pallet_id)})
        except Exception:
            pass
    return _serialize(doc) if doc else None


async def get_pallet_by_name(name: str) -> dict | None:
    collection = get_pallets_collection()
    doc = await collection.find_one({"name": {"$regex": f"^{name}$", "$options": "i"}})
    return _serialize(doc) if doc else None


async def get_or_create_pallet(name: str) -> dict:
    pallet = await get_pallet_by_name(name)
    if pallet:
        return pallet
    return await create_pallet(name=name, status="at_port")


async def update_pallet(pallet_id: str, updates: dict) -> dict | None:
    collection = get_pallets_collection()
    updates["updated_at"] = datetime.now(timezone.utc)
    doc = await collection.find_one_and_update(
        {"_id": ObjectId(pallet_id)},
        {"$set": updates},
        return_document=True,
    )
    return _serialize(doc) if doc else None


async def get_pallets(status: str | None = None) -> list[dict]:
    collection = get_pallets_collection()
    query = {"status": status} if status else {}
    cursor = collection.find(query).sort("updated_at", -1)
    pallets = []
    async for doc in cursor:
        p = _serialize(doc)
        # Resolve warehouse and vehicle names
        if p.get("warehouse_fk"):
            wh = await get_warehouse_by_id(p["warehouse_fk"])
            p["warehouse_name"] = wh["name"] if wh else None
        else:
            p["warehouse_name"] = None
        if p.get("vehicle_fk"):
            vh = await get_vehicle_by_id(p["vehicle_fk"])
            p["vehicle_name"] = vh["name"] if vh else None
        else:
            p["vehicle_name"] = None
        pallets.append(p)
    return pallets


async def get_all_pallets() -> list[dict]:
    return await get_pallets()


async def receive_pallet(pallet_id: str, warehouse_id: str) -> dict:
    """Set pallet to received, assign warehouse, clear vehicle.

    pallet_id: the QR code name (e.g. "H123").
    warehouse_id: the MongoDB ObjectId string of the warehouse.
    """
    collection = get_pallets_collection()
    now = datetime.now(timezone.utc)

    result = await collection.find_one_and_update(
        {"name": pallet_id},
        {
            "$set": {
                "status": "received",
                "warehouse_fk": warehouse_id,
                "vehicle_fk": None,
                "updated_at": now,
            },
            "$setOnInsert": {
                "name": pallet_id,
                "created_at": now,
            },
        },
        upsert=True,
        return_document=True,
    )
    return _serialize(result) or {}


async def load_pallet(pallet_id: str, vehicle_id: str) -> dict:
    """Set pallet to loaded, assign vehicle, clear warehouse.

    pallet_id: the QR code name (e.g. "H123").
    vehicle_id: the MongoDB ObjectId string of the vehicle.
    """
    collection = get_pallets_collection()
    now = datetime.now(timezone.utc)

    result = await collection.find_one_and_update(
        {"name": pallet_id},
        {
            "$set": {
                "status": "loaded",
                "warehouse_fk": None,
                "vehicle_fk": vehicle_id,
                "updated_at": now,
            },
            "$setOnInsert": {
                "name": pallet_id,
                "created_at": now,
            },
        },
        upsert=True,
        return_document=True,
    )
    return _serialize(result) or {}


# ---------------------------------------------------------------------------
# Items (VLM shelf counting)
# ---------------------------------------------------------------------------

async def _lookup_shelf_depth(product_name: str) -> int:
    """Find the best matching depth from shelf_depths. Case-insensitive."""
    collection = get_shelf_depths_collection()

    # Exact match first
    doc = await collection.find_one(
        {"product_name": {"$regex": f"^{product_name}$", "$options": "i"}}
    )
    if doc:
        return doc["depth"]

    # Substring match — shelf_depths product_name contained in detected name
    cursor = collection.find({})
    async for row in cursor:
        if row["product_name"].lower() in product_name.lower():
            return row["depth"]

    return 1


async def upsert_item(
    shelf_label_text: str,
    product_name: str = "",
    facing_count: int = 0,
    price: float | None = None,
    confidence: float = 0.0,
    shelf_position: str = "",
) -> tuple[str, bool]:
    """Upsert an item keyed by shelf_label_text. Returns (item_id, was_updated)."""
    collection = get_items_collection()
    existing = await collection.find_one({"shelf_label_text": shelf_label_text})

    now = datetime.now(timezone.utc)

    if existing:
        if confidence >= existing.get("confidence", 0.0):
            await collection.update_one(
                {"_id": existing["_id"]},
                {"$set": {
                    "product_name": product_name,
                    "facing_count": facing_count,
                    "price": price,
                    "confidence": confidence,
                    "shelf_position": shelf_position,
                    "updated_at": now,
                }},
            )
        return str(existing["_id"]), True

    # New item — look up depth from shelf_depths
    depth = await _lookup_shelf_depth(product_name)

    result = await collection.insert_one({
        "shelf_label_text": shelf_label_text,
        "product_name": product_name,
        "facing_count": facing_count,
        "depth": depth,
        "price": price,
        "confidence": confidence,
        "shelf_position": shelf_position,
        "created_at": now,
        "updated_at": now,
    })
    return str(result.inserted_id), False


async def get_item(item_id: str) -> dict | None:
    collection = get_items_collection()
    try:
        doc = await collection.find_one({"_id": ObjectId(item_id)})
    except Exception:
        return None
    return _serialize(doc) if doc else None


async def get_items() -> list[dict]:
    collection = get_items_collection()
    cursor = collection.find({}).sort("updated_at", -1)
    return [_serialize(doc) async for doc in cursor]


async def set_item_depth(item_id: str, depth: int) -> dict | None:
    """Set the depth (rows deep) for an item."""
    collection = get_items_collection()
    try:
        doc = await collection.find_one_and_update(
            {"_id": ObjectId(item_id)},
            {"$set": {"depth": depth, "updated_at": datetime.now(timezone.utc)}},
            return_document=True,
        )
    except Exception:
        return None
    return _serialize(doc) if doc else None


# ---------------------------------------------------------------------------
# Shelf Depths
# ---------------------------------------------------------------------------

async def get_shelf_depths() -> list[dict]:
    collection = get_shelf_depths_collection()
    cursor = collection.find({}).sort("product_name", 1)
    return [_serialize(doc) async for doc in cursor]


async def set_shelf_depth(product_name: str, depth: int) -> dict:
    collection = get_shelf_depths_collection()
    doc = await collection.find_one_and_update(
        {"product_name": product_name},
        {"$set": {"product_name": product_name, "depth": depth}},
        upsert=True,
        return_document=True,
    )
    return _serialize(doc)


# ---------------------------------------------------------------------------
# Activity Log
# ---------------------------------------------------------------------------

async def log_activity(action: str, details: str = "") -> str:
    collection = get_activity_log_collection()
    result = await collection.insert_one({
        "action": action,
        "details": details,
        "approved": 0,
        "created_at": datetime.now(timezone.utc),
    })
    return str(result.inserted_id)


async def get_activity_log(limit: int = 50) -> list[dict]:
    collection = get_activity_log_collection()
    cursor = collection.find({}).sort("created_at", -1).limit(limit)
    return [_serialize(doc) async for doc in cursor]


async def approve_activity(activity_id: str) -> None:
    collection = get_activity_log_collection()
    await collection.update_one(
        {"_id": ObjectId(activity_id)}, {"$set": {"approved": 1}}
    )


async def dismiss_activity(activity_id: str) -> None:
    collection = get_activity_log_collection()
    await collection.update_one(
        {"_id": ObjectId(activity_id)}, {"$set": {"approved": -1}}
    )
