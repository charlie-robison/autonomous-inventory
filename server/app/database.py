import os

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


async def add_or_increment_item(name: str, count: int = 1) -> dict:
    """Add a new item to inventory or increment its count if it already exists.

    Uses MongoDB upsert with $inc to atomically insert or increment.
    """
    collection = get_inventory_collection()
    result = await collection.find_one_and_update(
        {"name": name},
        {"$inc": {"count": count}},
        upsert=True,
        return_document=True,
    )
    return {"name": result["name"], "count": result["count"]}
