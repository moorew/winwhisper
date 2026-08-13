from __future__ import annotations

import asyncio
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from core.database import Job, Segment, Speaker, Transcript, get_session
from core import remote
from core.job_worker import worker
from core.storage import storage

router = APIRouter(tags=["transcription"])


# ── Request / Response models ───────────────────────────────────────────────

class TranscribeFileRequest(BaseModel):
    file_path: str
    model_name: str = "base"
    language: Optional[str] = None
    diarize: bool = False
    translate: bool = False
    word_timestamps: bool = True
    vad_filter: bool = True
    num_speakers: Optional[int] = None
    min_speakers: Optional[int] = None
    max_speakers: Optional[int] = None
    # Hostname of one of your other machines, or None/"local" for this one.
    # Resolved against live discovery — never a URL.
    device: Optional[str] = None


class TranscribeYouTubeRequest(BaseModel):
    url: str
    model_name: str = "base"
    language: Optional[str] = None
    diarize: bool = False
    translate: bool = False
    word_timestamps: bool = True
    num_speakers: Optional[int] = None
    min_speakers: Optional[int] = None
    max_speakers: Optional[int] = None
    # Hostname of one of your other machines, or None/"local" for this one.
    # Resolved against live discovery — never a URL.
    device: Optional[str] = None


class JobCreatedResponse(BaseModel):
    job_id: str
    status: str


class SegmentResponse(BaseModel):
    id: int
    segment_index: int
    start: float
    end: float
    text: str
    speaker_label: Optional[str]
    confidence: Optional[float]
    cps: Optional[float]
    words: Optional[List[Any]]

    model_config = {"from_attributes": True}


class SpeakerResponse(BaseModel):
    id: int
    label: str
    name: Optional[str]
    color: Optional[str]

    model_config = {"from_attributes": True}


class SpeakerUpdateRequest(BaseModel):
    name: str
    color: Optional[str] = None


class TranscriptResponse(BaseModel):
    id: str
    job_id: str
    title: str
    language: Optional[str]
    language_probability: Optional[float]
    duration: Optional[float]
    word_count: int
    source_type: str
    created_at: datetime
    # Original media path, taken from the owning job. Present so the editor can
    # render a waveform player; None when the job row is gone.
    source_path: Optional[str]
    # Whether that file still exists on disk. Uploads and YouTube downloads live
    # in temp/ and are deleted once transcription finishes, so a non-null
    # source_path is not on its own enough to play audio back.
    source_available: bool
    # Size of that file, so the reader can show "34.2 MB" beside the path.
    source_size_bytes: Optional[int]
    segments: List[SegmentResponse]
    speakers: List[SpeakerResponse]

    model_config = {"from_attributes": True}


class TranscriptSummary(BaseModel):
    id: str
    title: str
    language: Optional[str]
    duration: Optional[float]
    word_count: int
    source_type: str
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Helpers ─────────────────────────────────────────────────────────────────

def _build_options(
    diarize: bool,
    translate: bool,
    word_timestamps: bool,
    vad_filter: bool,
    language: Optional[str],
    num_speakers: Optional[int] = None,
    min_speakers: Optional[int] = None,
    max_speakers: Optional[int] = None,
) -> dict:
    return {
        "diarize": diarize,
        "translate": translate,
        "word_timestamps": word_timestamps,
        "vad_filter": vad_filter,
        "language": language,
        "num_speakers": num_speakers,
        "min_speakers": min_speakers,
        "max_speakers": max_speakers,
    }


async def _resolve_device(device: Optional[str]) -> Optional[str]:
    """
    Turns a requested device name into one we have actually seen, or raises.

    Only the name crosses the API. Accepting a URL instead would let anything
    able to reach this engine point it at an address of its choosing, so the
    resolution happens here against live discovery.
    """
    if not device or device.lower() == "local":
        return None

    found = await remote.find_device(device)
    if found is None:
        raise HTTPException(
            404,
            f"'{device}' is not one of your devices, or it is not sharing its "
            "engine right now.",
        )
    if not found.reachable:
        raise HTTPException(409, f"{found.hostname} is not answering right now.")
    return found.hostname


async def _create_and_enqueue(
    session: AsyncSession,
    *,
    job_type: str,
    model_name: str,
    options: dict,
    source_path: Optional[str] = None,
    source_url: Optional[str] = None,
    source_name: Optional[str] = None,
    remote_device: Optional[str] = None,
) -> Job:
    job = Job(
        id=str(uuid.uuid4()),
        status="queued",
        job_type=job_type,
        source_path=source_path,
        source_url=source_url,
        source_name=source_name,
        model_name=model_name,
        options=options,
        remote_device=remote_device,
    )
    session.add(job)
    await session.commit()
    await session.refresh(job)
    await worker.enqueue(job.id)
    return job


# ── Transcription endpoints ──────────────────────────────────────────────────

@router.post("/transcribe/file", response_model=JobCreatedResponse, status_code=202)
async def transcribe_file(
    req: TranscribeFileRequest,
    session: AsyncSession = Depends(get_session),
) -> JobCreatedResponse:
    path = Path(req.file_path)
    if not path.exists():
        raise HTTPException(404, f"File not found: {req.file_path}")

    job = await _create_and_enqueue(
        session,
        job_type="file",
        model_name=req.model_name,
        options=_build_options(
            req.diarize, req.translate, req.word_timestamps,
            req.vad_filter, req.language,
            req.num_speakers, req.min_speakers, req.max_speakers,
        ),
        source_path=str(path),
        source_name=path.name,
        remote_device=await _resolve_device(req.device),
    )
    return JobCreatedResponse(job_id=job.id, status=job.status)


