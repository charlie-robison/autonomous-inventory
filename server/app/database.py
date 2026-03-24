import os
from datetime import datetime, timezone

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


def get_inventory_collection():
    return db["inventory"]


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
