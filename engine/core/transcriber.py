from __future__ import annotations

import time
from pathlib import Path
from typing import Callable, Optional, Tuple

from core import watchdog
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


# Markers for "the VAD model could not be loaded", as opposed to a genuine
# transcription error. Silero ships as an .onnx data file inside faster-whisper.
_VAD_ERROR_MARKERS = (
    "silero", "vad", "onnxruntime", "no_suchfile", "onnx",
)


def _is_vad_runtime_error(exc: BaseException) -> bool:
    message = f"{type(exc).__name__}: {exc}".lower()
    return any(marker in message for marker in _VAD_ERROR_MARKERS)


# Bounds on the live preview handed to the UI while a job runs.
PREVIEW_SEGMENTS = 25
PREVIEW_CHARS = 1200


class TranscriptionCancelled(Exception):
    """Raised when a caller asks to abandon an in-flight transcription."""


def _decode_audio(audio_path: str):
    """
    Turns a media file into the 16 kHz mono waveform faster-whisper wants.

    faster-whisper would do this itself if handed a path, but then it happens
    inside the same opaque call as voice detection and inference — and a
    container it cannot read, or a file another process still holds open, looks
    identical to a slow model. Doing it here means the phase can be timed, named
    in the UI, and blamed by name when it is the one that fails.

    Returns None if decoding is unavailable or fails, in which case the caller
    passes the path through and faster-whisper decodes it as before. This step
    exists to make a phase visible, so it must never be the reason a job dies —
    anything that goes wrong here is left for the real decode to raise.
    """
    started = time.monotonic()
    try:
        from faster_whisper.audio import decode_audio

        audio = decode_audio(audio_path, sampling_rate=16000)
    except Exception as exc:
        print(
            f"[WinWhisper] pre-decode skipped ({exc.__class__.__name__}: {exc}) — "
            "letting faster-whisper read the file directly.",
            flush=True,
        )
        return None

    seconds = len(audio) / 16000
    print(
        f"[WinWhisper] decoded {Path(audio_path).name}: {seconds:.0f}s of audio "
        f"in {time.monotonic() - started:.1f}s",
        flush=True,
    )
    return audio


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
        on_partial: Optional[Callable[[str], None]] = None,
        on_stage: Optional[Callable[[str], None]] = None,
    ) -> Tuple[list, object]:
        """
        Transcribes audio_path and returns (segments_list, TranscriptionInfo).
        Calls on_progress(0.0–0.99) as segments stream in, and on_stage(text) as
        it moves between decoding, speech detection and transcription.
        Runs synchronously — call via asyncio.to_thread.
        """
        if self._model is None:
            raise RuntimeError("No model loaded. Call ensure_loaded() first.")

        def _stage(text: str) -> None:
            if on_stage is not None:
                on_stage(text)

        def _abort_if_cancelled() -> None:
            # Cancellation used to be honoured only between segments, so a job
            # abandoned during decoding or speech detection carried on to the
            # end regardless. Phase boundaries are the other places we get
            # control back without killing a thread mid-call.
            if should_continue is not None and not should_continue():
                raise TranscriptionCancelled()

        _abort_if_cancelled()
        _stage("Decoding audio")
        watchdog.begin("decoding audio")
        # Falls back to the path when pre-decoding is not possible, which keeps
        # the old behaviour rather than failing the job.
        source = _decode_audio(audio_path)
        if source is None:
            source = audio_path
        _abort_if_cancelled()

        def _run(use_vad: bool) -> Tuple[list, object]:
            # Everything up to the first yielded segment happens inside native
            # code with nothing to report: voice activity detection sweeps the
            # whole file, then the first window is encoded. On a long recording
            # that is minutes of apparent stillness, which is precisely what a
            # hang looks like — so name it rather than leaving the bar frozen.
            _stage("Detecting speech" if use_vad else "Preparing audio")
            watchdog.begin("voice activity detection" if use_vad else "preparing audio")

            segments_gen, info = self._model.transcribe(
                source,
                language=language or None,
                task=task,
                vad_filter=use_vad,
                word_timestamps=word_timestamps,
                beam_size=beam_size,
            )

            duration = getattr(info, "duration", 0) or 0
            print(
                f"[WinWhisper] transcribing {duration:.0f}s of audio "
                f"(language={getattr(info, 'language', '?')}, vad={use_vad}, "
                f"device={self._device})",
                flush=True,
            )
            _stage("Transcribing")
            watchdog.begin("transcribing (waiting for the first segment)")
            _abort_if_cancelled()

            segments: list = []
            for seg in segments_gen:
                # Proof of life for the stall watchdog: reaching here means the
                # model is still producing output, however slowly.
                watchdog.beat()
                if not segments:
                    watchdog.begin("transcribing")
                # faster-whisper decodes lazily, so this loop is where the time
                # actually goes — and therefore the only place a long job can be
                # interrupted. Checked per segment, so cancelling takes effect
                # within a few seconds rather than at the end of the file.
                if should_continue is not None and not should_continue():
                    raise TranscriptionCancelled()
                segments.append(seg)
                if on_progress and getattr(info, "duration", 0) and info.duration > 0:
                    on_progress(min(seg.end / info.duration, 0.99))
                if on_partial is not None:
                    # Only the tail: this is a preview, and shipping a whole
                    # two-hour transcript on every poll would be wasteful.
                    # Built from the last few segments so the cost per segment
                    # stays flat rather than growing with the transcript.
                    tail = " ".join(
                        s.text.strip() for s in segments[-PREVIEW_SEGMENTS:]
                    ).strip()
                    on_partial(tail[-PREVIEW_CHARS:])

            return segments, info

        try:
            return self._attempt(_run, vad_filter, on_progress)
        finally:
            watchdog.end()

    def _attempt(
        self,
        _run: Callable[[bool], Tuple[list, object]],
        vad_filter: bool,
        on_progress: Optional[Callable[[float], None]],
    ) -> Tuple[list, object]:
        try:
            return _run(vad_filter)
        except TranscriptionCancelled:
            raise
        except Exception as exc:
            # The Silero VAD model is a data file inside faster-whisper. If a
            # packaging gap leaves it out of the bundle, or onnxruntime cannot
            # load it, that must not cost the user their transcription — voice
            # activity detection is an optimisation, not a requirement.
            if vad_filter and _is_vad_runtime_error(exc):
                print(
                    f"[WinWhisper] Voice activity detection unavailable ({exc}) — "
                    "transcribing without it.",
                    flush=True,
                )
                return _run(False)

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
            return _run(vad_filter)

    def unload(self) -> None:
        self._model = None
        self._model_name = None
        self._device = None


# Module-level singleton — shared by the job worker
transcriber = Transcriber()
