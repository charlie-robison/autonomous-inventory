"""Vision Language Model integration via Gemini.

analyze_frame — Count pipeline: detect product faces and return item counts.
scan_qr_code  — Receive/Load pipelines: detect a QR code and return its data.
read_vehicle_number — Load pipeline: read a truck/vehicle number from the image.
"""

import logging

from app.gemini_service import analyze_frame as gemini_analyze
from app.qr_reader import decode_qr

logger = logging.getLogger(__name__)


async def analyze_frame(image_bytes: bytes) -> list[dict]:
    """Send an image frame to Gemini and return detected shelf items.

    Used by the Count pipeline.

    Returns a list of detected items with counts and metadata.
    """
    parsed, raw_text = await gemini_analyze(image_bytes, mode="count")
    logger.info("VLM analyze_frame: got %d items from Gemini", len(parsed) if isinstance(parsed, list) else 0)
    return parsed if isinstance(parsed, list) else []


async def scan_qr_code(image_bytes: bytes) -> dict | None:
    """Detect and decode a QR code from an image frame.

    Used by Receive and Load pipelines.
    Tries local qr_reader first (fast, actually decodes the QR content).
    Falls back to Gemini for QR detection when local decode fails.

    Returns {"pallet_id": "<text>", "raw": "<text>"} or None.
    """
    # Local QR reader can actually decode the content
    text = decode_qr(image_bytes)
    if text is not None:
        return {"pallet_id": text, "raw": text}

    # Gemini can detect QR presence but not decode — log for diagnostics
    parsed, _ = await gemini_analyze(image_bytes, mode="receive")
    if isinstance(parsed, dict) and parsed.get("qr_detected"):
        logger.info("VLM scan_qr_code: Gemini detected QR but local decoder failed")

    return None


async def read_vehicle_number(image_bytes: bytes) -> str | None:
    """Read a vehicle/truck number from an image frame using Gemini.

    Used by the Load pipeline.

    Returns the vehicle name/number string, or None if not detected.
    """
    parsed, _ = await gemini_analyze(image_bytes, mode="load")

    if not isinstance(parsed, dict):
        return None

    vehicle_numbers = parsed.get("vehicle_numbers", [])
    if vehicle_numbers and isinstance(vehicle_numbers[0], dict):
        number = vehicle_numbers[0].get("number")
        if number:
            logger.info("VLM read_vehicle_number: detected '%s'", number)
            return number

    return None
