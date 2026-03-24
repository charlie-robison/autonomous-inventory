"""Mode selection pipeline: transcribed speech -> determine session mode.

Modes:
    - count:   VLM counts product faces on shelves (already implemented)
    - receive: Scan pallet QR, mark as received at a warehouse
    - load:    Scan pallet QR + vehicle number, mark as loaded onto truck
"""

import re

from app.database import get_app_mode, set_app_mode, VALID_MODES


# Keyword patterns used to detect the intended mode from transcribed speech.
# Order matters: first match wins.
_MODE_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("receive", re.compile(r"\breceiv(e|ing)\b", re.IGNORECASE)),
    ("load", re.compile(r"\bload(ing)?\b", re.IGNORECASE)),
    ("count", re.compile(r"\bcount(ing)?\b", re.IGNORECASE)),
]


def parse_mode_from_text(text: str) -> str | None:
    """Extract a mode keyword from transcribed speech.

    Returns the mode string ("count", "receive", "load") or None if
    no recognisable mode keyword is found.
    """
    for mode, pattern in _MODE_PATTERNS:
        if pattern.search(text):
            return mode
    return None


async def select_mode(text: str) -> dict:
    """Full mode-selection pipeline step.

    1. Parse mode from transcribed text.
    2. Persist the selected mode in the database.
    3. Return the result.

    Returns:
        {"mode": "receive", "matched": True}   — mode was recognised and set
        {"mode": None, "matched": False, "error": "..."}  — no mode found
    """
    mode = parse_mode_from_text(text)
    if mode is None:
        return {
            "mode": None,
            "matched": False,
            "error": f"Could not determine mode from: '{text}'. Say count, receive, or load.",
        }

    result = await set_app_mode(mode)
    return {"mode": result["current_mode"], "matched": True}


async def get_current_mode() -> str:
    """Return the current session mode from the database."""
    return await get_app_mode()
