import re
from html.parser import HTMLParser

import cv2
import httpx
import numpy as np
from qreader import QReader

_qreader = None
_http_client = None

URL_PATTERN = re.compile(
    r"^(https?://|[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+)"
)


class _TextExtractor(HTMLParser):
    """Strip HTML tags and pull out visible text."""

    def __init__(self):
        super().__init__()
        self._pieces: list[str] = []
        self._skip = False

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "head"):
            self._skip = True

    def handle_endtag(self, tag):
        if tag in ("script", "style", "head"):
            self._skip = False

    def handle_data(self, data):
        if not self._skip:
            t = data.strip()
            if t:
                self._pieces.append(t)

    def get_text(self) -> str:
        return " ".join(self._pieces)


def _extract_text_from_html(html: str) -> str:
    """Extract meaningful text from an HTML page.

    Tries multiple strategies:
    1. JS framework data attributes (Alpine.js x-data, etc.)
    2. Meta description
    3. Static body text
    """
    # 1. Try to find embedded JSON data (Alpine.js, etc.)
    trans_match = re.search(r'trans:\s*(\{[^}]+\})', html)
    if trans_match:
        try:
            import json
            trans = json.loads(trans_match.group(1))
            # Return title + description if available
            parts = []
            for key in ("seoTitle", "title", "description"):
                val = trans.get(key, "")
                if val:
                    # Strip HTML tags from value
                    val = re.sub(r'<[^>]+>', ' ', val).strip()
                    parts.append(val)
            if parts:
                return " | ".join(parts)
        except Exception:
            pass

    # 2. Try meta description
    meta_match = re.search(
        r'<meta\s+name=["\']description["\']\s+content=["\']([^"\']+)["\']',
        html, re.IGNORECASE,
    )
    if meta_match:
        return meta_match.group(1).strip()

    # 3. Fall back to static text extraction
    parser = _TextExtractor()
    parser.feed(html)
    text = parser.get_text()
    return text if text else "(empty page)"


def get_qreader() -> QReader:
    global _qreader
    if _qreader is None:
        _qreader = QReader(model_size="s", min_confidence=0.5)
    return _qreader


def get_http_client() -> httpx.Client:
    global _http_client
    if _http_client is None:
        _http_client = httpx.Client(follow_redirects=True, timeout=10)
    return _http_client


def _is_url(text: str) -> bool:
    return bool(URL_PATTERN.match(text.strip()))


def _resolve_url(url: str) -> str:
    """Fetch a URL and return the text content."""
    if not url.startswith("http"):
        url = f"https://{url}"
    resp = get_http_client().get(url)
    resp.raise_for_status()
    body = resp.text.strip()
    # Plain text / JSON — return directly
    if not body.startswith("<!") and not body.lower().startswith("<html"):
        return body
    # HTML — extract visible text
    return _extract_text_from_html(body)


def decode_qr(image_bytes: bytes) -> list[dict]:
    """Decode all QR codes from raw image bytes.

    Returns list of dicts with:
      - raw: the exact string decoded from the QR code
      - resolved: if raw was a URL, the fetched content; otherwise same as raw
      - is_url: whether the raw value was a URL that was followed
    """
    nparr = np.frombuffer(image_bytes, np.uint8)
    img_bgr = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img_bgr is None:
        return []
    results = get_qreader().detect_and_decode(image=img_bgr, is_bgr=True)
    decoded = []
    for text in results:
        if text is None:
            continue
        entry = {"raw": text, "resolved": text, "is_url": False}
        if _is_url(text):
            entry["is_url"] = True
            try:
                entry["resolved"] = _resolve_url(text)
            except Exception as e:
                entry["resolved"] = f"Error fetching URL: {e}"
        decoded.append(entry)
    return decoded
