"""Receive pipeline: scan pallet QR -> look up pallet -> mark as received at warehouse.

Flow (business logic only — WebSocket/glasses streaming handled elsewhere):
    1. VLM identifies QR code from image frame  (scan_qr_code)
    2. Look up pallet in DB by its id            (get_pallet)
    3. Determine warehouse from geo coordinates  (resolve_warehouse_from_geo)
    4. Set pallet status -> "received"
    5. Set warehouse_fk to the resolved warehouse
    6. Set vehicle_fk to None
"""

from app.database import (
    get_or_create_pallet,
    get_warehouse_by_name,
    create_warehouse,
    update_pallet,
)
from app.vlm import scan_qr_code

# Hawaiian island warehouse mapping by approximate lat/lon bounding boxes.
# Each entry: (name, min_lat, max_lat, min_lon, max_lon)
_HAWAIIAN_WAREHOUSES = [
    ("Oahu",     21.25, 21.72, -158.30, -157.64),
    ("Maui",     20.57, 21.03, -156.70, -155.98),
    ("Big Island", 19.00, 20.25, -156.10, -154.80),
    ("Kauai",    21.86, 22.24, -159.80, -159.28),
    ("Molokai",  21.05, 21.23, -157.32, -156.70),
    ("Lanai",    20.72, 20.93, -157.00, -156.80),
]


def resolve_warehouse_from_geo(lat: float, lon: float) -> str | None:
    """Map latitude/longitude to a Hawaiian island warehouse name.

    Returns the warehouse name string or None if coordinates don't match
    any known island.
    """
    for name, min_lat, max_lat, min_lon, max_lon in _HAWAIIAN_WAREHOUSES:
        if min_lat <= lat <= max_lat and min_lon <= lon <= max_lon:
            return name
    return None


async def receive_pallet(pallet_name: str, lat: float, lon: float) -> dict:
    """Execute the full receive pipeline for a single pallet.

    Args:
        pallet_name: The pallet name from QR code (e.g. "H123").
        lat: GPS latitude of the receiving location.
        lon: GPS longitude of the receiving location.

    Returns:
        The updated pallet document.

    Raises:
        ValueError: If geo coordinates can't be resolved.
    """
    # 1. Find or create pallet by name
    pallet = await get_or_create_pallet(pallet_name)

    # 2. Resolve warehouse from geo
    warehouse_name = resolve_warehouse_from_geo(lat, lon)
    if warehouse_name is None:
        raise ValueError(
            f"Could not resolve warehouse from coordinates ({lat}, {lon}). "
            "Not within any known Hawaiian island bounds."
        )

    # 3. Get or create the warehouse record
    warehouse = await get_warehouse_by_name(warehouse_name)
    if warehouse is None:
        warehouse = await create_warehouse(warehouse_name)

    # 4. Update pallet: status=received, warehouse_fk=warehouse id, vehicle_fk=null
    updated = await update_pallet(pallet["id"], {
        "status": "received",
        "warehouse_fk": warehouse["id"],
        "vehicle_fk": None,
    })
    updated["warehouse_name"] = warehouse_name
    return updated


async def receive_pallet_from_frame(image_bytes: bytes, lat: float, lon: float) -> dict:
    """High-level entry: extract pallet id from a frame, then run receive pipeline.

    This is the method you'll call once the VLM + QR scanning is wired up.

    Args:
        image_bytes: Raw image bytes containing a QR code.
        lat: GPS latitude.
        lon: GPS longitude.

    Returns:
        The updated pallet document.
    """
    qr_data = await scan_qr_code(image_bytes)
    if qr_data is None:
        raise ValueError("No QR code detected in frame")

    pallet_name = qr_data.get("pallet_id")
    if pallet_name is None:
        raise ValueError(f"QR code does not contain a pallet name: {qr_data}")

    return await receive_pallet(pallet_name, lat, lon)
