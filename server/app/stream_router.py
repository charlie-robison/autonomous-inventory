"""API endpoints for controlling the Facebook Live stream consumer."""

import asyncio
import logging
import os
import socket
import time
from typing import Optional

import httpx
from fastapi import APIRouter, UploadFile, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.facebook_auth import FacebookAuth
from app.processing import process_frame
from app.screen_capture import list_windows  # noqa: F401 — used in windows endpoint
from app.stream_consumer import stream_consumer

TEST_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "test")
os.makedirs(TEST_DIR, exist_ok=True)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/stream", tags=["stream"])

# RTMP server defaults (nginx-rtmp via Docker)
RTMP_HOST = os.getenv("RTMP_HOST", "localhost")
RTMP_PORT = int(os.getenv("RTMP_PORT", "1935"))
HLS_PORT = int(os.getenv("HLS_PORT", "8080"))
DEFAULT_STREAM_KEY = os.getenv("RTMP_STREAM_KEY", "glasses")


def _get_local_ip() -> str:
    """Return the machine's local network IP address."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


class StreamStartRequest(BaseModel):
    access_token: Optional[str] = None
    page_id: Optional[str] = None
    frame_interval: float = 1.0


class StreamStartURLRequest(BaseModel):
    stream_url: str
    frame_interval: float = 1.0


class RTMPStartRequest(BaseModel):
    stream_key: str = DEFAULT_STREAM_KEY
    frame_interval: float = 1.0


class ScreenCaptureStartRequest(BaseModel):
    window_name: Optional[str] = None
    window_id: Optional[int] = None
    region: Optional[dict] = None
    frame_interval: float = 2.0


class StreamResponse(BaseModel):
    status: str
    message: str
    stream_url: Optional[str] = None


@router.post("/start", response_model=StreamResponse)
async def start_stream(request: StreamStartRequest):
    """Start consuming a Facebook Live stream by looking up the HLS URL."""
    access_token = request.access_token or os.getenv("FB_PAGE_ACCESS_TOKEN")
    page_id = request.page_id or os.getenv("FB_PAGE_ID")

    if not access_token or not page_id:
        return StreamResponse(
            status="error",
            message="access_token and page_id are required (provide in request or set FB_PAGE_ACCESS_TOKEN / FB_PAGE_ID in .env)",
        )

    fb = FacebookAuth(access_token)
    try:
        await fb.validate_token()
        stream_url = await fb.get_active_stream_url(page_id)
    except ValueError as e:
        return StreamResponse(status="error", message=str(e))
    except Exception as e:
        return StreamResponse(status="error", message=f"Facebook API error: {e}")
    finally:
        await fb.close()

    await stream_consumer.start(stream_url, request.frame_interval)
    return StreamResponse(
        status="started",
        message="Stream consumer started",
        stream_url=stream_url,
    )


class StreamResolveFBRequest(BaseModel):
    facebook_url: str
    frame_interval: float = 1.0


@router.post("/start-facebook-url", response_model=StreamResponse)
async def start_stream_facebook_url(request: StreamResolveFBRequest):
    """Resolve a Facebook video URL to an HLS stream via yt-dlp and start consuming."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "yt-dlp", "-g", "-f", "best", request.facebook_url,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30.0)
    except FileNotFoundError:
        return StreamResponse(
            status="error",
            message="yt-dlp is not installed. Run: brew install yt-dlp",
        )
    except asyncio.TimeoutError:
        return StreamResponse(status="error", message="yt-dlp timed out")

    if proc.returncode != 0:
        error_msg = stderr.decode().strip().split("\n")[-1] if stderr else "Unknown error"
        return StreamResponse(status="error", message=f"yt-dlp error: {error_msg}")

    stream_url = stdout.decode().strip().split("\n")[0]
    if not stream_url:
        return StreamResponse(status="error", message="Could not extract stream URL")

    try:
        await stream_consumer.start(stream_url, request.frame_interval)
    except RuntimeError as e:
        return StreamResponse(status="error", message=str(e))

    return StreamResponse(
        status="started",
        message="Stream consumer started via yt-dlp",
        stream_url=stream_url,
    )


