from __future__ import annotations

from pathlib import Path
from typing import Callable, Optional, Tuple

from core.hardware import get_hardware
from core.storage import storage

_WHISPER_MODEL_CLS = None
_WHISPER_IMPORT_ERROR: Optional[BaseException] = None

# Substrings that mark a failure as "the GPU stack is broken" rather than a
# genuine transcription error. Only consulted when the model is on CUDA, so a
# CPU-side failure can never be misread as one of these.
_GPU_ERROR_MARKERS = (
    "cublas", "cudnn", "cuda", "libcu", "cufft", "nvrtc", "gpu", "out of memory",
)


def _is_gpu_runtime_error(exc: BaseException) -> bool:
    message = f"{type(exc).__name__}: {exc}".lower()
    return any(marker in message for marker in _GPU_ERROR_MARKERS)


class TranscriptionCancelled(Exception):
    """Raised when a caller asks to abandon an in-flight transcription."""


def _get_whisper_model_cls():
    global _WHISPER_MODEL_CLS, _WHISPER_IMPORT_ERROR
    if _WHISPER_MODEL_CLS is not None:
        return _WHISPER_MODEL_CLS
    if _WHISPER_IMPORT_ERROR is not None:
        raise RuntimeError(
            "faster-whisper is not available. Run: pip install faster-whisper"
        ) from _WHISPER_IMPORT_ERROR

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        _WHISPER_IMPORT_ERROR = exc
        raise RuntimeError(
            "faster-whisper is not available. Run: pip install faster-whisper"
        ) from exc

    _WHISPER_MODEL_CLS = WhisperModel
    return _WHISPER_MODEL_CLS


class Transcriber:
    """
    Wraps faster-whisper's WhisperModel with lazy loading and progress callbacks.
    Designed to be called from asyncio.to_thread — all methods are synchronous.
    """

    def __init__(self) -> None:
        self._model: Optional[object] = None
        self._model_name: Optional[str] = None
        self._device: Optional[str] = None

    @property
    def loaded_model(self) -> Optional[str]:
        return self._model_name

    @property
    def device(self) -> Optional[str]:
        """The device the loaded model actually ended up on (may differ from the
        recommendation when a GPU load failed and we fell back to CPU)."""
        return self._device

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    def ensure_loaded(self, model_name: str) -> None:
        """Load model if not already loaded, or if a different model is requested."""
        if self._model_name == model_name and self._model is not None:
            return
        self._load(model_name)

    def _load(self, model_name: str, force_cpu: bool = False) -> None:
        whisper_model_cls = _get_whisper_model_cls()
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

        device = "cpu" if force_cpu else hw.recommended_device
        compute_type = "int8" if force_cpu else hw.recommended_compute_type

        try:
            self._model = whisper_model_cls(
                str(model_path),
                device=device,
                compute_type=compute_type,
                num_workers=1,
            )
        except Exception as exc:
            # A GPU can be detected and still be unusable: mismatched driver,
            # missing cuBLAS/cuDNN, or too little free VRAM for the model. Rather
            # than failing the job outright, retry on CPU — slower beats broken.
            if device != "cuda":
                raise
            print(
                f"[WinWhisper] GPU load failed ({exc}) — falling back to CPU. "
                "Transcription will be slower.",
                flush=True,
            )
            self._model = whisper_model_cls(
                str(model_path),
                device="cpu",
                compute_type="int8",
                num_workers=1,
            )
            device = "cpu"

        self._device = device
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
        should_continue: Optional[Callable[[], bool]] = None,
    ) -> Tuple[list, object]:
        """
        Transcribes audio_path and returns (segments_list, TranscriptionInfo).
        Calls on_progress(0.0–0.99) as segments stream in.
        Runs synchronously — call via asyncio.to_thread.
        """
        if self._model is None:
            raise RuntimeError("No model loaded. Call ensure_loaded() first.")

        def _run() -> Tuple[list, object]:
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
                # faster-whisper decodes lazily, so this loop is where the time
                # actually goes — and therefore the only place a long job can be
                # interrupted. Checked per segment, so cancelling takes effect
                # within a few seconds rather than at the end of the file.
                if should_continue is not None and not should_continue():
                    raise TranscriptionCancelled()
                segments.append(seg)
                if on_progress and getattr(info, "duration", 0) and info.duration > 0:
                    on_progress(min(seg.end / info.duration, 0.99))

            return segments, info

        try:
            return _run()
        except TranscriptionCancelled:
            raise
        except Exception as exc:
            # CTranslate2 loads its CUDA libraries lazily, so a broken GPU setup
            # (missing cuBLAS/cuDNN, stale driver) does not surface when the model
            # is constructed — it blows up here, part-way through inference. Retry
            # the whole job on CPU instead of reporting failure to the user.
            if self._device != "cuda" or not _is_gpu_runtime_error(exc):
                raise
            print(
                f"[WinWhisper] GPU inference failed ({exc}) — retrying on CPU. "
                "Transcription will be slower.",
                flush=True,
            )
            if on_progress:
                on_progress(0.0)
            self._load(self._model_name or "", force_cpu=True)
            return _run()

    def unload(self) -> None:
        self._model = None
        self._model_name = None
        self._device = None


# Module-level singleton — shared by the job worker
transcriber = Transcriber()
