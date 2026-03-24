"""Placeholder for Vision Language Model integration.

Replace each stub with your actual VLM implementation.

analyze_frame — Count pipeline: detect product faces and return item counts.
scan_qr_code  — Receive/Load pipelines: detect a QR code and return its data.
read_vehicle_number — Load pipeline: read a truck/vehicle number from the image.
"""


async def analyze_frame(image_bytes: bytes) -> list[dict]:
    """Send an image frame to a VLM and return detected items.

    Used by the Count pipeline.

    Expected return schema:
        [
            {"Name": "Ruby Gem", "Desc": "...", "Color": "Red", "Shape": "Oval",
             "Price": 249.99, "Type": "Gemstone", "Count": 2,
             "Confidence_Level": 78, "Explanation": "..."},
            ...
        ]

    TODO: Replace this stub with your VLM call.
    """
    raise NotImplementedError(
        "analyze_frame not implemented yet. Replace this function with your model call."
    )


async def scan_qr_code(image_bytes: bytes) -> dict | None:
    """Detect and decode a QR code from an image frame.

    Used by Receive and Load pipelines. The VLM (or a dedicated QR library)
    should identify the QR code in the image and return its decoded data.

    Expected return schema:
        {"pallet_id": "60f1b2c3d4e5f6a7b8c9d0e1", "raw": "..."}

    Returns None if no QR code is found.

    TODO: Replace this stub with your QR detection implementation.
    """
    raise NotImplementedError(
        "scan_qr_code not implemented yet. Replace this function with your QR detection call."
    )


async def read_vehicle_number(image_bytes: bytes) -> str | None:
    """Read a vehicle/truck number from an image frame using OCR or VLM.

    Used by the Load pipeline. The VLM should identify the truck number
    visible on the vehicle in the frame.

    Returns the vehicle name/number string, or None if not detected.

    TODO: Replace this stub with your OCR/VLM implementation.
    """
    raise NotImplementedError(
        "read_vehicle_number not implemented yet. Replace this function with your OCR/VLM call."
    )
