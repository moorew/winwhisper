from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import Job, get_session
from core.job_worker import (
    get_live_progress,
    get_live_stage,
    get_live_text,
    request_cancel,
    worker,
)

router = APIRouter(prefix="/jobs", tags=["jobs"])


class JobResponse(BaseModel):
    id: str
    status: str
    job_type: str
    source_name: Optional[str]
    model_name: str
    progress: float
    error_message: Optional[str]
    created_at: datetime
    updated_at: datetime
    transcript_id: Optional[str]
    # What the worker is doing right now ("Transcribing with large-v3"). None
    # unless the job is actively running.
    stage: Optional[str] = None
    # Tail of the transcript so far, while the job is running. None otherwise.
    partial_text: Optional[str] = None

    model_config = {"from_attributes": True}


def _with_live_progress(job: Job) -> JobResponse:
    r = JobResponse.model_validate(job)
    live = get_live_progress(job.id)
    if live is not None:
        r.progress = live
    r.stage = get_live_stage(job.id)
    r.partial_text = get_live_text(job.id)
    return r


@router.get("", response_model=List[JobResponse])
async def list_jobs(
    limit: int = 50,
    offset: int = 0,
    status: Optional[str] = None,
    session: AsyncSession = Depends(get_session),
) -> List[JobResponse]:
    q = select(Job).order_by(desc(Job.created_at)).offset(offset).limit(limit)
    if status:
        q = q.where(Job.status == status)
    result = await session.execute(q)
    return [_with_live_progress(j) for j in result.scalars().all()]


@router.get("/{job_id}", response_model=JobResponse)
async def get_job(
    job_id: str,
    session: AsyncSession = Depends(get_session),
) -> JobResponse:
    job = await session.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return _with_live_progress(job)


@router.post("/{job_id}/cancel", status_code=200)
async def cancel_job(
    job_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    job = await session.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.status not in ("queued", "processing"):
        raise HTTPException(409, f"Job is already {job.status}")

    # Signal the worker as well as writing the status: for a job already being
    # transcribed, the DB row alone was ignored and then overwritten with "done"
    # when the run finished. The worker stops at the next segment boundary.
    request_cancel(job_id)

    job.status = "cancelled"
    job.updated_at = datetime.utcnow()
    await session.commit()
    return {"cancelled": True, "job_id": job_id}


@router.post("/{job_id}/retry", status_code=200)
async def retry_job(
    job_id: str,
    session: AsyncSession = Depends(get_session),
) -> dict:
    """
    Runs a finished-but-unsuccessful job again, from its original source.

    Jobs interrupted by a shutdown are marked failed rather than restarted, so
    that opening the app never begins work nobody asked for. That is only fair
    if getting it going again is one click — otherwise the user has to find the
    file or the link a second time.
    """
    job = await session.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.status in ("queued", "processing"):
        raise HTTPException(409, "Job is already running")
    if not (job.source_url or job.source_path):
        raise HTTPException(
            409, "This job has no source left to run again — submit it afresh."
        )

    job.status = "queued"
    job.progress = 0.0
    job.error_message = None
    job.transcript_id = None
    job.updated_at = datetime.utcnow()
    await session.commit()

    await worker.enqueue(job_id)
    return {"queued": True, "job_id": job_id}


@router.delete("/{job_id}", status_code=204)
async def delete_job(
    job_id: str,
    session: AsyncSession = Depends(get_session),
) -> None:
    job = await session.get(Job, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.status == "processing":
        raise HTTPException(409, "Cannot delete a running job; cancel it first")
    await session.delete(job)
    await session.commit()
