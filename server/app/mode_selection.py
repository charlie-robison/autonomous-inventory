"""Mode selection pipeline: transcribed speech -> determine session mode.

The user must say a wake word ("Jarvis" or similar) followed by anything
that resembles a mode name.  The pipeline:
    1. Check for wake word — ignore speech without it.
    2. Take everything after the wake word.
    3. Score each candidate mode using fuzzy edit-distance matching
       against every word in the remainder, and pick the best match.

Modes:
    - count:   VLM counts product faces on shelves (already implemented)
    - receive: Scan pallet QR, mark as received at a warehouse
    - load:    Scan pallet QR + vehicle number, mark as loaded onto truck
"""

import re

from app.database import get_app_mode, set_app_mode, VALID_MODES


# Wake-word pattern: "jarvis" and common Whisper mis-hearings
_WAKE_RE = re.compile(
    r"\b(jarvis|jarvas|jarves|jarvus|jarv[iy]s|jarbus|"
    r"gervis|jervis|jarv|jarb[iy]s|jarfis|jarbis|"
    r"service|java[s']?|travis|elvis)\b",
    re.IGNORECASE,
)

# Canonical mode names and their common phonetic variants.
# Used as anchors for fuzzy matching — the best Levenshtein match wins.
_MODE_ANCHORS: dict[str, list[str]] = {
    "count": [
        "count", "counting", "counted", "cound", "mount", "caunt",
        "cant", "kount", "coun", "recount", "account", "county",
        "cowed", "kont", "counter",
    ],
    "receive": [
        "receive", "receiving", "received", "reseive", "recieve",
        "resiv", "receipt", "recede", "receed", "believe", "retrieve",
        "receiv", "resieve",
    ],
    "load": [
        "load", "loading", "loaded", "lode", "lowed", "loud",
        "loat", "lote", "lord", "lod", "lowed", "loader",
    ],
}


def _levenshtein(a: str, b: str) -> int:
    """Compute Levenshtein edit distance between two strings."""
    if len(a) < len(b):
        return _levenshtein(b, a)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a):
        curr = [i + 1]
        for j, cb in enumerate(b):
            curr.append(min(
                prev[j + 1] + 1,       # deletion
                curr[j] + 1,           # insertion
                prev[j] + (ca != cb),  # substitution
            ))
        prev = curr
    return prev[-1]


def _best_mode(text: str) -> tuple[str | None, int]:
    """Find the mode whose anchor words best match the given text.

    Returns (mode, best_distance).  Lower distance = better match.
    A maximum distance threshold is applied so garbage text doesn't
    randomly match a mode.
    """
    words = re.findall(r"[a-zA-Z]+", text.lower())
    if not words:
        return None, 999

    best_mode = None
    best_dist = 999

    for mode, anchors in _MODE_ANCHORS.items():
        for word in words:
            for anchor in anchors:
                d = _levenshtein(word, anchor)
                if d < best_dist:
                    best_dist = d
                    best_mode = mode

    # Allow up to 3 edits — covers most Whisper mishearings
    if best_dist > 3:
        return None, best_dist

    return best_mode, best_dist


def parse_mode_from_text(text: str) -> str | None:
    """Extract a mode from transcribed speech.

    Requires a wake word ("Jarvis") to be present.  Everything after
    the wake word is fuzzy-matched against the three mode names.

    Returns the mode string ("count", "receive", "load") or None.
    """
    m = _WAKE_RE.search(text)
    if not m:
        return None

    # Take everything after the wake word
    after = text[m.end():].strip()
    if not after:
        return None

    mode, _ = _best_mode(after)
    return mode


async def select_mode(text: str) -> dict:
    """Full mode-selection pipeline step.

    1. Check for wake word.
    2. Fuzzy-match mode from remaining text.
    3. Persist the selected mode in the database.

    Returns:
        {"mode": "receive", "matched": True}   — mode was recognised and set
        {"mode": None, "matched": False, "error": "..."}  — no mode found
    """
    mode = parse_mode_from_text(text)
    if mode is None:
        wake_found = bool(_WAKE_RE.search(text))
        if not wake_found:
            return {
                "mode": None,
                "matched": False,
                "error": "No wake word detected. Say 'Jarvis' followed by count, receive, or load.",
            }
        return {
            "mode": None,
            "matched": False,
            "error": f"Could not determine mode from: '{text}'. Say 'Jarvis count', 'Jarvis receive', or 'Jarvis load'.",
        }

    result = await set_app_mode(mode)
    return {"mode": result["current_mode"], "matched": True}


async def get_current_mode() -> str:
    """Return the current session mode from the database."""
    return await get_app_mode()
