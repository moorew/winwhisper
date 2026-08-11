"""
Cancellation has to reach the running transcription, not just the database row.

Before this worked, POST /jobs/{id}/cancel wrote status="cancelled" and the
worker carried on regardless — then overwrote the row with "done" when it
finished. Cancelling a long job did nothing at all.
"""
from __future__ import annotations

import time

import pytest

from core.job_worker import is_cancel_requested, request_cancel, _cancel_requested
from core.transcriber import TranscriptionCancelled, Transcriber


class _FakeSegment:
    def __init__(self, index: int) -> None:
        self.start, self.end, self.text = float(index), float(index + 1), f"segment {index}"
        self.words = None


class _FakeInfo:
    duration = 100.0
    language = "en"
    language_probability = 1.0


class _FakeModel:
    """Stands in for WhisperModel — yields segments lazily like the real one."""

    def __init__(self) -> None:
        self.segments_yielded = 0

    def transcribe(self, *_args, **_kwargs):
        def gen():
            for i in range(100):
                self.segments_yielded += 1
                yield _FakeSegment(i)
        return gen(), _FakeInfo()


@pytest.fixture(autouse=True)
def _clear_cancel_state():
    _cancel_requested.clear()
    yield
    _cancel_requested.clear()


def _transcriber_with_fake_model():
    t = Transcriber()
    t._model = _FakeModel()
    t._model_name = "tiny"
    t._device = "cpu"
    return t


def test_transcription_runs_to_completion_when_not_cancelled():
    t = _transcriber_with_fake_model()
    segments, _ = t.transcribe_with_progress("audio.wav", should_continue=lambda: True)
    assert len(segments) == 100


def test_transcription_stops_promptly_once_cancelled():
    t = _transcriber_with_fake_model()
    # Cancel after the 5th segment — the real UI cancels at an arbitrary point.
    seen = {"n": 0}

    def still_wanted() -> bool:
        seen["n"] += 1
        return seen["n"] <= 5

    with pytest.raises(TranscriptionCancelled):
        t.transcribe_with_progress("audio.wav", should_continue=still_wanted)

    # It must abandon the work, not grind through the remaining 95 segments.
    assert t._model.segments_yielded < 20


def test_no_should_continue_callback_means_no_cancellation():
    t = _transcriber_with_fake_model()
    segments, _ = t.transcribe_with_progress("audio.wav")
    assert len(segments) == 100


def test_cancel_registry_round_trip():
    assert not is_cancel_requested("job-1")
    request_cancel("job-1")
    assert is_cancel_requested("job-1")
    assert not is_cancel_requested("job-2")


def test_a_cancelled_job_stays_cancelled(client):
    """
    The worker must not overwrite a cancelled job with its own outcome. This
    used to report "failed" — the user cancelled, then got an error message
    about the run they deliberately stopped.
    """
    created = client.post(
        "/transcribe/upload",
        files={"file": ("cancel-me.wav", b"RIFF....WAVEfmt ", "audio/wav")},
    )
    job_id = created.json()["job_id"]

    r = client.post(f"/jobs/{job_id}/cancel")
    # 409 means the worker reached a terminal state first — a legitimate race,
    # and nothing to assert about cancellation in that case.
    assert r.status_code in (200, 409)
    if r.status_code != 200:
        pytest.skip("worker finished the job before it could be cancelled")

    assert r.json()["cancelled"] is True

    # Settle: the worker clears its in-memory flag once the job leaves the queue,
    # so the durable evidence is the status it lands on.
    for _ in range(50):
        status = client.get(f"/jobs/{job_id}").json()["status"]
        if not is_cancel_requested(job_id):
            break
        time.sleep(0.05)

    assert client.get(f"/jobs/{job_id}").json()["status"] == "cancelled"
