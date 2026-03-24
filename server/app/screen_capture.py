"""macOS screen capture utilities using Quartz window-ID capture."""

import io
import logging
import subprocess
import tempfile
import unicodedata

from PIL import Image

logger = logging.getLogger(__name__)

# Quartz is macOS-only; import lazily to allow loading the module on other platforms
try:
    from Quartz import (
        CGRectNull,
        CGWindowListCopyWindowInfo,
        CGWindowListCreateImage,
        kCGNullWindowID,
        kCGWindowImageBoundsIgnoreFraming,
        kCGWindowListOptionAll,
        kCGWindowListOptionIncludingWindow,
        kCGWindowLayer,
        kCGWindowName,
        kCGWindowNumber,
        kCGWindowOwnerName,
        kCGWindowBounds,
    )

    _HAS_QUARTZ = True
except ImportError:
    _HAS_QUARTZ = False


def _normalize(s: str) -> str:
    """Strip invisible Unicode characters (LTR marks, zero-width spaces, etc.)."""
    return "".join(c for c in s if unicodedata.category(c) not in ("Cf", "Cc")).strip()


def list_windows() -> list[dict]:
    """Enumerate visible windows (macOS only).

    Returns a list of dicts with keys:
        owner_name, window_name, window_id, bounds {x, y, width, height}
    Returns the largest window per owner app, filtering out tiny windows.
    """
    if not _HAS_QUARTZ:
        raise RuntimeError("Quartz is not available — this feature requires macOS")

    window_list = CGWindowListCopyWindowInfo(
        kCGWindowListOptionAll, kCGNullWindowID
    )

    # Keep the largest window per owner app
    best_by_owner: dict[str, dict] = {}
    for win in window_list:
        owner = win.get(kCGWindowOwnerName, "")
        if not owner:
            continue

        bounds = win.get(kCGWindowBounds, {})
        width = int(bounds.get("Width", 0))
        height = int(bounds.get("Height", 0))

        # Skip tiny windows (menu bar items, status icons, etc.)
        if width < 100 or height < 100:
            continue

        area = width * height
        name = win.get(kCGWindowName, "")
        entry = {
            "owner_name": str(owner),
            "window_name": str(name) if name else "",
            "window_id": int(win.get(kCGWindowNumber, 0)),
            "bounds": {
                "x": int(bounds.get("X", 0)),
                "y": int(bounds.get("Y", 0)),
                "width": width,
                "height": height,
            },
        }

        existing = best_by_owner.get(owner)
        if existing is None or area > existing["_area"]:
            entry["_area"] = area
            best_by_owner[owner] = entry

    # Strip internal _area field before returning
    results = []
    for entry in best_by_owner.values():
        entry.pop("_area", None)
        results.append(entry)

    return results


def find_window_id(owner_name: str) -> int | None:
    """Find the first window whose owner matches *owner_name* (case-insensitive).

    Returns the window ID (int) or ``None``.
    """
    target = _normalize(owner_name).lower()
    for win in list_windows():
        if _normalize(win["owner_name"]).lower() == target:
            return win["window_id"]
    return None


def capture_window(window_id: int) -> bytes:
    """Capture a specific window by ID and return JPEG bytes.

    Works even if the window is behind other windows or on another Space.
    Tries CGWindowListCreateImage first, falls back to screencapture CLI.
    """
    if _HAS_QUARTZ:
        jpeg = _capture_quartz(window_id)
        if jpeg:
            return jpeg

    # Fallback: use macOS screencapture CLI
    return _capture_cli(window_id)


def _capture_quartz(window_id: int) -> bytes | None:
    """Capture window via CGWindowListCreateImage (fast, in-memory)."""
    cg_image = CGWindowListCreateImage(
        CGRectNull,
        kCGWindowListOptionIncludingWindow,
        window_id,
        kCGWindowImageBoundsIgnoreFraming,
    )
    if cg_image is None:
        logger.debug("CGWindowListCreateImage returned None for window %d", window_id)
        return None

    # Convert CGImage → PIL → JPEG
    from Quartz import (
        CGImageGetWidth,
        CGImageGetHeight,
        CGImageGetBytesPerRow,
        CGImageGetDataProvider,
        CGDataProviderCopyData,
    )

    width = CGImageGetWidth(cg_image)
    height = CGImageGetHeight(cg_image)
    bpr = CGImageGetBytesPerRow(cg_image)
    provider = CGImageGetDataProvider(cg_image)
    data = CGDataProviderCopyData(provider)

    image = Image.frombytes("RGBA", (width, height), bytes(data), "raw", "BGRA", bpr, 1)
    image = image.convert("RGB")

    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def _capture_cli(window_id: int) -> bytes:
    """Capture window via macOS screencapture CLI (fallback)."""
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=True) as tmp:
        result = subprocess.run(
            ["screencapture", "-l", str(window_id), "-x", "-o", "-t", "jpg", tmp.name],
            capture_output=True,
            timeout=10,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"screencapture failed (code {result.returncode}): {result.stderr.decode()}"
            )

        image = Image.open(tmp.name)
        buf = io.BytesIO()
        image.save(buf, format="JPEG", quality=85)
        return buf.getvalue()
