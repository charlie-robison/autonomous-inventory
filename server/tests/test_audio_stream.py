import io
import json
import struct
import wave
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client():
    return TestClient(app)


def _make_pcm_chunk(num_samples: int = 1600, sample_rate: int = 16000) -> bytes:
    """Generate a short PCM chunk (16-bit mono silence)."""
    return b"\x00\x00" * num_samples


def _make_pcm_speech_chunk(test_audio_path: str) -> bytes:
    """Extract raw PCM bytes from a WAV fixture file."""
    with wave.open(test_audio_path, "rb") as wf:
        return wf.readframes(wf.getnframes())


class TestAudioStreamWebSocket:
    """Tests for the /ws/audio-stream WebSocket endpoint."""

    def test_connect_and_disconnect(self, client):
        """Client can connect and cleanly disconnect."""
        with client.websocket_connect("/ws/audio-stream") as ws:
            # Should receive a welcome/ready message
            msg = ws.receive_json()
            assert msg["type"] == "status"
            assert msg["message"] == "ready"

    def test_send_audio_chunks(self, client):
        """Client can send binary PCM audio chunks."""
        with client.websocket_connect("/ws/audio-stream") as ws:
            ws.receive_json()  # consume ready message

            # Send a few PCM chunks
            for _ in range(3):
                ws.send_bytes(_make_pcm_chunk())

            # Send transcribe command
            ws.send_json({"action": "transcribe"})
            resp = ws.receive_json()
            assert resp["type"] == "transcription"
            assert "text" in resp
            assert "duration_seconds" in resp

    def test_clear_buffer(self, client):
        """Clear action resets the audio buffer."""
        with client.websocket_connect("/ws/audio-stream") as ws:
            ws.receive_json()  # consume ready message

            ws.send_bytes(_make_pcm_chunk())
            ws.send_json({"action": "clear"})
            resp = ws.receive_json()
            assert resp["type"] == "status"
            assert resp["message"] == "buffer_cleared"
            assert resp["buffer_seconds"] == 0.0

    def test_transcribe_empty_buffer(self, client):
        """Transcribing an empty buffer returns empty text."""
        with client.websocket_connect("/ws/audio-stream") as ws:
            ws.receive_json()  # consume ready message

            ws.send_json({"action": "transcribe"})
            resp = ws.receive_json()
            assert resp["type"] == "transcription"
            assert resp["text"] == ""
            assert resp["duration_seconds"] == 0.0

    def test_config_changes_sample_rate(self, client):
        """Client can configure audio parameters."""
        with client.websocket_connect("/ws/audio-stream") as ws:
            ws.receive_json()  # consume ready message

            ws.send_json({
                "action": "config",
                "sample_rate": 44100,
                "channels": 1,
                "sample_width": 2,
            })
            resp = ws.receive_json()
            assert resp["type"] == "status"
            assert resp["sample_rate"] == 44100

    def test_transcribes_real_speech(self, client, test_audio_path):
        """End-to-end: send real speech PCM and get transcription back."""
        pcm_data = _make_pcm_speech_chunk(test_audio_path)

        with client.websocket_connect("/ws/audio-stream") as ws:
            ws.receive_json()  # consume ready message

            # Send PCM in chunks (simulating streaming)
            chunk_size = 3200  # 100ms at 16kHz 16-bit mono
            for i in range(0, len(pcm_data), chunk_size):
                ws.send_bytes(pcm_data[i:i + chunk_size])

            ws.send_json({"action": "transcribe"})
            resp = ws.receive_json()

            assert resp["type"] == "transcription"
            text_lower = resp["text"].lower()
            assert "hello" in text_lower
            assert "world" in text_lower

    def test_buffer_accumulates_across_chunks(self, client):
        """Multiple binary messages accumulate in the buffer."""
        with client.websocket_connect("/ws/audio-stream") as ws:
            ws.receive_json()  # consume ready message

            # Send 5 chunks of 0.1s each = 0.5s total
            for _ in range(5):
                ws.send_bytes(_make_pcm_chunk(num_samples=1600))  # 0.1s

            ws.send_json({"action": "transcribe"})
            resp = ws.receive_json()
            assert resp["type"] == "transcription"
            assert resp["duration_seconds"] == pytest.approx(0.5, abs=0.05)

    def test_unknown_action_returns_error(self, client):
        """Unknown action returns an error message."""
        with client.websocket_connect("/ws/audio-stream") as ws:
            ws.receive_json()  # consume ready message

            ws.send_json({"action": "unknown_action"})
            resp = ws.receive_json()
            assert resp["type"] == "error"