@router.post("/start-url", response_model=StreamResponse)
async def start_stream_url(request: StreamStartURLRequest):
    """Start consuming a stream from a direct HLS URL (for testing)."""
    try:
        await stream_consumer.start(request.stream_url, request.frame_interval)
    except RuntimeError as e:
        return StreamResponse(status="error", message=str(e))

    return StreamResponse(
        status="started",
        message="Stream consumer started",
        stream_url=request.stream_url,
    )


@router.get("/windows")
async def get_windows():
    """Return a list of visible macOS windows (for the screen capture picker)."""
    try:
        windows = list_windows()
        return {"windows": windows}
    except RuntimeError as e:
        return {"windows": [], "error": str(e)}


@router.get("/windows-debug")
async def get_windows_debug():
    """Return ALL visible windows unfiltered for debugging."""
    from Quartz import (
        CGWindowListCopyWindowInfo, kCGWindowListOptionOnScreenOnly,
        kCGNullWindowID, kCGWindowOwnerName, kCGWindowName,
        kCGWindowBounds, kCGWindowLayer, kCGWindowNumber,
    )
    window_list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID)
    results = []
    for w in window_list:
        bounds = w.get(kCGWindowBounds, {})
        results.append({
            "owner": str(w.get(kCGWindowOwnerName, "")),
            "name": str(w.get(kCGWindowName, "")),
            "layer": int(w.get(kCGWindowLayer, -1)),
            "id": int(w.get(kCGWindowNumber, 0)),
            "w": int(bounds.get("Width", 0)),
            "h": int(bounds.get("Height", 0)),
        })
    return results


@router.post("/phone-upload")
async def phone_upload(file: UploadFile):
    """Accept a photo from an iOS Shortcut (or curl) and process it.

    Always available — no start/stop lifecycle needed.
    """
    image_bytes = await file.read()

    # Save to server/test/
    stream_consumer._phone_frames_received += 1
    seq = stream_consumer._phone_frames_received
    frame_path = os.path.join(TEST_DIR, f"phone_{seq:05d}.jpg")
    with open(frame_path, "wb") as f:
        f.write(image_bytes)

    results = []
    try:
        results = await process_frame(image_bytes)
    except NotImplementedError:
        pass  # VLM not wired up yet — frame is still saved
    except Exception as e:
        logger.error("Phone upload processing error: %s", e)
        return {"status": "error", "message": str(e)}

    payload = {
        "frame_number": seq,
        "timestamp": time.time(),
        "items_updated": results,
        "source": "phone",
    }
    await stream_consumer.broadcast(payload)

    return {
        "status": "ok",
        "frame_number": seq,
        "items_updated": results,
    }


@router.post("/start-screen-capture", response_model=StreamResponse)
async def start_screen_capture(request: ScreenCaptureStartRequest):
    """Start capturing frames from a macOS screen region or window."""
    try:
        await stream_consumer.start_screen_capture(
            region=request.region,
            frame_interval=request.frame_interval,
            window_name=request.window_name,
            window_id=request.window_id,
        )
    except (RuntimeError, ValueError) as e:
        return StreamResponse(status="error", message=str(e))

    return StreamResponse(
        status="started",
        message=f"Screen capture started"
        + (f" for window '{request.window_name}'" if request.window_name else ""),
    )


@router.get("/rtmp-info")
async def rtmp_info():
    """Return RTMP server connection details for Meta glasses setup."""
    local_ip = _get_local_ip()
    stream_key = DEFAULT_STREAM_KEY
    rtmp_url = f"rtmp://{local_ip}:{RTMP_PORT}/live"
    hls_url = f"http://{RTMP_HOST}:{HLS_PORT}/hls/{stream_key}.m3u8"

    # Check if nginx-rtmp container is reachable
    rtmp_ready = False
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(f"http://{RTMP_HOST}:{HLS_PORT}/")
            rtmp_ready = resp.status_code == 200
    except Exception:
        pass

    return {
        "rtmp_url": rtmp_url,
        "stream_key": stream_key,
        "hls_url": hls_url,
        "local_ip": local_ip,
        "rtmp_ready": rtmp_ready,
    }


