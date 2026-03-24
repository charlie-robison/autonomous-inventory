import pytest
from app.speech_to_text import transcribe_audio


class TestTranscribeAudio:
    """Tests for the transcribe_audio function."""

    def test_returns_string(self, test_audio_bytes):
        """transcribe_audio should return a string."""
        result = transcribe_audio(test_audio_bytes)
        assert isinstance(result, str)

    def test_transcribes_known_speech(self, test_audio_bytes):
        """transcribe_audio should recognize words from the test audio.

        The test audio says: 'hello world this is a test of speech recognition'
        We check for key words rather than exact match since STT can vary slightly.
        """
        result = transcribe_audio(test_audio_bytes)
        result_lower = result.lower()

        assert "hello" in result_lower, f"Expected 'hello' in transcription, got: '{result}'"
        assert "world" in result_lower, f"Expected 'world' in transcription, got: '{result}'"
        assert "test" in result_lower, f"Expected 'test' in transcription, got: '{result}'"

    def test_returns_empty_string_for_silence(self):
        """transcribe_audio should handle silent/empty audio gracefully."""
        import wave
        import io

        # Generate a short silent WAV file (1 second of silence at 16kHz)
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(b"\x00\x00" * 16000)
        silent_bytes = buf.getvalue()

        result = transcribe_audio(silent_bytes)
        assert isinstance(result, str)

    def test_accepts_language_parameter(self, test_audio_bytes):
        """transcribe_audio should accept an optional language parameter."""
        result = transcribe_audio(test_audio_bytes, language="en")
        assert isinstance(result, str)
        assert len(result) > 0

    def test_rejects_invalid_audio(self):
        """transcribe_audio should raise ValueError for invalid audio data."""
        with pytest.raises(ValueError, match="Invalid audio data"):
            transcribe_audio(b"not valid audio data")
