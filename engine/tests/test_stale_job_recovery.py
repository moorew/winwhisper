"""
What happens to jobs the app was part-way through when it last closed.

They used to be re-queued and started immediately. That meant opening the app
could begin transcribing on its own — a user reported watching a YouTube job run
before they had pasted a link, and they were right: it was the previous
session's job resuming. Worse, a job that wedged came back on every launch and
wedged again.

Leaving the row saying "processing" is not an option either; nothing would ever
move it. So it is marked failed, with a reason, and the user decides.
"""
from __future__ import annotations

import uuid

import pytest

from core.database import Job, async_session_factory
from core.job_worker import recover_stale_jobs, worker


async def _add_job(status: str) -> str:
    job_id = str(uuid.uuid4())
    async with async_session_factory() as session:
        session.add(
            Job(
                id=job_id,
                status=status,
                job_type="youtube",
                source_url="https://www.youtube.com/watch?v=x",
                model_name="base",
                progress=0.4,
            )
        )
        await session.commit()
    return job_id


async def _status_of(job_id: str):
    async with async_session_factory() as session:
        job = await session.get(Job, job_id)
        return job.status, job.error_message, job.progress


@pytest.mark.asyncio
@pytest.mark.parametrize("interrupted_as", ["processing", "queued"])
async def test_interrupted_jobs_are_failed_not_restarted(client, interrupted_as):
    job_id = await _add_job(interrupted_as)
    before = worker.queue_size

    await recover_stale_jobs()

    status, error, progress = await _status_of(job_id)
    assert status == "failed"
    assert progress == 0.0
    # The message has to say what to do, not just that something went wrong.
    assert "Interrupted" in error and "again" in error
    # Nothing was scheduled: the whole point is that the app does no work on
    # launch that the user did not ask for in this session.
    assert worker.queue_size == before


@pytest.mark.asyncio
async def test_finished_jobs_are_left_alone(client):
    done = await _add_job("done")
    failed = await _add_job("failed")

    await recover_stale_jobs()

    assert (await _status_of(done))[0] == "done"
    assert (await _status_of(failed))[0] == "failed"


@pytest.mark.asyncio
async def test_recovery_is_safe_when_there_is_nothing_to_recover(client):
    before = worker.queue_size
    await recover_stale_jobs()
    assert worker.queue_size == before
