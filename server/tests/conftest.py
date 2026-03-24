import os
import pytest

FIXTURES_DIR = os.path.join(os.path.dirname(__file__), "fixtures")


@pytest.fixture
def test_audio_path():
    """Path to a synthetic WAV file saying 'hello world this is a test of speech recognition'."""
    path = os.path.join(FIXTURES_DIR, "test_hello.wav")
    assert os.path.exists(path), f"Test fixture not found: {path}"
    return path


@pytest.fixture
def test_audio_bytes(test_audio_path):
    """Raw bytes of the test WAV file."""
    with open(test_audio_path, "rb") as f:
        return f.read()
