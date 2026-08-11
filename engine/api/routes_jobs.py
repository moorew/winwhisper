from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import Job, get_session
from core.job_worker import get_live_progress, request_cancel

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

    model_config = {"from_attributes": True}


def _with_live_progress(job: Job) -> JobResponse:
    r = JobResponse.model_validate(job)
    live = get_live_progress(job.id)
    if live is not None:
        r.progress = live
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
