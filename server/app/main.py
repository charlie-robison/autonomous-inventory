from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="Autonomous Inventory API")

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
