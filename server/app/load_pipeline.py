"""Load pipeline: scan pallet QR + vehicle number -> mark pallet as loaded onto truck.

Flow (business logic only — WebSocket/glasses streaming handled elsewhere):
    1. VLM identifies QR code AND vehicle number from image frame
    2. Look up pallet in DB by its id
    3. Look up vehicle (truck) in DB by name/number
    4. Set pallet status -> "loaded"
    5. Set vehicle_fk to the looked-up vehicle id
    6. Set warehouse_fk to None
"""

from app.database import (
    create_vehicle,
    get_or_create_pallet,
    get_vehicle_by_name,
    update_pallet,
)
from app.vlm import scan_qr_code, read_vehicle_number


async def load_pallet(pallet_name: str, vehicle_name: str) -> dict:
    """Execute the full load pipeline for a single pallet.

    Args:
        pallet_name: The pallet name from QR code (e.g. "H123").
        vehicle_name: The vehicle/truck name or number read from the truck.

    Returns:
        The updated pallet document.

    Raises:
        ValueError: If vehicle not found.
    """
    # 1. Find or create pallet by name
    pallet = await get_or_create_pallet(pallet_name)

    # 2. Look up or create vehicle by name/number
    vehicle = await get_vehicle_by_name(vehicle_name)
    if vehicle is None:
        vehicle = await create_vehicle(vehicle_name)

    # 3. Update pallet: status=loaded, vehicle_fk=vehicle id, warehouse_fk=null
    updated = await update_pallet(pallet["id"], {
        "status": "loaded",
        "vehicle_fk": vehicle["id"],
        "warehouse_fk": None,
    })
    return updated


async def load_pallet_from_frame(image_bytes: bytes) -> dict:
    """High-level entry: extract pallet name and vehicle number from a frame, then run load pipeline."""
    qr_data = await scan_qr_code(image_bytes)
    if qr_data is None:
        raise ValueError("No QR code detected in frame")

    pallet_name = qr_data.get("pallet_id")
    if pallet_name is None:
        raise ValueError(f"QR code does not contain a pallet name: {qr_data}")

    vehicle_name = await read_vehicle_number(image_bytes)
    if vehicle_name is None:
        raise ValueError("Could not read vehicle number from frame")

    return await load_pallet(pallet_name, vehicle_name)
