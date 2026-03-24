"""Placeholder for Vision Language Model integration.

Replace each stub with your actual VLM implementation.

analyze_frame — Count pipeline: detect product faces and return item counts.
scan_qr_code  — Receive/Load pipelines: detect a QR code and return its data.
read_vehicle_number — Load pipeline: read a truck/vehicle number from the image.
"""

import logging

from app.qr_reader import decode_qr

logger = logging.getLogger(__name__)


async def analyze_frame(image_bytes: bytes) -> list[dict]:
    """Send an image frame to a VLM and return detected items.

    Used by the Count pipeline.

    Returns a list of detected items with counts and metadata.

    TODO: Replace this stub with your VLM call.
    """
    logger.info("VLM analyze_frame called (%d bytes) — returning stub data", len(image_bytes))
    return [
        {
            "Name": "Ruby Gem",
            "Desc": "A polished oval ruby gemstone",
            "Color": "Red",
            "Shape": "Oval",
            "Price": 249.99,
            "Type": "Gemstone",
            "Count": 2,
            "Confidence_Level": 78,
            "Explanation": "Detected 2 red oval gemstones on the shelf",
        },
    ]


async def scan_qr_code(image_bytes: bytes) -> dict | None:
    """Detect and decode a QR code from an image frame.

    Used by Receive and Load pipelines.
    Delegates to qr_reader.decode_qr() for the actual detection,
    then wraps the raw text into the dict the pipelines expect.

    Returns {"pallet_id": "<text>", "raw": "<text>"} or None.
    """
    text = decode_qr(image_bytes)
    if text is None:
        return None
    return {"pallet_id": text, "raw": text}


async def read_vehicle_number(image_bytes: bytes) -> str | None:
    """Read a vehicle/truck number from an image frame using OCR or VLM.

    Used by the Load pipeline.

    Returns the vehicle name/number string, or None if not detected.

    TODO: Replace this stub with your OCR/VLM implementation.
    """
    logger.info("VLM read_vehicle_number called (%d bytes) — not implemented, returning None", len(image_bytes))
    return None
