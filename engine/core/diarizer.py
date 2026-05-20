from __future__ import annotations

from typing import List, Optional, Tuple

from core.hardware import get_hardware

_PYANNOTE_PIPELINE_CLS = None
_PYANNOTE_IMPORT_ERROR: Optional[BaseException] = None


def _get_pyannote_pipeline_cls():
    global _PYANNOTE_PIPELINE_CLS, _PYANNOTE_IMPORT_ERROR
    if _PYANNOTE_PIPELINE_CLS is not None:
        return _PYANNOTE_PIPELINE_CLS
    if _PYANNOTE_IMPORT_ERROR is not None:
        raise RuntimeError(
            "pyannote.audio is not available. Run: pip install pyannote.audio"
        ) from _PYANNOTE_IMPORT_ERROR

    try:
        from pyannote.audio import Pipeline
    except Exception as exc:
        _PYANNOTE_IMPORT_ERROR = exc
        raise RuntimeError(
            "pyannote.audio is not available. Run: pip install pyannote.audio"
        ) from exc

    _PYANNOTE_PIPELINE_CLS = Pipeline
    return _PYANNOTE_PIPELINE_CLS

# Windows 11 accent colour palette — one per speaker
SPEAKER_COLORS = [
    "#0078D4",  # Blue
    "#107C10",  # Green
    "#D83B01",  # Orange
    "#8764B8",  # Purple
    "#00B7C3",  # Teal
    "#C239B3",  # Pink
    "#FFB900",  # Gold
    "#E74856",  # Red
]

# (speaker_label, start_seconds, end_seconds)
DiarizationTurn = Tuple[str, float, float]


# ── Overlap-based speaker assignment ─────────────────────────────────────────

def merge_speakers(
    segments: list,
    turns: List[DiarizationTurn],
) -> List[Optional[str]]:
    """
    For each Whisper segment assigns the diarization speaker whose turn
    has the greatest overlap with that segment's time range.
    Returns a parallel list of speaker labels (None if no overlap found).
    """
    labels: List[Optional[str]] = []
    for seg in segments:
        best_speaker: Optional[str] = None
        best_overlap = 0.0
        for speaker, t_start, t_end in turns:
            overlap = min(seg.end, t_end) - max(seg.start, t_start)
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = speaker
        labels.append(best_speaker)
    return labels


# ── Diarizer ─────────────────────────────────────────────────────────────────

class Diarizer:
    """
    Wraps pyannote/speaker-diarization-3.1.
    Lazy-loaded on first use; requires an accepted HuggingFace token.
    All public methods are synchronous — call via asyncio.to_thread.
    """

    def __init__(self) -> None:
        self._pipeline = None
        self._loaded_token: Optional[str] = None

    @property
    def is_loaded(self) -> bool:
        return self._pipeline is not None

    def ensure_loaded(self, hf_token: str) -> None:
        if self._pipeline is not None and self._loaded_token == hf_token:
            return
        self._load(hf_token)

    def _load(self, hf_token: str) -> None:
        pipeline_cls = _get_pyannote_pipeline_cls()
        self._pipeline = None   # free previous pipeline first

        pipeline = pipeline_cls.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=hf_token,
        )

        hw = get_hardware()
        if hw.cuda_available:
            import torch
            pipeline = pipeline.to(torch.device("cuda"))

        self._pipeline = pipeline
        self._loaded_token = hf_token

    def diarize(
        self,
        audio_path: str,
        hf_token: str,
        num_speakers: Optional[int] = None,
        min_speakers: Optional[int] = None,
        max_speakers: Optional[int] = None,
    ) -> List[DiarizationTurn]:
        """
        Runs the diarization pipeline and returns a time-sorted list of
        (speaker_label, start, end) tuples.
        """
        self.ensure_loaded(hf_token)

        kwargs: dict = {}
        if num_speakers is not None:
            kwargs["num_speakers"] = num_speakers
        if min_speakers is not None:
            kwargs["min_speakers"] = min_speakers
        if max_speakers is not None:
            kwargs["max_speakers"] = max_speakers

        result = self._pipeline(audio_path, **kwargs)

        turns: List[DiarizationTurn] = [
            (speaker, turn.start, turn.end)
            for turn, _, speaker in result.itertracks(yield_label=True)
        ]
        turns.sort(key=lambda t: t[1])
        return turns

    def unload(self) -> None:
        self._pipeline = None
        self._loaded_token = None


# Module-level singleton shared by the job worker
diarizer = Diarizer()
