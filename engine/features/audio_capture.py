from __future__ import annotations

import sys
import threading
import time
import uuid
import wave
from typing import Dict, List, Optional

from core.storage import storage

# ── Platform-aware audio import ───────────────────────────────────────────────
# pyaudiowpatch exposes WASAPI loopback on Windows.
# On non-Windows dev machines we fall back to vanilla PyAudio (mic only).

_WASAPI_AVAILABLE = False

if sys.platform == "win32":
    try:
        import pyaudiowpatch as _pa_mod  # type: ignore
        _WASAPI_AVAILABLE = True
    except Exception:
        try:
            import pyaudio as _pa_mod  # type: ignore
        except Exception:
            _pa_mod = None  # type: ignore
else:
    try:
        import pyaudio as _pa_mod  # type: ignore
    except Exception:
        _pa_mod = None  # type: ignore

_PA_AVAILABLE = _pa_mod is not None


def _chunk_level(data: bytes) -> float:
    """
    RMS of a 16-bit PCM chunk, normalised to 0..1 and lightly compressed so
    ordinary speech fills a useful part of the meter rather than hugging zero.
    """
    if not data:
        return 0.0
    try:
        import numpy as np

        samples = np.frombuffer(data, dtype=np.int16).astype(np.float32)
        if samples.size == 0:
            return 0.0
        rms = float(np.sqrt(np.mean(np.square(samples)))) / 32768.0
    except Exception:
        # numpy is a declared dependency, but never let the meter break capture.
        return 0.0
    # sqrt curve: speech peaks around 0.1-0.2 RMS, which would otherwise be a
    # barely-visible meter.
    return max(0.0, min(1.0, rms ** 0.5))


def _require_pa() -> None:
    if not _PA_AVAILABLE:
        raise RuntimeError(
            "PyAudio is not available. "
            "On Windows install pyaudiowpatch: pip install pyaudiowpatch"
        )


# ── Device enumeration ────────────────────────────────────────────────────────

def list_devices() -> List[Dict]:
    """
    Returns all audio input devices + WASAPI loopback devices.
    Synchronous — call via asyncio.to_thread.
    """
    _require_pa()
    pa = _pa_mod.PyAudio()
    devices: List[Dict] = []

    try:
        wasapi_default_in = -1
        wasapi_default_out = -1
        try:
            wasapi = pa.get_host_api_info_by_type(_pa_mod.paWASAPI)
            wasapi_default_in = wasapi.get("defaultInputDevice", -1)
            wasapi_default_out = wasapi.get("defaultOutputDevice", -1)
        except Exception:
            pass

        for i in range(pa.get_device_count()):
            try:
                info = pa.get_device_info_by_index(i)
                if info.get("maxInputChannels", 0) < 1:
                    continue
                devices.append(
                    {
                        "index": i,
                        "name": info["name"],
                        "channels": int(info["maxInputChannels"]),
                        "sample_rate": float(info["defaultSampleRate"]),
                        "is_loopback": False,
                        "is_default_output": i == wasapi_default_out,
                        "is_default_input": i == wasapi_default_in,
                    }
                )
            except Exception:
                continue

        # WASAPI loopback devices (Windows only)
        if _WASAPI_AVAILABLE and hasattr(pa, "get_loopback_device_info_generator"):
            for lb in pa.get_loopback_device_info_generator():
                devices.append(
                    {
                        "index": int(lb["index"]),
                        "name": lb["name"],
                        "channels": int(lb["maxInputChannels"]),
                        "sample_rate": float(lb["defaultSampleRate"]),
                        "is_loopback": True,
                        "is_default_output": False,
                        "is_default_input": False,
                    }
                )
    finally:
        pa.terminate()

    return devices


# ── Capture class ─────────────────────────────────────────────────────────────

