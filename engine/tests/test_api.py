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
    "stage", "partial_text",
}
MODEL_FIELDS = {
    "name", "repo_id", "size_mb", "speed", "description",
    "is_downloaded", "is_active", "is_downloading", "download_progress",
}
TRANSCRIPT_DETAIL_FIELDS = {
    "id", "job_id", "title", "language", "language_probability", "duration",
    "word_count", "source_type", "created_at", "source_path",
    "source_available", "source_size_bytes", "segments", "speakers",
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


def test_upload_honours_the_model_chosen_in_the_ui(client):
    """
    The dashboard sends model/language/diarize as multipart form fields. They
    used to be declared as bare scalars, which FastAPI reads from the query
    string, so every upload silently transcribed with the default "base" no
    matter what the user picked.
    """
    r = client.post(
        "/transcribe/upload",
        files={"file": ("meeting.wav", b"RIFF....WAVEfmt ", "audio/wav")},
        data={
            "model_name": "large-v3",
            "language": "fr",
            "diarize": "true",
            "translate": "true",
        },
    )
    assert r.status_code == 202

    job = client.get(f"/jobs/{r.json()['job_id']}").json()
    assert job["model_name"] == "large-v3", "the selected model must reach the job"


def test_upload_without_options_still_uses_sane_defaults(client):
    r = client.post(
        "/transcribe/upload",
        files={"file": ("bare.wav", b"RIFF....WAVEfmt ", "audio/wav")},
    )
    assert r.status_code == 202
    assert client.get(f"/jobs/{r.json()['job_id']}").json()["model_name"] == "base"


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


def test_youtube_metadata_rejects_a_bad_url_cleanly(client):
    # Backs the dashboard's preview card: a bad paste must produce a clean 400
    # (yt-dlp absent gives the same), never a 500.
    r = client.get("/youtube/metadata", params={"url": "not-a-real-url"})
    assert r.status_code == 400
    assert "detail" in r.json()


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
    assert {"active", "hotkey", "model_loaded", "loaded_model", "is_recording"} <= set(body)


# ── System audio capture ─────────────────────────────────────────────────────

def test_capture_status_shape(client):
    body = client.get("/audio/capture/status").json()
    assert {"active", "loopback", "duration_seconds", "device_name", "level"} <= set(body)
    assert body["active"] is False


def test_stopping_capture_requires_a_body(client):
    """
    The stop endpoint takes a required model, so a bodyless POST is a 422 — the
    API client used to send exactly that, which would have broken the feature
    the moment any UI called it.
    """
    assert client.post("/audio/capture/stop").status_code == 422


def test_stopping_with_no_active_session_is_409_not_a_crash(client):
    r = client.post("/audio/capture/stop", json={"transcribe": True, "model_name": "tiny"})
    assert r.status_code == 409


def test_devices_endpoint_reports_missing_backend_cleanly(client):
    # 200 where PyAudio/WASAPI is available (Windows), 503 with an actionable
    # message where it is not. Never a 500.
    r = client.get("/audio/devices")
    assert r.status_code in (200, 503)
    if r.status_code == 503:
        assert "pyaudio" in r.json()["detail"].lower()


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


# ── Storage + floating capture window support ────────────────────────────────

def test_storage_breakdown(client):
    """Backs the Settings storage bar, which stacks the three figures."""
    r = client.get("/storage")
    assert r.status_code == 200
    body = r.json()
    assert {"models_bytes", "transcripts_bytes", "cache_bytes", "total_bytes", "models_dir"} <= set(body)
    assert body["total_bytes"] == (
        body["models_bytes"] + body["transcripts_bytes"] + body["cache_bytes"]
    )
    assert all(body[k] >= 0 for k in ("models_bytes", "transcripts_bytes", "cache_bytes"))
    assert body["models_dir"]


def test_capture_status_reports_a_level(client):
    """The floating recorder's meter is driven by this."""
    body = client.get("/audio/capture/status").json()
    assert "level" in body
    assert 0.0 <= body["level"] <= 1.0
    # Nothing is being captured, so there is nothing to show.
    assert body["level"] == 0.0


def test_dictation_status_reports_whether_it_is_recording(client):
    """The dictation HUD is shown for exactly as long as this is true."""
    body = client.get("/dictation/status").json()
    assert "is_recording" in body
    assert body["is_recording"] is False


@pytest.mark.asyncio
async def test_transcript_detail_reports_source_size(client, tmp_path):
    """The reader's Source panel shows the file size beside the path."""
    from core.database import Job, Transcript, async_session_factory

    media = tmp_path / "sized.wav"
    media.write_bytes(b"0" * 4096)
    job_id, transcript_id = str(uuid.uuid4()), str(uuid.uuid4())

    async with async_session_factory() as session:
        session.add(Job(
            id=job_id, status="done", job_type="file", source_path=str(media),
            source_name="sized.wav", model_name="tiny", options={},
        ))
        session.add(Transcript(
            id=transcript_id, job_id=job_id, title="sized.wav",
            word_count=0, source_type="file",
        ))
        await session.commit()

    body = client.get(f"/transcripts/{transcript_id}").json()
    assert body["source_available"] is True
    assert body["source_size_bytes"] == 4096
