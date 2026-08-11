"""
End-to-end exercise of the real transcription pipeline.

Downloads a model and pushes audio all the way through the job worker,
transcriber, and database. That costs a ~75 MB download and a minute of CPU,
so it only runs when WINWHISPER_E2E=1 is set (CI does this on a schedule and
before releases; the default `pytest` run stays fast).

    WINWHISPER_E2E=1 pytest tests/test_transcription_e2e.py -v
"""
from __future__ import annotations

import math
import os
import struct
import time
import wave
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("WINWHISPER_E2E") != "1",
    reason="set WINWHISPER_E2E=1 to run the full model-download + transcription path",
)

faster_whisper = pytest.importorskip(
    "faster_whisper", reason="faster-whisper is required for the end-to-end test"
)


def _write_tone_wav(path: Path, seconds: float = 2.0, rate: int = 16_000) -> None:
    """A short 440 Hz tone. Whisper will find no words in it — that is fine, the
    point is to prove the decode → model → persist path completes."""
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = bytearray()
        for i in range(int(rate * seconds)):
            sample = int(12_000 * math.sin(2 * math.pi * 440 * (i / rate)))
            frames += struct.pack("<h", sample)
        w.writeframes(bytes(frames))


def _wait_for(fn, timeout: float, interval: float = 2.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = fn()
        if result:
            return result
        time.sleep(interval)
    return None


def test_download_model_then_transcribe(client, tmp_path):
    # ── 1. Download the smallest model through the API ────────────────────
    assert client.post("/models/tiny/download").status_code == 202

    downloaded = _wait_for(
        lambda: next(
            (m for m in client.get("/models").json()
             if m["name"] == "tiny" and m["is_downloaded"]),
            None,
        ),
        timeout=600,
    )
    assert downloaded, "tiny model did not finish downloading within 10 minutes"
    assert downloaded["size_bytes_local"] > 0

    # ── 2. Transcribe a local file ────────────────────────────────────────
    audio = tmp_path / "tone.wav"
    _write_tone_wav(audio)

    created = client.post("/transcribe/file", json={
        "file_path": str(audio),
        "model_name": "tiny",
        "vad_filter": False,       # a pure tone would be filtered out entirely
        "word_timestamps": True,
    })
    assert created.status_code == 202
    job_id = created.json()["job_id"]

    job = _wait_for(
        lambda: (lambda j: j if j["status"] in ("done", "failed") else None)(
            client.get(f"/jobs/{job_id}").json()
        ),
        timeout=600,
    )
    assert job, "job did not reach a terminal state within 10 minutes"
    assert job["status"] == "done", f"job failed: {job['error_message']}"
    assert job["progress"] == 1.0
    assert job["transcript_id"]

    # ── 3. The transcript is retrievable and points at playable audio ─────
    detail = client.get(f"/transcripts/{job['transcript_id']}")
    assert detail.status_code == 200
    body = detail.json()
    assert body["source_path"] == str(audio)
    # A path handed in by the user is never cleaned up, so it must still be there.
    assert body["source_available"] is True
    assert isinstance(body["segments"], list)

    # ── 4. Deleting it cascades cleanly ───────────────────────────────────
    assert client.delete(f"/transcripts/{body['id']}").status_code == 204
    assert client.get(f"/transcripts/{body['id']}").status_code == 404