@router.post("/start-rtmp", response_model=StreamResponse)
async def start_rtmp_stream(request: RTMPStartRequest):
    """Start consuming an RTMP stream via the nginx-rtmp HLS output.

    The Meta glasses push RTMP to nginx, which converts to HLS.
    This endpoint tells the stream consumer to read that HLS output.
    """
    hls_url = f"http://{RTMP_HOST}:{HLS_PORT}/hls/{request.stream_key}.m3u8"

    # Verify nginx-rtmp is running
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"http://{RTMP_HOST}:{HLS_PORT}/")
            if resp.status_code != 200:
                return StreamResponse(
                    status="error",
                    message="RTMP server not responding. Run: docker compose up -d",
                )
    except Exception:
        return StreamResponse(
            status="error",
            message="Cannot reach RTMP server. Run: docker compose up -d",
        )

    # Wait briefly for the HLS playlist to appear (glasses must be streaming)
    hls_ready = False
    for _ in range(3):
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                resp = await client.get(hls_url)
                if resp.status_code == 200:
                    hls_ready = True
                    break
        except Exception:
            pass
        await asyncio.sleep(1.0)

    if not hls_ready:
        return StreamResponse(
            status="error",
            message=(
                f"No active stream found at key '{request.stream_key}'. "
                "Make sure your Meta glasses are streaming to the RTMP URL shown above."
            ),
        )

    try:
        await stream_consumer.start(hls_url, request.frame_interval)
    except RuntimeError as e:
        return StreamResponse(status="error", message=str(e))

    return StreamResponse(
        status="started",
        message="Consuming RTMP stream via HLS",
        stream_url=hls_url,
    )


class DATStartRequest(BaseModel):
    frame_interval: float = 1.0
    resolution: str = "low"


@router.post("/start-dat", response_model=StreamResponse)
async def start_dat_stream(request: DATStartRequest):
    """Initialize DAT SDK streaming mode.

    Sets the stream consumer to 'waiting' state for an iOS DAT SDK client
    to connect via WebSocket. No server-side consumer loop is needed.
    """
    if stream_consumer._task and not stream_consumer._task.done():
        return StreamResponse(
            status="error",
            message="Stream consumer is already running. Stop it first.",
        )

    stream_consumer._status = "waiting"
    stream_consumer._source_type = "dat_sdk"
    stream_consumer._start_time = time.time()
    stream_consumer._frames_processed = 0
    stream_consumer._last_error = None
    stream_consumer._dat_frame_interval = request.frame_interval
    stream_consumer._dat_resolution = request.resolution
    stream_consumer._dat_frames_received = 0

    local_ip = _get_local_ip()
    ws_url = f"ws://{local_ip}:8000/api/stream/ws/dat-upload"

    return StreamResponse(
        status="waiting",
        message="DAT SDK mode active — connect from iOS app",
        stream_url=ws_url,
    )


