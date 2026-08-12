"""
The transcript preview shown while a job is running.

faster-whisper yields segments one at a time, but the text used to be held in
memory and discarded until the whole file finished — the UI could only show a
percentage. These cover the tail being produced as segments arrive, and being
bounded so a long transcript does not get shipped on every poll.
"""
from __future__ import annotations

from core.transcriber import PREVIEW_CHARS, PREVIEW_SEGMENTS, Transcriber


class _Seg:
    def __init__(self, index: int, text: str) -> None:
        self.start, self.end, self.text = float(index), float(index + 1), text
        self.words = None


class _StreamingModel:
    """Yields a fixed script of segments, like the real model does."""

    def __init__(self, texts) -> None:
        self.texts = texts

    def transcribe(self, _audio, **_kwargs):
        def gen():
            for i, t in enumerate(self.texts):
                yield _Seg(i, t)

        class _Info:
            duration = float(len(self.texts))
        return gen(), _Info()


def _transcriber(texts):
    t = Transcriber()
    t._model = _StreamingModel(texts)
    t._model_name, t._device = "tiny", "cpu"
    return t


def test_preview_grows_as_each_segment_arrives():
    seen: list[str] = []
    t = _transcriber([" Hello there.", " This is a test.", " Goodbye."])

    t.transcribe_with_progress("a.wav", on_partial=seen.append)

    # One update per segment, each containing everything so far.
    assert len(seen) == 3
    assert seen[0] == "Hello there."
    assert seen[1] == "Hello there. This is a test."
    assert seen[2].endswith("Goodbye.")


def test_preview_is_bounded_for_long_transcripts():
    # A two-hour file produces thousands of segments; the preview must not grow
    # without limit, or every 2s poll would ship the whole transcript.
    t = _transcriber([f" Segment number {i} with some filler words." for i in range(400)])

    seen: list[str] = []
    t.transcribe_with_progress("a.wav", on_partial=seen.append)

    assert len(seen) == 400
    assert all(len(text) <= PREVIEW_CHARS for text in seen)
    # The tail is what matters — the most recent words must be present.
    assert "Segment number 399" in seen[-1]
    assert "Segment number 0 " not in seen[-1]


def test_preview_keeps_only_recent_segments():
    t = _transcriber([f" line{i}" for i in range(PREVIEW_SEGMENTS + 10)])
    seen: list[str] = []
    t.transcribe_with_progress("a.wav", on_partial=seen.append)
    assert "line0" not in seen[-1]
    assert f"line{PREVIEW_SEGMENTS + 9}" in seen[-1]


def test_no_callback_is_fine():
    t = _transcriber([" only text"])
    segments, _ = t.transcribe_with_progress("a.wav")
    assert len(segments) == 1


def test_preview_is_cleared_once_the_job_finishes(client):
    """
    Whatever a finished job reports, it must not still be dribbling out a live
    preview — the real transcript is in the database by then.
    """
    from core.job_worker import _live_text, get_live_text

    _live_text["ghost-job"] = "some half-finished text"
    assert get_live_text("ghost-job") == "some half-finished text"

    created = client.post(
        "/transcribe/upload",
        files={"file": ("preview.wav", b"RIFF....WAVEfmt ", "audio/wav")},
    )
    job_id = created.json()["job_id"]

    body = client.get(f"/jobs/{job_id}").json()
    assert "partial_text" in body, "the UI reads this field"
    _live_text.pop("ghost-job", None)
