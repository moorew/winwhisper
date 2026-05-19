from __future__ import annotations

import sys
import threading
import uuid
import wave
from pathlib import Path
from typing import Optional

from core.storage import storage

_KEYBOARD_AVAILABLE = False
_PYNPUT_AVAILABLE = False

if sys.platform == "win32":
    try:
        import keyboard as _keyboard  # type: ignore
        _KEYBOARD_AVAILABLE = True
    except ImportError:
        pass

try:
    from pynput.keyboard import Controller as _KbController  # type: ignore
    _PYNPUT_AVAILABLE = True
except ImportError:
    pass

try:
    import pyaudio as _pyaudio  # type: ignore
    _PYAUDIO_AVAILABLE = True
except ImportError:
    try:
        import pyaudiowpatch as _pyaudio  # type: ignore
        _PYAUDIO_AVAILABLE = True
    except ImportError:
        _PYAUDIO_AVAILABLE = False
        _pyaudio = None  # type: ignore

_DICTATION_RATE = 16000  # 16 kHz is optimal for Whisper


class DictationEngine:
    """
    Registers a global Windows hotkey. While held, records the microphone.
    On release, transcribes with faster-whisper and injects the result as
    simulated keystrokes into whichever window has focus.

    All heavy work (recording, transcription, injection) runs in daemon
    threads so the main event loop is never blocked.
    """

    def __init__(self) -> None:
        self._active = False
        self._recording = False
        self._lock = threading.Lock()
        self._hotkey: Optional[str] = None
        self._hook = None

        # Recording state
        self._frames: list = []
        self._stop_record = threading.Event()
        self._record_thread: Optional[threading.Thread] = None

    @property
    def is_active(self) -> bool:
        return self._active

    @property
    def hotkey(self) -> Optional[str]:
        return self._hotkey

    # ── Lifecycle ─────────────────────────────────────────────────────────

    def start(self, hotkey: str) -> None:
        if not _KEYBOARD_AVAILABLE:
            raise RuntimeError(
                "The 'keyboard' library is not available. "
                "On Windows install it: pip install keyboard"
            )
        if self._active:
            return

        self._hotkey = hotkey
        self._hotkey_keys = [k.strip() for k in hotkey.lower().split("+")]

        self._hook = _keyboard.hook(self._on_key_event)
        self._active = True

    def stop(self) -> None:
        if not self._active:
            return
        if self._hook:
            _keyboard.unhook(self._hook)
            self._hook = None
        self._active = False
        # If recording, abort it
        if self._recording:
            self._stop_record.set()

    # ── Keyboard event handler (runs in keyboard's hook thread) ───────────

    def on_key_event(self, event) -> None:
        combo_down = all(_keyboard.is_pressed(k) for k in self._hotkey_keys)

        if combo_down and not self._recording:
            with self._lock:
                if not self._recording:
                    self._recording = True
                    self._start_mic()

        elif not combo_down and self._recording:
            with self._lock:
                if self._recording:
                    self._recording = False
                    threading.Thread(
                        target=self._stop_and_transcribe,
                        daemon=True,
                        name="dictation-transcribe",
                    ).start()

    # Keep the name for the hook registration
    _on_key_event = on_key_event

    # ── Microphone recording ──────────────────────────────────────────────

    def _start_mic(self) -> None:
        self._frames = []
        self._stop_record.clear()
        self._record_thread = threading.Thread(
            target=self._mic_loop,
            daemon=True,
            name="dictation-mic",
        )
        self._record_thread.start()

    def _mic_loop(self) -> None:
        if not _PYAUDIO_AVAILABLE:
            print("[Dictation] PyAudio not available — cannot record mic.", flush=True)
            return
        pa = _pyaudio.PyAudio()
        try:
            stream = pa.open(
                format=_pyaudio.paInt16,
                channels=1,
                rate=_DICTATION_RATE,
                input=True,
                frames_per_buffer=1024,
            )
            while not self._stop_record.is_set():
                try:
                    self._frames.append(stream.read(1024, exception_on_overflow=False))
                except Exception:
                    break
            stream.stop_stream()
            stream.close()
        finally:
            pa.terminate()

    # ── Transcription + injection ─────────────────────────────────────────

    def _stop_and_transcribe(self) -> None:
        self._stop_record.set()
        if self._record_thread:
            self._record_thread.join(timeout=3)

        if not self._frames:
            return

        # Save mic audio to a temp WAV
        audio_path = storage.temp_audio_path(f"dictation_{uuid.uuid4().hex[:8]}.wav")
        try:
            with wave.open(str(audio_path), "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)   # paInt16 = 2 bytes per sample
                wf.setframerate(_DICTATION_RATE)
                wf.writeframes(b"".join(self._frames))

            from core.transcriber import transcriber
            if not transcriber.is_loaded:
                print(
                    "[Dictation] No model loaded — cannot transcribe. "
                    "Transcribe a file first to load the model.",
                    flush=True,
                )
                return

            segments, _ = transcriber.transcribe_with_progress(
                str(audio_path),
                vad_filter=True,
                word_timestamps=False,
                beam_size=3,        # faster than default 5 for real-time feel
            )

            text = " ".join(seg.text.strip() for seg in segments).strip()
            if text:
                self._inject_text(text + " ")   # trailing space for natural flow

        except Exception as exc:
            print(f"[Dictation] Error: {exc}", flush=True)
        finally:
            audio_path.unlink(missing_ok=True)

    def _inject_text(self, text: str) -> None:
        if not _PYNPUT_AVAILABLE:
            print(
                f"[Dictation] pynput not available — cannot inject: {text}",
                flush=True,
            )
            return
        try:
            controller = _KbController()
            controller.type(text)
        except Exception as exc:
            print(f"[Dictation] Keystroke injection failed: {exc}", flush=True)


# Module-level singleton
dictation_engine = DictationEngine()
