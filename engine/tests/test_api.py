"""
Contract tests for every endpoint the desktop frontend calls.

These exist because the frontend talks to the engine over plain HTTP with no
shared schema: a renamed field or a changed status code breaks the UI silently.
Each test here mirrors a real call made by `src/lib/api.ts`.
"""
from __future__ import annotations

import uuid

import pytest

# Field sets the frontend's TypeScript interfaces destructure. Dropping any of
# these is a breaking change even though the endpoint still returns 200.
JOB_FIELDS = {
    "id", "status", "job_type", "source_name", "model_name",
    "progress", "error_message", "created_at", "updated_at", "transcript_id",
}
MODEL_FIELDS = {
    "name", "repo_id", "size_mb", "speed", "description",
    "is_downloaded", "is_active", "is_downloading", "download_progress",
}
TRANSCRIPT_DETAIL_FIELDS = {
    "id", "job_id", "title", "language", "language_probability", "duration",
    "word_count", "source_type", "created_at", "source_path",
    "source_available", "segments", "speakers",
}


# ── System ───────────────────────────────────────────────────────────────────

def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["version"]


def test_status_reports_hardware(client):
    r = client.get("/status")
    assert r.status_code == 200
    hw = r.json()["hardware"]
    assert hw["recommended_device"] in {"cpu", "cuda"}
    assert hw["recommended_compute_type"]


# ── Jobs ─────────────────────────────────────────────────────────────────────

def test_jobs_list_is_a_list(client):
    r = client.get("/jobs")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_jobs_list_accepts_status_and_limit(client):
    # The dashboard polls these three filters every two seconds.
    for status in ("processing", "queued", "failed"):
        r = client.get("/jobs", params={"status": status, "limit": 10})
        assert r.status_code == 200, status
        assert isinstance(r.json(), list)


def test_unknown_job_is_404(client):
    assert client.get(f"/jobs/{uuid.uuid4()}").status_code == 404


def test_cancel_unknown_job_is_404(client):
    assert client.post(f"/jobs/{uuid.uuid4()}/cancel").status_code == 404


# ── Models ───────────────────────────────────────────────────────────────────

def test_models_list_exposes_every_field_the_ui_reads(client):
    r = client.get("/models")
    assert r.status_code == 200
    models = r.json()
    assert models, "expected a non-empty catalogue of known models"
    assert MODEL_FIELDS <= set(models[0])
    assert {"tiny", "base"} <= {m["name"] for m in models}


def test_unknown_model_download_is_404(client):
    assert client.post("/models/not-a-real-model/download").status_code == 404


def test_activating_a_model_that_is_not_downloaded_is_400(client):
    r = client.post("/models/base/activate")
    assert r.status_code == 400
    assert "not downloaded" in r.json()["detail"].lower()


# ── Settings ─────────────────────────────────────────────────────────────────

def test_settings_roundtrip(client):
    assert client.get("/settings").status_code == 200

    r = client.put("/settings/theme", json={"value": "light"})
    assert r.status_code == 200
    assert r.json()["value"] == "light"
    assert client.get("/settings/theme").json()["value"] == "light"


def test_settings_patch_reports_updated_keys(client):
    r = client.patch("/settings", json={"language": "en", "vad_filter": False})
    assert r.status_code == 200
    assert set(r.json()["updated"]) == {"language", "vad_filter"}


# ── Transcription ────────────────────────────────────────────────────────────

def test_transcribe_missing_file_is_404(client):
    r = client.post("/transcribe/file", json={"file_path": "/definitely/not/here.mp3"})
    assert r.status_code == 404


def test_transcribe_upload_queues_a_job(client):
    r = client.post(
        "/transcribe/upload",
        files={"file": ("clip.wav", b"RIFF....WAVEfmt ", "audio/wav")},
    )
    assert r.status_code == 202
    body = r.json()
    assert body["status"] == "queued"

    job = client.get(f"/jobs/{body['job_id']}")
    assert job.status_code == 200
    assert JOB_FIELDS <= set(job.json())


def test_unknown_transcript_is_404(client):
    assert client.get(f"/transcripts/{uuid.uuid4()}").status_code == 404


def test_deleting_unknown_transcript_is_404(client):
    assert client.delete(f"/transcripts/{uuid.uuid4()}").status_code == 404


# ── Watch folder / dictation ─────────────────────────────────────────────────

def test_watch_folder_status_shape(client):
    body = client.get("/watch-folder/status").json()
    assert {"running", "folder_path", "supported_extensions"} <= set(body)
    assert ".mp3" in body["supported_extensions"]


def test_watch_folder_rejects_a_missing_directory(client):
    r = client.post("/watch-folder/start", json={"folder_path": "/no/such/dir"})
    assert r.status_code >= 400


def test_dictation_status_shape(client):
    body = client.get("/dictation/status").json()
    assert {"active", "hotkey", "model_loaded", "loaded_model"} <= set(body)


# ── Transcript detail: source_path / source_available ────────────────────────

@pytest.mark.asyncio
async def test_transcript_detail_exposes_playable_source(client, tmp_path):
    """
    The editor renders its waveform player from `source_path` and gates it on
    `source_available`. Both are derived from the owning job, so a transcript
    whose media still exists must report the path as available, and one whose
    media has been cleaned up must not.
    """
    from core.database import Job, Transcript, async_session_factory

    media = tmp_path / "meeting.wav"
    media.write_bytes(b"RIFF....WAVEfmt ")
    missing = tmp_path / "deleted-from-temp.wav"

    async def make(source_path, title):
        job_id, transcript_id = str(uuid.uuid4()), str(uuid.uuid4())
        async with async_session_factory() as session:
            session.add(Job(
                id=job_id, status="done", job_type="file",
                source_path=str(source_path), source_name=title,
                model_name="tiny", options={},
            ))
            session.add(Transcript(
                id=transcript_id, job_id=job_id, title=title,
                word_count=0, source_type="file",
            ))
            await session.commit()
        return transcript_id

    present_id = await make(media, "present.wav")
    absent_id = await make(missing, "absent.wav")

    present = client.get(f"/transcripts/{present_id}").json()
    assert TRANSCRIPT_DETAIL_FIELDS <= set(present)
    assert present["source_path"] == str(media)
    assert present["source_available"] is True

    absent = client.get(f"/transcripts/{absent_id}").json()
    assert absent["source_path"] == str(missing)
    assert absent["source_available"] is False


def test_transcript_summary_list_includes_new_rows(client):
    r = client.get("/transcripts")
    assert r.status_code == 200
    titles = {t["title"] for t in r.json()}
    assert {"present.wav", "absent.wav"} <= titles