@router.post("/transcribe/upload", response_model=JobCreatedResponse, status_code=202)
async def transcribe_upload(
    file: UploadFile = File(...),
    # These MUST be Form(...). A bare scalar in a FastAPI endpoint is read from
    # the query string, so the multipart fields the app sends were silently
    # discarded and every upload fell back to these defaults — picking large-v3
    # in the UI still transcribed with base.
    model_name: str = Form("base"),
    language: Optional[str] = Form(None),
    diarize: bool = Form(False),
    translate: bool = Form(False),
    word_timestamps: bool = Form(True),
    vad_filter: bool = Form(True),
    # Form(...) for the same reason as the rest: a bare scalar would be read
    # from the query string and the chosen device silently dropped.
    device: Optional[str] = Form(None),
    session: AsyncSession = Depends(get_session),
) -> JobCreatedResponse:
    dest = storage.temp_audio_path(f"{uuid.uuid4()}_{file.filename}")
    dest.write_bytes(await file.read())

    job = await _create_and_enqueue(
        session,
        job_type="file",
        model_name=model_name,
        options=_build_options(diarize, translate, word_timestamps, vad_filter, language),
        source_path=str(dest),
        source_name=file.filename,
        remote_device=await _resolve_device(device),
    )
    return JobCreatedResponse(job_id=job.id, status=job.status)


@router.post("/transcribe/youtube", response_model=JobCreatedResponse, status_code=202)
async def transcribe_youtube(
    req: TranscribeYouTubeRequest,
    session: AsyncSession = Depends(get_session),
) -> JobCreatedResponse:
    job = await _create_and_enqueue(
        session,
        job_type="youtube",
        model_name=req.model_name,
        options=_build_options(
            req.diarize, req.translate, True, True, req.language,
            req.num_speakers, req.min_speakers, req.max_speakers,
        ),
        source_url=req.url,
        source_name=req.url,
        remote_device=await _resolve_device(req.device),
    )
    return JobCreatedResponse(job_id=job.id, status=job.status)


# ── YouTube metadata preview ─────────────────────────────────────────────────

@router.get("/youtube/metadata")
async def youtube_metadata(url: str) -> dict:
    """
    Fetches video title, duration, uploader, and thumbnail without downloading.
    Call this when the user pastes a URL so the UI can show a preview card
    before the user clicks Transcribe.
    """
    from features.youtube import extractor
    try:
        return await asyncio.to_thread(extractor.get_metadata, url)
    except Exception as exc:
        raise HTTPException(400, f"Could not fetch video info: {exc}")


# ── Transcript endpoints ──────────────────────────────────────────────────────

@router.get("/transcripts", response_model=List[TranscriptSummary])
async def list_transcripts(
    limit: int = 50,
    offset: int = 0,
    session: AsyncSession = Depends(get_session),
) -> List[Transcript]:
    result = await session.execute(
        select(Transcript)
        .order_by(desc(Transcript.created_at))
        .offset(offset)
        .limit(limit)
    )
    return result.scalars().all()


@router.get("/transcripts/{transcript_id}", response_model=TranscriptResponse)
async def get_transcript(
    transcript_id: str,
    session: AsyncSession = Depends(get_session),
) -> TranscriptResponse:
    result = await session.execute(
        select(Transcript)
        .where(Transcript.id == transcript_id)
        .options(
            selectinload(Transcript.segments),
            selectinload(Transcript.speakers),
            selectinload(Transcript.job),
        )
    )
    transcript = result.scalar_one_or_none()
    if not transcript:
        raise HTTPException(404, "Transcript not found")

    # source_path lives on the job, not the transcript. Surface it (plus a
    # liveness check) so the editor knows whether it can offer playback.
    source_path = transcript.job.source_path if transcript.job else None
    source_available = bool(source_path and Path(source_path).is_file())
    source_size_bytes = Path(source_path).stat().st_size if source_available else None

    return TranscriptResponse(
        id=transcript.id,
        job_id=transcript.job_id,
        title=transcript.title,
        language=transcript.language,
        language_probability=transcript.language_probability,
        duration=transcript.duration,
        word_count=transcript.word_count,
        source_type=transcript.source_type,
        created_at=transcript.created_at,
        source_path=source_path,
        source_available=source_available,
        source_size_bytes=source_size_bytes,
        segments=[SegmentResponse.model_validate(s) for s in transcript.segments],
        speakers=[SpeakerResponse.model_validate(s) for s in transcript.speakers],
    )


@router.delete("/transcripts/{transcript_id}", status_code=204)
async def delete_transcript(
    transcript_id: str,
    session: AsyncSession = Depends(get_session),
) -> None:
    transcript = await session.get(Transcript, transcript_id)
    if not transcript:
        raise HTTPException(404, "Transcript not found")
    await session.delete(transcript)
    await session.commit()


# ── Speaker management ────────────────────────────────────────────────────────

@router.put(
    "/transcripts/{transcript_id}/speakers/{speaker_id}",
    response_model=SpeakerResponse,
)
async def update_speaker(
    transcript_id: str,
    speaker_id: int,
    body: SpeakerUpdateRequest,
    session: AsyncSession = Depends(get_session),
) -> Speaker:
    """Rename a speaker or change their colour. Used by the Subtitle Editor."""
    result = await session.execute(
        select(Speaker)
        .where(Speaker.id == speaker_id, Speaker.transcript_id == transcript_id)
    )
    speaker = result.scalar_one_or_none()
    if not speaker:
        raise HTTPException(404, "Speaker not found")
    speaker.name = body.name
    if body.color is not None:
        speaker.color = body.color
    await session.commit()
    await session.refresh(speaker)
    return speaker
