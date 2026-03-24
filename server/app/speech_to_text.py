import array
import io
import struct
import tempfile
import wave

from faster_whisper import WhisperModel

# Use "small" model for better accuracy with quiet/soft speech.
# "base" is faster but misses low-volume audio.
_model = None


def _get_model() -> WhisperModel:
    global _model
    if _model is None:
        _model = WhisperModel("small", device="cpu", compute_type="int8")
    return _model


def _normalize_wav(audio_data: bytes, target_peak: float = 0.9) -> bytes:
    """Amplify quiet WAV audio so the loudest sample reaches target_peak.

    This makes soft/quiet speech audible to Whisper without clipping.
    If the audio is already loud enough, it is returned unchanged.
    """
    buf = io.BytesIO(audio_data)
    with wave.open(buf, "rb") as wf:
        params = wf.getparams()
        raw = wf.readframes(wf.getnframes())

    if params.sampwidth != 2:
        # Only normalize 16-bit audio; pass others through unchanged
        return audio_data

    # Read samples as signed 16-bit integers
    samples = array.array("h")
    samples.frombytes(raw)

    if not samples:
        return audio_data

    peak = max(abs(s) for s in samples)
    if peak == 0:
        return audio_data

    # Only amplify if the peak is below 25% of max — avoids touching already-loud audio
    max_val = 32767
    if peak > max_val * 0.25:
        return audio_data

    gain = (max_val * target_peak) / peak
    normalized = array.array("h", [
        max(-max_val, min(max_val, int(s * gain))) for s in samples
    ])

    out = io.BytesIO()
    with wave.open(out, "wb") as wf:
        wf.setparams(params)
        wf.writeframes(normalized.tobytes())
    return out.getvalue()


def transcribe_audio(audio_data: bytes, language: str = "en") -> str:
    """Transcribe audio bytes (WAV format) to text using Whisper.

    Automatically normalizes quiet audio before transcription so that
    soft/whispered speech is picked up reliably.

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

    # Normalize quiet audio so Whisper can hear it
    audio_data = _normalize_wav(audio_data)

    # Write to a temp file since faster-whisper needs a file path
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
        tmp.write(audio_data)
        tmp.flush()

        model = _get_model()
        segments, _ = model.transcribe(
            tmp.name,
            language=language,
            vad_filter=True,
            vad_parameters=dict(
                min_silence_duration_ms=250,
                speech_pad_ms=200,
                onset=0.15,  # lower = more sensitive to quiet speech
            ),
        )
        text = " ".join(segment.text.strip() for segment in segments)

    return text.strip()
