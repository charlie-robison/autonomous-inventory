"""Processing pipeline: VLM output -> inventory count updates."""

import os
import uuid

from app.database import add_or_increment_item
from app.vlm import analyze_frame

UPLOADS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "uploads")


def _save_frame(image_bytes: bytes) -> str:
    """Save a frame image to disk and return the filename."""
    filename = f"{uuid.uuid4().hex}.jpg"
    filepath = os.path.join(UPLOADS_DIR, filename)
    with open(filepath, "wb") as f:
        f.write(image_bytes)
    return filename


async def process_frame(image_bytes: bytes) -> list[dict]:
    """Run a single video frame through the VLM and update inventory counts.

    Returns the list of updated inventory entries.
    """
    detected_items = await analyze_frame(image_bytes)
    if not detected_items:
        return []

    # Save the frame once — all items detected in this frame share the same image
    image_filename = _save_frame(image_bytes)

    results = []
    for item in detected_items:
        name = item.get("Name") or item.get("name")
        if not name:
            continue
        count = item.get("Count") or item.get("count") or 1
        confidence_level = item.get("Confidence_Level") or item.get("confidence_level")
        explanation = item.get("Explanation") or item.get("explanation")
        updated = await add_or_increment_item(
            name,
            count=count,
            confidence_level=confidence_level,
            explanation=explanation,
            image_path=image_filename,
        )
        results.append(updated)
    return results
