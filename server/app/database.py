import os
from datetime import datetime, timezone

from bson import ObjectId
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv()

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
MONGODB_DB_NAME = os.getenv("MONGODB_DB_NAME", "autonomous_inventory")

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


# ---------------------------------------------------------------------------
# Inventory (existing)
# ---------------------------------------------------------------------------

async def add_or_increment_item(
    name: str,
    count: int = 1,
    confidence_level: int | None = None,
    explanation: str | None = None,
    image_path: str | None = None,
) -> dict:
    """Add a new item to inventory or increment its count if it already exists.

    Uses MongoDB upsert with $inc to atomically insert or increment.
    Latest confidence/explanation are kept at top level via $set.
    Each observation is appended to the observations array via $push.
    """
    collection = get_inventory_collection()
    update: dict = {"$inc": {"count": count}}

    # Always keep the latest confidence/explanation at top level
    set_fields = {}
    if confidence_level is not None:
        set_fields["confidence_level"] = confidence_level
    if explanation is not None:
        set_fields["explanation"] = explanation
    if set_fields:
        update["$set"] = set_fields

    # Build observation record and push to history
    observation = {"timestamp": datetime.now(timezone.utc), "count": count}
    if confidence_level is not None:
        observation["confidence_level"] = confidence_level
    if explanation is not None:
        observation["explanation"] = explanation
    if image_path is not None:
        observation["image_path"] = image_path
    update["$push"] = {"observations": observation}

    result = await collection.find_one_and_update(
        {"name": name},
        update,
        upsert=True,
        return_document=True,
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
# App Mode  (singleton document — only one mode active at a time)
# ---------------------------------------------------------------------------

VALID_MODES = ("count", "receive", "load")


async def set_app_mode(mode: str) -> dict:
    """Set the current application mode. Returns the updated mode document."""
    mode = mode.lower()
    if mode not in VALID_MODES:
        raise ValueError(f"Invalid mode '{mode}'. Must be one of {VALID_MODES}")
    collection = get_app_mode_collection()
    result = await collection.find_one_and_update(
        {},  # singleton — match any document
        {"$set": {"current_mode": mode, "updated_at": datetime.now(timezone.utc)}},
        upsert=True,
        return_document=True,
    )
    return {"current_mode": result["current_mode"], "updated_at": result["updated_at"]}


async def get_app_mode() -> str:
    """Return the current application mode (defaults to 'count')."""
    collection = get_app_mode_collection()
    doc = await collection.find_one({}, {"_id": 0, "current_mode": 1})
    if not doc:
        return "count"
    return doc.get("current_mode", "count")


# ---------------------------------------------------------------------------
# Vehicles
# ---------------------------------------------------------------------------

async def create_vehicle(name: str) -> dict:
    """Create a new vehicle. Returns the created document."""
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
    """Case-insensitive lookup of a vehicle by name."""
    collection = get_vehicles_collection()
    doc = await collection.find_one({"name": {"$regex": f"^{name}$", "$options": "i"}})
    return _serialize(doc) if doc else None


async def get_all_vehicles() -> list[dict]:
    collection = get_vehicles_collection()
    cursor = collection.find({})
    return [_serialize(doc) async for doc in cursor]


# ---------------------------------------------------------------------------
# Warehouses
# ---------------------------------------------------------------------------

async def create_warehouse(name: str) -> dict:
    """Create a new warehouse. Returns the created document."""
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
    """Case-insensitive lookup of a warehouse by name."""
    collection = get_warehouses_collection()
    doc = await collection.find_one({"name": {"$regex": f"^{name}$", "$options": "i"}})
    return _serialize(doc) if doc else None


async def get_all_warehouses() -> list[dict]:
    collection = get_warehouses_collection()
    cursor = collection.find({})
    return [_serialize(doc) async for doc in cursor]


# ---------------------------------------------------------------------------
# Pallets
# ---------------------------------------------------------------------------

VALID_PALLET_STATUSES = ("on_boat", "on_port", "received", "loaded")


async def create_pallet(
    status: str = "on_port",
    warehouse_fk: str | None = None,
    vehicle_fk: str | None = None,
) -> dict:
    """Create a new pallet. Returns the created document with its id."""
    if status not in VALID_PALLET_STATUSES:
        raise ValueError(f"Invalid status '{status}'. Must be one of {VALID_PALLET_STATUSES}")
    collection = get_pallets_collection()
    doc = {
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
    """Look up a pallet by its _id."""
    collection = get_pallets_collection()
    doc = await collection.find_one({"_id": ObjectId(pallet_id)})
    return _serialize(doc) if doc else None


async def update_pallet(pallet_id: str, updates: dict) -> dict | None:
    """Apply arbitrary field updates to a pallet. Returns the updated document."""
    collection = get_pallets_collection()
    updates["updated_at"] = datetime.now(timezone.utc)
    doc = await collection.find_one_and_update(
        {"_id": ObjectId(pallet_id)},
        {"$set": updates},
        return_document=True,
    )
    return _serialize(doc) if doc else None


async def get_all_pallets() -> list[dict]:
    collection = get_pallets_collection()
    cursor = collection.find({})
    return [_serialize(doc) async for doc in cursor]


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
