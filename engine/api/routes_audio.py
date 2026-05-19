from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import Job, get_session
from core.job_worker import worker
from features.audio_capture import capture, list_devices

router = APIRouter(prefix="/audio", tags=["audio"])


# ── Response models ───────────────────────────────────────────────────────────

class AudioDevice(BaseModel):
    index: int
    name: str
    channels: int
    sample_rate: float
    is_loopback: bool
    is_default_output: bool
    is_default_input: bool


class CaptureStartRequest(BaseModel):
    device_index: Optional[int] = None
    loopback: bool = False


class CaptureStopRequest(BaseModel):
    transcribe: bool = True
    model_name: str = "base"
    diarize: bool = False


class CaptureStatusResponse(BaseModel):
    active: bool
    loopback: bool
    duration_seconds: float
    device_name: Optional[str]


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _enqueue_capture_job(
    session: AsyncSession,
    file_path: str,
    job_type: str,
    model_name: str,
    diarize: bool,
) -> Job:
    job = Job(
        id=str(uuid.uuid4()),
        status="queued",
        job_type=job_type,
        source_path=file_path,
        source_name=Path(file_path).name,
        model_name=model_name,
        options={
            "diarize": diarize,
            "word_timestamps": True,
            "vad_filter": True,
        },
    )
    session.add(job)
    await session.commit()
    await session.refresh(job)
    await worker.enqueue(job.id)
    return job


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/devices", response_model=List[AudioDevice])
async def get_devices() -> List[AudioDevice]:
    """
    Lists all audio input devices plus WASAPI loopback devices (Windows only).
    """
    try:
        raw = await asyncio.to_thread(list_devices)
        return [AudioDevice(**d) for d in raw]
    except RuntimeError as exc:
        raise HTTPException(503, str(exc))


@router.post("/capture/start", status_code=202)
async def start_capture(req: CaptureStartRequest) -> dict:
    """Begins recording. Pass loopback=true for system audio (Zoom, Teams, etc.)."""
    if capture.is_active:
        raise HTTPException(409, "A capture session is already running")
    try:
        await asyncio.to_thread(capture.start, req.device_index, req.loopback)
        return {
            "status": "recording",
            "loopback": req.loopback,
            "device": capture.device_name,
        }
    except RuntimeError as exc:
        raise HTTPException(503, str(exc))


@router.post("/capture/stop")
async def stop_capture(
    req: CaptureStopRequest,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """
    Stops the active recording.
    If transcribe=true (default) the audio is automatically queued for transcription.
    """
    if not capture.is_active:
        raise HTTPException(409, "No capture session is active")

    try:
        file_path = await asyncio.to_thread(capture.stop)
    except RuntimeError as exc:
        raise HTTPException(500, f"Recording failed: {exc}")

    if not file_path:
        return {"status": "stopped", "file": None}

    if not req.transcribe:
        return {"status": "saved", "file": file_path}

    job_type = "loopback" if capture.is_loopback else "microphone"
    job = await _enqueue_capture_job(
        session,
        file_path,
        job_type=job_type,
        model_name=req.model_name,
        diarize=req.diarize,
    )
    return {
        "status": "transcribing",
        "job_id": job.id,
        "job_type": job_type,
        "file": file_path,
    }


@router.get("/capture/status", response_model=CaptureStatusResponse)
async def capture_status() -> CaptureStatusResponse:
    return CaptureStatusResponse(
        active=capture.is_active,
        loopback=capture.is_loopback,
        duration_seconds=round(capture.duration_seconds, 1),
        device_name=capture.device_name,
    )
