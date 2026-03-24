import json
import sqlite3
from pathlib import Path

DATABASE_PATH = Path(__file__).parent.parent / "inventory.db"
SHELF_DEPTHS_PATH = Path(__file__).parent.parent / "shelf_depths.json"

VALID_PALLET_STATUSES = ("on_boat", "at_port", "received", "loaded")
VALID_MODES = ("count", "receive", "load")

# Hawaiian island warehouse coordinates for geo lookup
WAREHOUSE_COORDS = {
    "Oahu": (21.4389, -158.0001),
    "Maui": (20.7984, -156.3319),
    "Big Island": (19.7241, -155.4315),
    "Kauai": (22.0964, -159.5261),
    "Molokai": (21.1333, -157.0167),
    "Lanai": (20.8333, -156.9167),
}


def get_db():
    conn = sqlite3.connect(str(DATABASE_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    conn = get_db()
    c = conn.cursor()

    c.execute("""
        CREATE TABLE IF NOT EXISTS warehouses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS vehicles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS pallets (
            id TEXT PRIMARY KEY,
            status TEXT DEFAULT 'on_boat'
                CHECK(status IN ('on_boat', 'at_port', 'received', 'loaded')),
            warehouse_fk INTEGER REFERENCES warehouses(id),
            vehicle_fk INTEGER REFERENCES vehicles(id),
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            shelf_label_text TEXT NOT NULL DEFAULT '',
            product_name TEXT NOT NULL DEFAULT '',
            facing_count INTEGER DEFAULT 0,
            depth INTEGER DEFAULT 1,
            price REAL,
            confidence REAL DEFAULT 0.0,
            shelf_position TEXT DEFAULT '',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS current_app_mode (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            current_mode TEXT DEFAULT 'receive'
                CHECK(current_mode IN ('count', 'receive', 'load'))
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS activity_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            details TEXT DEFAULT '',
            approved INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS shelf_depths (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_name TEXT NOT NULL UNIQUE,
            depth INTEGER NOT NULL DEFAULT 1
        )
    """)

    # Seed Hawaiian island warehouses
    for name in WAREHOUSE_COORDS:
        c.execute("INSERT OR IGNORE INTO warehouses (name) VALUES (?)", (name,))

    # Seed default mode
    c.execute(
        "INSERT OR IGNORE INTO current_app_mode (id, current_mode) VALUES (1, 'receive')"
    )

    # Seed shelf depths from JSON file
    if SHELF_DEPTHS_PATH.exists():
        shelf_data = json.loads(SHELF_DEPTHS_PATH.read_text())
        for entry in shelf_data:
            c.execute(
                "INSERT OR IGNORE INTO shelf_depths (product_name, depth) VALUES (?, ?)",
                (entry["product_name"], entry["depth"]),
            )

    conn.commit()
    conn.close()


# ---------- App Mode ----------


def get_current_mode() -> str:
    conn = get_db()
    row = conn.execute(
        "SELECT current_mode FROM current_app_mode WHERE id = 1"
    ).fetchone()
    conn.close()
    return row["current_mode"] if row else "receive"


def set_current_mode(mode: str) -> str | None:
    if mode not in VALID_MODES:
        return None
    conn = get_db()
    conn.execute(
        "UPDATE current_app_mode SET current_mode = ? WHERE id = 1", (mode,)
    )
    conn.commit()
    conn.close()
    return mode


# ---------- Warehouses ----------


def get_warehouses() -> list[dict]:
    conn = get_db()
    rows = conn.execute("SELECT * FROM warehouses ORDER BY name").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_nearest_warehouse(lat: float, lng: float) -> dict | None:
    """Find the nearest Hawaiian island warehouse by coordinates."""
    conn = get_db()
    warehouses = conn.execute("SELECT * FROM warehouses").fetchall()
    conn.close()

    if not warehouses:
        return None

    best = None
    best_dist = float("inf")
    for wh in warehouses:
        coords = WAREHOUSE_COORDS.get(wh["name"])
        if not coords:
            continue
        dist = (lat - coords[0]) ** 2 + (lng - coords[1]) ** 2
        if dist < best_dist:
            best_dist = dist
            best = dict(wh)

    return best


# ---------- Vehicles ----------


def get_vehicles() -> list[dict]:
    conn = get_db()
    rows = conn.execute("SELECT * FROM vehicles ORDER BY name").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_or_create_vehicle(name: str) -> dict:
    conn = get_db()
    row = conn.execute("SELECT * FROM vehicles WHERE name = ?", (name,)).fetchone()
    if row:
        conn.close()
        return dict(row)
    c = conn.execute("INSERT INTO vehicles (name) VALUES (?)", (name,))
    conn.commit()
    row = conn.execute("SELECT * FROM vehicles WHERE id = ?", (c.lastrowid,)).fetchone()
    conn.close()
    return dict(row)


# ---------- Pallets ----------


def get_or_create_pallet(pallet_id: str) -> dict:
    conn = get_db()
    row = conn.execute("SELECT * FROM pallets WHERE id = ?", (pallet_id,)).fetchone()
    if row:
        conn.close()
        return dict(row)
    conn.execute("INSERT INTO pallets (id) VALUES (?)", (pallet_id,))
    conn.commit()
    row = conn.execute("SELECT * FROM pallets WHERE id = ?", (pallet_id,)).fetchone()
    conn.close()
    return dict(row)


def _pallet_with_joins(conn, pallet_id: str) -> dict | None:
    row = conn.execute(
        """SELECT p.*, w.name AS warehouse_name, v.name AS vehicle_name
           FROM pallets p
           LEFT JOIN warehouses w ON p.warehouse_fk = w.id
           LEFT JOIN vehicles v ON p.vehicle_fk = v.id
           WHERE p.id = ?""",
        (pallet_id,),
    ).fetchone()
    return dict(row) if row else None


def receive_pallet(pallet_id: str, warehouse_id: int) -> dict:
    """Set pallet to received, assign warehouse, clear vehicle."""
    conn = get_db()
    conn.execute(
        "INSERT INTO pallets (id, status, warehouse_fk, vehicle_fk) "
        "VALUES (?, 'received', ?, NULL) "
        "ON CONFLICT(id) DO UPDATE SET status='received', warehouse_fk=?, "
        "vehicle_fk=NULL, updated_at=CURRENT_TIMESTAMP",
        (pallet_id, warehouse_id, warehouse_id),
    )
    conn.commit()
    result = _pallet_with_joins(conn, pallet_id)
    conn.close()
    return result or {}


def load_pallet(pallet_id: str, vehicle_id: int) -> dict:
    """Set pallet to loaded, assign vehicle, clear warehouse."""
    conn = get_db()
    conn.execute(
        "INSERT INTO pallets (id, status, warehouse_fk, vehicle_fk) "
        "VALUES (?, 'loaded', NULL, ?) "
        "ON CONFLICT(id) DO UPDATE SET status='loaded', warehouse_fk=NULL, "
        "vehicle_fk=?, updated_at=CURRENT_TIMESTAMP",
        (pallet_id, vehicle_id, vehicle_id),
    )
    conn.commit()
    result = _pallet_with_joins(conn, pallet_id)
    conn.close()
    return result or {}


def update_pallet_status(pallet_id: str, status: str) -> dict | None:
    if status not in VALID_PALLET_STATUSES:
        return None
    conn = get_db()
    conn.execute(
        "INSERT INTO pallets (id, status) VALUES (?, ?) "
        "ON CONFLICT(id) DO UPDATE SET status=?, updated_at=CURRENT_TIMESTAMP",
        (pallet_id, status, status),
    )
    conn.commit()
    result = _pallet_with_joins(conn, pallet_id)
    conn.close()
    return result


def get_pallets(status: str | None = None) -> list[dict]:
    conn = get_db()
    query = """SELECT p.*, w.name AS warehouse_name, v.name AS vehicle_name
               FROM pallets p
               LEFT JOIN warehouses w ON p.warehouse_fk = w.id
               LEFT JOIN vehicles v ON p.vehicle_fk = v.id"""
    if status:
        query += " WHERE p.status = ? ORDER BY p.updated_at DESC"
        rows = conn.execute(query, (status,)).fetchall()
    else:
        query += " ORDER BY p.updated_at DESC"
        rows = conn.execute(query).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_pallet(pallet_id: str) -> dict | None:
    conn = get_db()
    result = _pallet_with_joins(conn, pallet_id)
    conn.close()
    return result


# ---------- Items ----------


def _lookup_shelf_depth(conn, product_name: str) -> int:
    """Find the best matching depth from shelf_depths. Case-insensitive substring match."""
    row = conn.execute(
        "SELECT depth FROM shelf_depths WHERE LOWER(product_name) = LOWER(?)",
        (product_name,),
    ).fetchone()
    if row:
        return row["depth"]
    # Try substring match — shelf_depths product_name contained in the detected name
    rows = conn.execute("SELECT product_name, depth FROM shelf_depths").fetchall()
    for r in rows:
        if r["product_name"].lower() in product_name.lower():
            return r["depth"]
    return 1


def upsert_item(
    shelf_label_text: str,
    product_name: str = "",
    facing_count: int = 0,
    price: float | None = None,
    confidence: float = 0.0,
    shelf_position: str = "",
) -> tuple[int, bool]:
    """Upsert an item keyed by shelf_label_text (the price tag text)."""
    conn = get_db()
    existing = conn.execute(
        "SELECT id, confidence, depth FROM items WHERE shelf_label_text = ?",
        (shelf_label_text,),
    ).fetchone()

    if existing:
        # Only update facing_count/confidence, preserve user-set depth
        if confidence >= existing["confidence"]:
            conn.execute(
                """UPDATE items SET product_name=?, facing_count=?, price=?,
                   confidence=?, shelf_position=?, updated_at=CURRENT_TIMESTAMP
                   WHERE id=?""",
                (product_name, facing_count, price, confidence,
                 shelf_position, existing["id"]),
            )
            conn.commit()
        item_id = existing["id"]
        conn.close()
        return item_id, True

    # New item — look up depth from shelf_depths table
    depth = _lookup_shelf_depth(conn, product_name)

    c = conn.execute(
        "INSERT INTO items (shelf_label_text, product_name, facing_count, "
        "depth, price, confidence, shelf_position) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (shelf_label_text, product_name, facing_count, depth, price,
         confidence, shelf_position),
    )
    conn.commit()
    item_id = c.lastrowid
    conn.close()
    return item_id, False


def get_item(item_id: int) -> dict | None:
    conn = get_db()
    row = conn.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_items() -> list[dict]:
    conn = get_db()
    rows = conn.execute("SELECT * FROM items ORDER BY updated_at DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def set_item_depth(item_id: int, depth: int) -> dict | None:
    """Set the depth (rows deep) for an item. Total = facing_count * depth."""
    conn = get_db()
    conn.execute(
        "UPDATE items SET depth=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
        (depth, item_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


# ---------- Shelf Depths ----------


def get_shelf_depths() -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM shelf_depths ORDER BY product_name"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def set_shelf_depth(product_name: str, depth: int) -> dict:
    """Create or update a shelf depth entry."""
    conn = get_db()
    conn.execute(
        "INSERT INTO shelf_depths (product_name, depth) VALUES (?, ?) "
        "ON CONFLICT(product_name) DO UPDATE SET depth=?",
        (product_name, depth, depth),
    )
    conn.commit()
    row = conn.execute(
        "SELECT * FROM shelf_depths WHERE product_name = ?", (product_name,)
    ).fetchone()
    conn.close()
    return dict(row)


# ---------- Activity Log ----------


def log_activity(action: str, details: str = "") -> int:
    conn = get_db()
    c = conn.execute(
        "INSERT INTO activity_log (action, details) VALUES (?, ?)",
        (action, details),
    )
    conn.commit()
    log_id = c.lastrowid
    conn.close()
    return log_id


def get_activity_log(limit: int = 50) -> list[dict]:
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def approve_activity(activity_id: int) -> None:
    conn = get_db()
    conn.execute("UPDATE activity_log SET approved = 1 WHERE id = ?", (activity_id,))
    conn.commit()
    conn.close()


def dismiss_activity(activity_id: int) -> None:
    conn = get_db()
    conn.execute("UPDATE activity_log SET approved = -1 WHERE id = ?", (activity_id,))
    conn.commit()
    conn.close()
