import io
import tempfile
import wave

from faster_whisper import WhisperModel

# Load model once at module level (base model, CPU)
_model = None


def _get_model() -> WhisperModel:
    global _model
    if _model is None:
        _model = WhisperModel("base", device="cpu", compute_type="int8")
    return _model


def transcribe_audio(audio_data: bytes, language: str = "en") -> str:
    """Transcribe audio bytes (WAV format) to text using Whisper.

    Args:
        audio_data: Raw bytes of a WAV audio file.
        language: Language code for transcription (default: "en").

    Returns:
        Transcribed text as a string.

    Raises:
        ValueError: If audio_data is not valid WAV audio.
    """
    # Validate that we have WAV data
    try:
        buf = io.BytesIO(audio_data)
        with wave.open(buf, "rb") as wf:
            wf.readframes(1)  # Validate the WAV structure
    except Exception:
        raise ValueError("Invalid audio data: expected WAV format")

    # Write to a temp file since faster-whisper needs a file path
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
        tmp.write(audio_data)
        tmp.flush()

        model = _get_model()
        segments, _ = model.transcribe(tmp.name, language=language)
        text = " ".join(segment.text.strip() for segment in segments)

    return text.strip()
