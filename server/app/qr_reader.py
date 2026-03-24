"""Reusable QR code reader.

Decodes the first QR code found in an image and returns its text content.
No JSON parsing — just raw decoded text.

Uses pyzbar (zbar wrapper) + Pillow for lightweight, fast QR detection
without needing OpenCV.
"""

import io
import logging

from PIL import Image
from pyzbar.pyzbar import decode, ZBarSymbol

logger = logging.getLogger(__name__)


def decode_qr(image_bytes: bytes) -> str | None:
    """Decode the first QR code found in an image.

    Args:
        image_bytes: Raw image bytes (JPEG, PNG, etc.).

    Returns:
        The decoded text string, or None if no QR code is found.
    """
    try:
        image = Image.open(io.BytesIO(image_bytes))
    except Exception:
        logger.warning("qr_reader: failed to open image (%d bytes)", len(image_bytes))
        return None

    results = decode(image, symbols=[ZBarSymbol.QRCODE])

    if not results:
        logger.info("qr_reader: no QR code found in image")
        return None

    text = results[0].data.decode("utf-8")
    logger.info("qr_reader: decoded QR text: %s", text)
    return text
