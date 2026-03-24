import json
import os

from google import genai
from google.genai import types

_client = None


def get_client() -> genai.Client:
    global _client
    if _client is None:
        api_key = os.getenv("GEMINI_API_KEY", "")
        if not api_key:
            raise ValueError("GEMINI_API_KEY environment variable is not set")
        _client = genai.Client(api_key=api_key)
    return _client


MODEL = "gemini-2.5-flash"

RECEIVE_PROMPT = """You are analyzing an image from a warehouse/port camera.
Your task is to determine whether any QR codes are visible in this image.
Do NOT try to decode the QR code — just detect if one is present.

Return ONLY valid JSON, no markdown, no extra text:
{"qr_detected": true}

If no QR code is visible, return:
{"qr_detected": false}
"""

LOAD_PROMPT = """You are analyzing an image from a warehouse loading dock.
Your tasks:
1. Determine whether any QR codes are visible (do NOT decode — just detect)
2. Identify any vehicle/truck numbers, license plates, fleet identifiers, or
   truck IDs visible in the image

Return ONLY valid JSON, no markdown, no extra text:
{"qr_detected": true/false, "vehicle_numbers": [{"number": "<vehicle number>"}]}

If nothing found: {"qr_detected": false, "vehicle_numbers": []}
"""

COUNT_PROMPT = """You are analyzing a grocery store shelf image for inventory counting.

Your anchor is the PRICE TAG / SHELF LABEL. Each visible price tag = one shelf slot.

For each visible price tag / shelf label in the image:
1. Read the text on the price tag (product name, price, size/variant).
   This is the shelf_label_text and is the dedup key across frames.
2. Count how many individual product units are visible in the FRONT ROW
   directly above that price tag. Count only what you can clearly see —
   do NOT estimate items behind the front row.
3. Rate your confidence from 0.0 to 1.0 for both the label read and the
   facing count. Low confidence if the tag is blurry, partially cut off
   at the frame edge, or the count is ambiguous.

Skip any price tags that are too blurry, cut off, or illegible to read.
They will be picked up in a better frame.

Return ONLY valid JSON, no markdown, no extra text:
[
  {
    "shelf_label_text": "<exact text from the price tag>",
    "product_name": "<product name>",
    "facing_count": <int>,
    "confidence": <float 0.0-1.0>,
    "price": <float or null>,
    "shelf_position": "<optional position descriptor e.g. top-left, bottom-center>"
  }
]

If no products are visible, return an empty array: []
"""

PROMPTS = {
    "receive": RECEIVE_PROMPT,
    "load": LOAD_PROMPT,
    "count": COUNT_PROMPT,
}


async def analyze_frame(image_bytes: bytes, mode: str = "count") -> tuple:
    """Analyze a frame with a mode-specific prompt.

    Returns (parsed_result, raw_response_text).
    """
    client = get_client()
    prompt = PROMPTS.get(mode, COUNT_PROMPT)

    image_part = types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg")

    response = await client.aio.models.generate_content(
        model=MODEL,
        contents=[prompt, image_part],
    )

    raw_text = response.text.strip()
    text = raw_text

    # Strip markdown code blocks if Gemini wraps the response
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1]).strip()

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        if mode == "load":
            parsed = {"qr_detected": False, "vehicle_numbers": []}
        elif mode == "receive":
            parsed = {"qr_detected": False}
        else:
            parsed = []

    return parsed, raw_text
