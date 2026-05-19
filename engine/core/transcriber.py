from __future__ import annotations

from pathlib import Path
from typing import Callable, List, Optional, Tuple

from core.hardware import get_hardware
from core.storage import storage

try:
    from faster_whisper import WhisperModel
    from faster_whisper.transcribe import Segment, TranscriptionInfo
    _FASTER_WHISPER_AVAILABLE = True
except ImportError:
    _FASTER_WHISPER_AVAILABLE = False
    WhisperModel = None  # type: ignore


class Transcriber:
    """
    Wraps faster-whisper's WhisperModel with lazy loading and progress callbacks.
    Designed to be called from asyncio.to_thread — all methods are synchronous.
    """

    def __init__(self) -> None:
        self._model: Optional[object] = None
        self._model_name: Optional[str] = None

    @property
    def loaded_model(self) -> Optional[str]:
        return self._model_name

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    def ensure_loaded(self, model_name: str) -> None:
        """Load model if not already loaded, or if a different model is requested."""
        if self._model_name == model_name and self._model is not None:
            return
        self._load(model_name)

    def _load(self, model_name: str) -> None:
        if not _FASTER_WHISPER_AVAILABLE:
            raise RuntimeError(
                "faster-whisper is not installed. "
                "Run: pip install faster-whisper"
            )

        hw = get_hardware()
        model_path = storage.model_path(model_name)

        if not model_path.exists():
            raise FileNotFoundError(
                f"Model '{model_name}' is not downloaded. "
                "Download it from Settings > Models first."
            )

        # Drop the existing model to free VRAM/RAM before loading a new one
        self._model = None
        self._model_name = None

        self._model = WhisperModel(
            str(model_path),
            device=hw.recommended_device,
            compute_type=hw.recommended_compute_type,
            num_workers=1,
        )
        self._model_name = model_name

    def transcribe_with_progress(
        self,
        audio_path: str,
        on_progress: Optional[Callable[[float], None]] = None,
        language: Optional[str] = None,
        task: str = "transcribe",
        vad_filter: bool = True,
        word_timestamps: bool = True,
        beam_size: int = 5,
    ) -> Tuple[list, object]:
        """
        Transcribes audio_path and returns (segments_list, TranscriptionInfo).
        Calls on_progress(0.0–0.99) as segments stream in.
        Runs synchronously — call via asyncio.to_thread.
        """
        if self._model is None:
            raise RuntimeError("No model loaded. Call ensure_loaded() first.")

        segments_gen, info = self._model.transcribe(
            audio_path,
            language=language or None,
            task=task,
            vad_filter=vad_filter,
            word_timestamps=word_timestamps,
            beam_size=beam_size,
        )

        segments: list = []
        for seg in segments_gen:
            segments.append(seg)
            if on_progress and getattr(info, "duration", 0) and info.duration > 0:
                on_progress(min(seg.end / info.duration, 0.99))

        return segments, info

    def unload(self) -> None:
        self._model = None
        self._model_name = None


# Module-level singleton — shared by the job worker
transcriber = Transcriber()
