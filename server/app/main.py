from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.database import add_or_increment_item, connect_db, close_db, get_inventory_collection


@asynccontextmanager
async def lifespan(app: FastAPI):
    await connect_db()
    yield
    await close_db()


app = FastAPI(title="Autonomous Inventory API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Item(BaseModel):
    id: Optional[int] = None
    name: str
    description: str = ""
    quantity: int = 0


class InventoryUpdate(BaseModel):
    name: str
    count: int = 1


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
    result = await add_or_increment_item(update.name, update.count)
    return result


@app.get("/api/inventory")
async def get_inventory():
    """Get all inventory counts."""
    collection = get_inventory_collection()
    cursor = collection.find({}, {"_id": 0, "name": 1, "count": 1})
    return await cursor.to_list(length=None)