@router.websocket("/ws/dat-upload")
async def dat_upload_ws(websocket: WebSocket):
    """WebSocket endpoint for DAT SDK frame upload from iOS app.

    iOS app sends binary JPEG messages. Each frame is saved, processed
    through the VLM pipeline, and results are broadcast to the frontend.
    """
    await websocket.accept()
    logger.info("DAT SDK client connected")

    stream_consumer._status = "running"
    stream_consumer._source_type = "dat_sdk"
    if not stream_consumer._start_time:
        stream_consumer._start_time = time.time()

    try:
        while True:
            data = await websocket.receive()

            # Handle config messages from server to client (text)
            if "text" in data:
                # Client sent text — ignore or log
                continue

            image_bytes = data.get("bytes")
            if not image_bytes:
                continue

            # Save frame
            stream_consumer._dat_frames_received += 1
            seq = stream_consumer._dat_frames_received
            frame_path = os.path.join(TEST_DIR, f"dat_{seq:05d}.jpg")
            with open(frame_path, "wb") as f:
                f.write(image_bytes)

            # Process through VLM
            results = []
            try:
                results = await process_frame(image_bytes)
                stream_consumer._frames_processed += 1
            except NotImplementedError:
                stream_consumer._frames_processed += 1
            except Exception as e:
                logger.error("DAT frame processing error: %s", e)
                stream_consumer._last_error = str(e)

            # Broadcast to frontend WebSocket listeners
            payload = {
                "frame_number": seq,
                "timestamp": time.time(),
                "items_updated": results,
                "source": "dat_sdk",
            }
            await stream_consumer.broadcast(payload)

            # Reply to iOS app with results
            await websocket.send_json({
                "status": "ok",
                "frame_number": seq,
                "items_updated": results,
            })

    except WebSocketDisconnect:
        logger.info("DAT SDK client disconnected")
    except Exception:
        logger.exception("DAT WebSocket error")
    finally:
        # Reset to idle if this was the active DAT connection
        if stream_consumer._source_type == "dat_sdk":
            stream_consumer._status = "idle"
            stream_consumer._source_type = "idle"


@router.post("/dat-upload")
async def dat_upload_http(file: UploadFile):
    """HTTP fallback for DAT SDK frame upload.

    Used when WebSocket connection drops (iOS background, network switch).
    Same processing as the WebSocket endpoint.
    """
    image_bytes = await file.read()

    stream_consumer._dat_frames_received += 1
    seq = stream_consumer._dat_frames_received
    frame_path = os.path.join(TEST_DIR, f"dat_{seq:05d}.jpg")
    with open(frame_path, "wb") as f:
        f.write(image_bytes)

    results = []
    try:
        results = await process_frame(image_bytes)
        stream_consumer._frames_processed += 1
    except NotImplementedError:
        stream_consumer._frames_processed += 1
    except Exception as e:
        logger.error("DAT HTTP upload processing error: %s", e)
        return {"status": "error", "message": str(e)}

    payload = {
        "frame_number": seq,
        "timestamp": time.time(),
        "items_updated": results,
        "source": "dat_sdk",
    }
    await stream_consumer.broadcast(payload)

    return {
        "status": "ok",
        "frame_number": seq,
        "items_updated": results,
    }


@router.post("/stop", response_model=StreamResponse)
async def stop_stream():
    """Stop the stream consumer."""
    await stream_consumer.stop()
    return StreamResponse(status="stopped", message="Stream consumer stopped")


@router.get("/config")
async def stream_config():
    """Check whether Facebook credentials are configured in .env."""
    return {
        "has_access_token": bool(os.getenv("FB_PAGE_ACCESS_TOKEN")),
        "has_page_id": bool(os.getenv("FB_PAGE_ID")),
    }


@router.get("/status")
async def stream_status():
    """Return the current stream consumer status."""
    return stream_consumer.get_status()


@router.websocket("/ws/stream-results")
async def stream_results_ws(websocket: WebSocket):
    """WebSocket endpoint that pushes real-time frame detection results."""
    await websocket.accept()
    queue: asyncio.Queue = asyncio.Queue()

    async def on_result(payload: dict):
        await queue.put(payload)

    stream_consumer.register_callback(on_result)
    try:
        while True:
            try:
                result = await asyncio.wait_for(queue.get(), timeout=30.0)
                await websocket.send_json(result)
            except asyncio.TimeoutError:
                # Send keepalive ping
                await websocket.send_json({"type": "ping"})
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("WebSocket error")
    finally:
        stream_consumer.unregister_callback(on_result)
