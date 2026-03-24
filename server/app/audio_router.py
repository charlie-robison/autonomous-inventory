"""WebSocket endpoint for streaming audio from a phone mic (e.g. Meta Ray-Ban glasses)."""

import io
import logging
import wave

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.speech_to_text import transcribe_audio

logger = logging.getLogger(__name__)

router = APIRouter(tags=["audio"])


@router.websocket("/ws/audio-stream")
async def audio_stream(websocket: WebSocket):
    """Stream PCM audio over WebSocket and get transcriptions back.

    Protocol:
        Binary messages: Raw PCM audio data (default: 16-bit, mono, 16kHz).
        Text messages (JSON):
            {"action": "transcribe"}  — transcribe buffered audio, return text, clear buffer.
            {"action": "clear"}       — discard buffered audio.
            {"action": "config", "sample_rate": 16000, "channels": 1, "sample_width": 2}
                                      — reconfigure audio format.
        Server responses (JSON):
            {"type": "transcription", "text": "...", "duration_seconds": 3.5}
            {"type": "status", ...}
            {"type": "error", "message": "..."}
    """
    await websocket.accept()
    logger.info("=== AUDIO WS: client connected ===")

    # Audio config defaults (phone mic typically sends 16kHz 16-bit mono)
    sample_rate = 16000
    channels = 1
    sample_width = 2  # bytes per sample (16-bit)

    # PCM buffer
    audio_buffer = bytearray()

    await websocket.send_json({"type": "status", "message": "ready"})
    logger.info("AUDIO WS: sent ready")

    try:
        while True:
            message = await websocket.receive()
            msg_type = message.get("type", "unknown")

            # Handle WebSocket disconnect message
            if msg_type == "websocket.disconnect":
                logger.info("AUDIO WS: received disconnect message")
                break

            # Binary message = raw PCM audio chunk
            if "bytes" in message:
                chunk_len = len(message["bytes"])
                audio_buffer.extend(message["bytes"])
                logger.info("AUDIO WS: received %d bytes of audio (buffer now %d bytes)", chunk_len, len(audio_buffer))
                continue

            # Text message = JSON command
            if "text" in message:
                logger.info("AUDIO WS: received text: %s", message["text"][:200])
                try:
                    data = __import__("json").loads(message["text"])
                except (ValueError, TypeError):
                    logger.warning("AUDIO WS: invalid JSON")
                    await websocket.send_json({
                        "type": "error",
                        "message": "Invalid JSON",
                    })
                    continue

                action = data.get("action")
                logger.info("AUDIO WS: action=%s", action)

                if action == "transcribe":
                    if not audio_buffer:
                        logger.info("AUDIO WS: buffer empty, returning empty transcription")
                        await websocket.send_json({
                            "type": "transcription",
                            "text": "",
                            "duration_seconds": 0.0,
                        })
                        continue

                    logger.info("AUDIO WS: transcribing %d bytes of audio...", len(audio_buffer))
                    wav_bytes = _pcm_to_wav(
                        bytes(audio_buffer), sample_rate, channels, sample_width,
                    )
                    duration = len(audio_buffer) / (sample_rate * channels * sample_width)

                    try:
                        text = transcribe_audio(wav_bytes)
                        logger.info("AUDIO WS: transcription result: %r (%.1fs audio)", text, duration)
                    except Exception as e:
                        logger.error("AUDIO WS: transcription error: %s", e)
                        await websocket.send_json({
                            "type": "error",
                            "message": f"Transcription failed: {e}",
                        })
                        continue
                    finally:
                        audio_buffer.clear()

                    await websocket.send_json({
                        "type": "transcription",
                        "text": text,
                        "duration_seconds": round(duration, 3),
                    })

                elif action == "clear":
                    audio_buffer.clear()
                    await websocket.send_json({
                        "type": "status",
                        "message": "buffer_cleared",
                        "buffer_seconds": 0.0,
                    })

                elif action == "config":
                    sample_rate = data.get("sample_rate", sample_rate)
                    channels = data.get("channels", channels)
                    sample_width = data.get("sample_width", sample_width)
                    await websocket.send_json({
                        "type": "status",
                        "message": "config_updated",
                        "sample_rate": sample_rate,
                        "channels": channels,
                        "sample_width": sample_width,
                    })

                else:
                    logger.warning("AUDIO WS: unknown action: %s", action)
                    await websocket.send_json({
                        "type": "error",
                        "message": f"Unknown action: {action}",
                    })

            else:
                logger.warning("AUDIO WS: unexpected message type: %s keys=%s", msg_type, list(message.keys()))

    except WebSocketDisconnect:
        logger.info("AUDIO WS: client disconnected (WebSocketDisconnect)")
    except Exception:
        logger.exception("AUDIO WS: error")


def _pcm_to_wav(
    pcm_data: bytes,
    sample_rate: int,
    channels: int,
    sample_width: int,
) -> bytes:
    """Wrap raw PCM bytes in a WAV header."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(sample_width)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_data)
    return buf.getvalue()
