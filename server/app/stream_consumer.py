"""HLS stream consumer that extracts frames and pipes them through the VLM pipeline."""

import asyncio
import io
import logging
import os
import time
from typing import Callable

import av
from PIL import Image

from app.processing import process_frame
from app.screen_capture import capture_window, find_window_id

TEST_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "test")
os.makedirs(TEST_DIR, exist_ok=True)

logger = logging.getLogger(__name__)


class StreamConsumer:
    """Singleton HLS stream consumer that extracts frames at a configurable interval."""

    _instance: "StreamConsumer | None" = None

    def __new__(cls) -> "StreamConsumer":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self._initialized = True
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()
        self._callbacks: list[Callable] = []
        self._status = "idle"
        self._frames_processed = 0
        self._start_time: float | None = None
        self._last_error: str | None = None
        self._stream_url: str | None = None
        self._source_type: str = "idle"  # "idle", "hls", "screen_capture", "dat_sdk"
        self._phone_frames_received: int = 0
        self._capture_region: dict | None = None
        self._window_id: int | None = None
        self._dat_frame_interval: float = 1.0
        self._dat_resolution: str = "low"
        self._dat_frames_received: int = 0

    def register_callback(self, callback: Callable):
        """Register a callback that receives frame processing results."""
        self._callbacks.append(callback)

    def unregister_callback(self, callback: Callable):
        """Remove a previously registered callback."""
        self._callbacks = [cb for cb in self._callbacks if cb is not callback]

    async def start(self, stream_url: str, frame_interval: float = 1.0):
        """Start consuming the HLS stream in a background task."""
        if self._task and not self._task.done():
            raise RuntimeError("Stream consumer is already running")

        self._stop_event.clear()
        self._stream_url = stream_url
        self._frames_processed = 0
        self._start_time = time.time()
        self._last_error = None
        self._status = "connecting"
        self._source_type = "hls"

        self._task = asyncio.create_task(
            self._consume_loop(stream_url, frame_interval)
        )

    async def start_screen_capture(
        self,
        region: dict | None = None,
        frame_interval: float = 2.0,
        window_name: str | None = None,
        window_id: int | None = None,
    ):
        """Start capturing frames from a macOS window by ID."""
        if self._task and not self._task.done():
            raise RuntimeError("Stream consumer is already running")

        # Resolve window ID from name if not provided directly
        if window_id is None and window_name:
            window_id = find_window_id(window_name)
            if window_id is None:
                raise ValueError(f"No window found matching '{window_name}'")

        if window_id is None:
            raise ValueError("Either window_id or window_name is required")

        self._stop_event.clear()
        self._stream_url = None
        self._frames_processed = 0
        self._start_time = time.time()
        self._last_error = None
        self._status = "running"
        self._source_type = "screen_capture"
        self._window_id = window_id

        self._task = asyncio.create_task(
            self._screen_capture_loop(window_id, frame_interval)
        )

    async def broadcast(self, payload: dict):
        """Broadcast a result payload to all registered WebSocket callbacks."""
        for callback in self._callbacks:
            try:
                await callback(payload)
            except Exception:
                logger.exception("Callback error")

    async def stop(self):
        """Gracefully stop the stream consumer (browser stays open for reuse)."""
        if not self._task or self._task.done():
            self._status = "idle"
            self._source_type = "idle"
            self._capture_region = None
            self._window_id = None
            self._dat_frames_received = 0
            return

        self._stop_event.set()
        try:
            await asyncio.wait_for(self._task, timeout=10.0)
        except asyncio.TimeoutError:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._status = "idle"
        self._source_type = "idle"
        self._capture_region = None
        self._window_id = None
        self._dat_frames_received = 0
        self._task = None

    def get_status(self) -> dict:
        """Return current consumer status."""
        uptime = None
        if self._start_time and self._status not in ("idle", "error"):
            uptime = round(time.time() - self._start_time, 1)

        status_dict = {
            "status": self._status,
            "source_type": self._source_type,
            "frames_processed": self._frames_processed,
            "uptime": uptime,
            "last_error": self._last_error,
            "stream_url": self._stream_url,
            "capture_region": self._capture_region,
            "window_id": self._window_id,
        }
        if self._source_type == "dat_sdk":
            status_dict["dat_config"] = {
                "frame_interval": self._dat_frame_interval,
                "resolution": self._dat_resolution,
                "frames_received": self._dat_frames_received,
            }
        return status_dict

    async def _consume_loop(self, stream_url: str, frame_interval: float):
        """Main loop: open HLS stream, extract frames, process them."""
        backoff = 1.0
        max_backoff = 60.0

        while not self._stop_event.is_set():
            try:
                self._status = "connecting"
                logger.info("Opening stream: %s", stream_url)

                # Open stream in thread executor to avoid blocking
                loop = asyncio.get_running_loop()
                container = await loop.run_in_executor(
                    None, lambda: av.open(stream_url, options={"rtsp_transport": "tcp"})
                )

                self._status = "running"
                backoff = 1.0  # Reset backoff on successful connection

                try:
                    await self._extract_frames(container, frame_interval, loop)
                finally:
                    await loop.run_in_executor(None, container.close)

            except asyncio.CancelledError:
                raise
            except Exception as e:
                error_msg = f"{type(e).__name__}: {e}"
                logger.error("Stream error: %s", error_msg)
                self._last_error = error_msg
                self._status = "reconnecting"

                if self._stop_event.is_set():
                    break

                logger.info("Reconnecting in %.1f seconds...", backoff)
                try:
                    await asyncio.wait_for(
                        self._stop_event.wait(), timeout=backoff
                    )
                    break  # Stop event was set during wait
                except asyncio.TimeoutError:
                    pass  # Timeout expired, retry
                backoff = min(backoff * 2, max_backoff)

        self._status = "idle"

    async def _extract_frames(
        self, container, frame_interval: float, loop: asyncio.AbstractEventLoop
    ):
        """Extract frames from an open container at the given interval."""
        last_frame_time = 0.0
        processing_lock = asyncio.Lock()

        video_stream = None
        for s in container.streams:
            if s.type == "video":
                video_stream = s
                break

        if video_stream is None:
            raise ValueError("No video stream found in container")

        # Decode only keyframes for efficiency
        video_stream.codec_context.skip_frame = "NONKEY"

        def _decode_next():
            """Decode the next video frame (runs in executor)."""
            for frame in container.decode(video=0):
                return frame
            return None

        while not self._stop_event.is_set():
            frame = await loop.run_in_executor(None, _decode_next)
            if frame is None:
                break  # Stream ended

            now = time.time()
            if now - last_frame_time < frame_interval:
                continue  # Skip frame to maintain interval

            last_frame_time = now

            # Skip if previous frame is still being processed
            if processing_lock.locked():
                logger.debug("Skipping frame — VLM still processing")
                continue

            async with processing_lock:
                try:
                    # Convert frame to JPEG bytes
                    image = frame.to_image()
                    buf = io.BytesIO()
                    image.save(buf, format="JPEG", quality=85)
                    jpeg_bytes = buf.getvalue()

                    # Process through VLM pipeline
                    results = await process_frame(jpeg_bytes)
                    self._frames_processed += 1

                    # Broadcast results to registered callbacks
                    result_payload = {
                        "frame_number": self._frames_processed,
                        "timestamp": now,
                        "items_updated": results,
                    }
                    for callback in self._callbacks:
                        try:
                            await callback(result_payload)
                        except Exception:
                            logger.exception("Callback error")

                except Exception as e:
                    logger.error("Frame processing error: %s", e)
                    self._last_error = f"Frame processing: {e}"

    async def _screen_capture_loop(self, window_id: int, frame_interval: float):
        """Capture window frames at a fixed interval and process them."""
        processing_lock = asyncio.Lock()
        loop = asyncio.get_running_loop()

        while not self._stop_event.is_set():
            # Skip if previous frame is still being processed
            if processing_lock.locked():
                logger.debug("Skipping capture — VLM still processing")
            else:
                asyncio.create_task(
                    self._process_screen_frame(window_id, processing_lock, loop)
                )

            # Wait for the interval or until stop is requested
            try:
                await asyncio.wait_for(
                    self._stop_event.wait(), timeout=frame_interval
                )
                break  # stop event was set
            except asyncio.TimeoutError:
                pass  # interval elapsed, continue

        self._status = "idle"
        self._source_type = "idle"

    async def _process_screen_frame(
        self,
        window_id: int,
        lock: asyncio.Lock,
        loop: asyncio.AbstractEventLoop,
    ):
        """Capture a specific window and run it through the VLM pipeline."""
        async with lock:
            try:
                jpeg_bytes = await loop.run_in_executor(
                    None, capture_window, window_id
                )

                # Save frame to test/ directory
                self._frames_processed += 1
                frame_path = os.path.join(TEST_DIR, f"frame_{self._frames_processed:05d}.jpg")
                with open(frame_path, "wb") as f:
                    f.write(jpeg_bytes)
                logger.info("Saved %s", frame_path)

                results = await process_frame(jpeg_bytes)
                now = time.time()

                result_payload = {
                    "frame_number": self._frames_processed,
                    "timestamp": now,
                    "items_updated": results,
                }
                for callback in self._callbacks:
                    try:
                        await callback(result_payload)
                    except Exception:
                        logger.exception("Callback error")

            except Exception as e:
                logger.error("Screen capture processing error: %s", e)
                self._last_error = f"Screen capture: {e}"


# Module-level singleton
stream_consumer = StreamConsumer()