class AudioCapture:
    """
    Records system audio (WASAPI loopback) or microphone to a WAV file.
    All public methods are synchronous — call start/stop via asyncio.to_thread.
    """

    def __init__(self) -> None:
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._output_path: Optional[str] = None
        self._active = False
        self._loopback = False
        self._device_name: Optional[str] = None
        self._start_time: Optional[float] = None
        self._record_error: Optional[str] = None
        # Rolling RMS of the most recent chunk, 0..1 — drives the floating
        # recorder's level meter so it shows real audio rather than an animation.
        self._level = 0.0

    # ── Properties ────────────────────────────────────────────────────────

    @property
    def is_active(self) -> bool:
        return self._active

    @property
    def is_loopback(self) -> bool:
        return self._loopback

    @property
    def device_name(self) -> Optional[str]:
        return self._device_name

    @property
    def level(self) -> float:
        """Loudness of the last chunk, 0..1. Zero when not recording."""
        return self._level if self._active else 0.0

    @property
    def duration_seconds(self) -> float:
        if not self._active or self._start_time is None:
            return 0.0
        return time.time() - self._start_time

    # ── Public API ────────────────────────────────────────────────────────

    def start(
        self,
        device_index: Optional[int] = None,
        loopback: bool = False,
    ) -> None:
        if self._active:
            raise RuntimeError("A capture session is already running")
        _require_pa()

        self._output_path = str(
            storage.temp_audio_path(f"capture_{uuid.uuid4().hex[:8]}.wav")
        )
        self._loopback = loopback
        self._record_error = None
        self._stop_event.clear()
        self._active = True
        self._start_time = time.time()

        self._thread = threading.Thread(
            target=self._record_loop,
            args=(device_index, loopback),
            daemon=True,
            name="audio-capture",
        )
        self._thread.start()

    def stop(self) -> Optional[str]:
        """Signals stop, waits for the recording thread, returns the WAV path."""
        if not self._active:
            return None

        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=15)

        self._active = False
        self._start_time = None

        path = self._output_path
        self._output_path = None

        if self._record_error:
            raise RuntimeError(f"Recording error: {self._record_error}")

        return path

    # ── Recording thread ──────────────────────────────────────────────────

    def _record_loop(self, device_index: Optional[int], loopback: bool) -> None:
        pa = _pa_mod.PyAudio()
        try:
            device_info = self._resolve_device(pa, device_index, loopback)
            self._device_name = device_info["name"]

            channels = min(int(device_info["maxInputChannels"]), 2)
            rate = int(device_info["defaultSampleRate"])

            stream = pa.open(
                format=_pa_mod.paInt16,
                channels=channels,
                rate=rate,
                input=True,
                input_device_index=int(device_info["index"]),
                frames_per_buffer=1024,
            )

            frames = []
            while not self._stop_event.is_set():
                try:
                    data = stream.read(1024, exception_on_overflow=False)
                    frames.append(data)
                    self._level = _chunk_level(data)
                except Exception:
                    break

            self._level = 0.0
            stream.stop_stream()
            stream.close()

            if self._output_path and frames:
                with wave.open(self._output_path, "wb") as wf:
                    wf.setnchannels(channels)
                    wf.setsampwidth(pa.get_sample_size(_pa_mod.paInt16))
                    wf.setframerate(rate)
                    wf.writeframes(b"".join(frames))

        except Exception as exc:
            self._record_error = str(exc)
        finally:
            pa.terminate()

    def _resolve_device(
        self, pa, device_index: Optional[int], loopback: bool
    ) -> dict:
        if loopback and _WASAPI_AVAILABLE:
            return self._resolve_loopback(pa, device_index)

        if device_index is not None:
            return pa.get_device_info_by_index(device_index)
        return pa.get_default_input_device_info()

    def _resolve_loopback(self, pa, device_index: Optional[int]) -> dict:
        if device_index is not None:
            return pa.get_device_info_by_index(device_index)

        try:
            wasapi = pa.get_host_api_info_by_type(_pa_mod.paWASAPI)
            default_out_idx = wasapi["defaultOutputDevice"]
            default_out = pa.get_device_info_by_index(default_out_idx)
            default_name = default_out["name"]
        except Exception:
            default_name = ""

        loopbacks = list(pa.get_loopback_device_info_generator())
        if not loopbacks:
            raise RuntimeError("No WASAPI loopback devices found on this system")

        # Prefer the loopback that matches the default output device name
        for lb in loopbacks:
            if default_name and default_name in lb["name"]:
                return lb

        return loopbacks[0]


# Module-level singleton
capture = AudioCapture()
