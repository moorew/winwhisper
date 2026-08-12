from __future__ import annotations

import asyncio
import uuid
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

from sqlalchemy import select

from core.database import Job, Segment, Speaker, Transcript, async_session_factory
from core.diarizer import SPEAKER_COLORS, diarizer, merge_speakers
from core.settings import get_setting
from core.storage import storage
from core.transcriber import TranscriptionCancelled, transcriber

# In-memory progress overlay: updated every segment during transcription,
# cleared when the job finishes. Lets the API return live progress without
# a DB write on every segment.
_live_progress: Dict[str, float] = {}

# Jobs the user has asked to abandon. Setting the DB status alone is not enough:
# the worker would carry on transcribing and then overwrite the row with "done".
_cancel_requested: Set[str] = set()

# Which phase a running job is in, so the UI can say "Downloading" vs "Loading
# model" vs "Transcribing". Without it a large model on a slow machine is
# indistinguishable from a hung job — the bar just sits still.
_live_stage: Dict[str, str] = {}


def get_live_progress(job_id: str) -> Optional[float]:
    return _live_progress.get(job_id)


def get_live_stage(job_id: str) -> Optional[str]:
    return _live_stage.get(job_id)


def _set_stage(job_id: str, stage: str) -> None:
    _live_stage[job_id] = stage
    print(f"[WinWhisper] job {job_id[:8]}: {stage}", flush=True)


def request_cancel(job_id: str) -> None:
    """Asks the worker to abandon a job at the next segment boundary."""
    _cancel_requested.add(job_id)


def is_cancel_requested(job_id: str) -> bool:
    return job_id in _cancel_requested


# ── DB helpers ────────────────────────────────────────────────────────────────

async def _fetch_job(job_id: str) -> Optional[Job]:
    async with async_session_factory() as session:
        return await session.get(Job, job_id)


async def _update_job(
    job_id: str,
    status: str,
    progress: float = 0.0,
    error: Optional[str] = None,
    transcript_id: Optional[str] = None,
) -> None:
    async with async_session_factory() as session:
        job = await session.get(Job, job_id)
        if not job:
            return
        job.status = status
        job.progress = progress
        job.updated_at = datetime.utcnow()
        if error is not None:
            job.error_message = error
        if transcript_id is not None:
            job.transcript_id = transcript_id
        await session.commit()


async def _update_job_source(
    job_id: str,
    source_path: str,
    source_name: Optional[str],
) -> None:
    """After a YouTube download, stores the local audio path and video title."""
    async with async_session_factory() as session:
        job = await session.get(Job, job_id)
        if job:
            job.source_path = source_path
            if source_name:
                job.source_name = source_name
            job.updated_at = datetime.utcnow()
            await session.commit()


async def _save_results(
    job: Job,
    segments: list,
    info: object,
    speaker_labels: List[Optional[str]],
) -> str:
    """Writes Transcript, Segment, and Speaker rows in one transaction."""
    transcript_id = str(uuid.uuid4())

    # Human-readable title — YouTube title wins over bare URL
    if job.source_name and not job.source_name.startswith("http"):
        title = job.source_name
    elif job.source_name:
        title = Path(job.source_name).stem.replace("_", " ").replace("-", " ")
    elif job.source_url:
        title = (job.source_url[:80] + "…") if len(job.source_url) > 80 else job.source_url
    else:
        title = f"Recording {datetime.utcnow().strftime('%Y-%m-%d %H:%M')}"

    word_count = sum(len(seg.text.split()) for seg in segments)

    # Unique speakers in first-seen order for deterministic colour assignment
    seen_speakers: dict[str, int] = {}
    for label in speaker_labels:
        if label and label not in seen_speakers:
            seen_speakers[label] = len(seen_speakers)

    async with async_session_factory() as session:
        session.add(
            Transcript(
                id=transcript_id,
                job_id=job.id,
                title=title,
                language=getattr(info, "language", None),
                language_probability=getattr(info, "language_probability", None),
                duration=getattr(info, "duration", None),
                word_count=word_count,
                source_type=job.job_type,
            )
        )
        await session.flush()

        for i, (seg, s_label) in enumerate(zip(segments, speaker_labels)):
            text = seg.text.strip()
            duration = seg.end - seg.start
            cps = round(len(text) / duration, 2) if duration > 0 else 0.0

            words_data = None
            avg_confidence = None
            raw_words = getattr(seg, "words", None)
            if raw_words:
                words_data = [
                    {
                        "word": w.word,
                        "start": w.start,
                        "end": w.end,
                        "probability": w.probability,
                    }
                    for w in raw_words
                ]
                probs = [w.probability for w in raw_words if w.probability is not None]
                avg_confidence = round(sum(probs) / len(probs), 4) if probs else None

            session.add(
                Segment(
                    transcript_id=transcript_id,
                    segment_index=i,
                    start=seg.start,
                    end=seg.end,
                    text=text,
                    speaker_label=s_label,
                    confidence=avg_confidence,
                    cps=cps,
                    words=words_data,
                )
            )

        for label, idx in seen_speakers.items():
            session.add(
                Speaker(
                    transcript_id=transcript_id,
                    label=label,
                    color=SPEAKER_COLORS[idx % len(SPEAKER_COLORS)],
                )
            )

        await session.commit()

    return transcript_id


async def _cleanup_temp(file_path: str) -> None:
    """Deletes a file only if it lives inside our own temp directory."""
    try:
        p = Path(file_path).resolve()
        temp = storage.temp_dir.resolve()
        if p.parent == temp or temp in p.parents:
            await asyncio.to_thread(p.unlink, True)
    except Exception:
        pass  # non-fatal


# ── YouTube download helper ───────────────────────────────────────────────────

async def _download_youtube(
    job_id: str,
    url: str,
) -> Tuple[str, str]:
    """
    Downloads YouTube audio to the temp dir.
    Progress maps to 0.0–0.25 of the overall job progress.
    Returns (local_audio_path, video_title).
    """
    from features.youtube import extractor

    def _yt_progress(p: float) -> None:
        _live_progress[job_id] = p * 0.25

    file_path, metadata = await asyncio.to_thread(
        extractor.extract_audio,
        url,
        str(storage.temp_dir),
        _yt_progress,
    )
    return file_path, metadata.get("title", url)


# ── Worker ────────────────────────────────────────────────────────────────────

class JobWorker:
    def __init__(self) -> None:
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._task: Optional[asyncio.Task] = None
        self._current_job_id: Optional[str] = None

    @property
    def queue_size(self) -> int:
        return self._queue.qsize()

    @property
    def is_processing(self) -> bool:
        return self._current_job_id is not None

    @property
    def current_job_id(self) -> Optional[str]:
        return self._current_job_id

    async def enqueue(self, job_id: str) -> None:
        await self._queue.put(job_id)

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop(), name="job-worker")

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _loop(self) -> None:
        while True:
            try:
                job_id = await asyncio.wait_for(self._queue.get(), timeout=2.0)
            except asyncio.TimeoutError:
                continue

            self._current_job_id = job_id
            try:
                await self._process(job_id)
            except asyncio.CancelledError:
                await _update_job(job_id, "failed", error="Server shutting down")
                raise
            except TranscriptionCancelled:
                await _update_job(job_id, "cancelled", progress=0.0)
            except Exception as exc:
                # A job the user abandoned should report as cancelled, not
                # surface whatever error the interrupted run happened to raise.
                if is_cancel_requested(job_id):
                    await _update_job(job_id, "cancelled", progress=0.0)
                else:
                    await _update_job(job_id, "failed", error=str(exc))
            finally:
                self._current_job_id = None
                _live_progress.pop(job_id, None)
                _live_stage.pop(job_id, None)
                _cancel_requested.discard(job_id)
                self._queue.task_done()

    async def _process(self, job_id: str) -> None:  # noqa: C901
        job = await _fetch_job(job_id)
        if job is None or job.status == "cancelled" or is_cancel_requested(job_id):
            return

        await _update_job(job_id, "processing", progress=0.0)
        _live_progress[job_id] = 0.0

        temp_audio: Optional[str] = None   # files we created that need cleanup

        # ── YouTube download (progress 0 → 0.25) ──────────────────────────
        if job.job_type == "youtube":
            if not job.source_url:
                raise ValueError("YouTube job has no source_url")

            _set_stage(job_id, "Downloading from YouTube")
            audio_path, video_title = await _download_youtube(job_id, job.source_url)
            temp_audio = audio_path

            # Persist the local path and real title so the transcript gets them
            await _update_job_source(job_id, audio_path, video_title)
            job = await _fetch_job(job_id)  # reload with updated source_name
        else:
            audio_path = job.source_path
            # Uploaded files land in temp_dir — clean those up too
            if audio_path and storage.temp_dir.resolve() in Path(audio_path).resolve().parents:
                temp_audio = audio_path

        if not audio_path or not Path(audio_path).exists():
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        # ── Load model ─────────────────────────────────────────────────────
        # Loading large-v3 off disk the first time is minutes, not seconds, and
        # produces no progress of its own — say so rather than looking frozen.
        _set_stage(job_id, f"Loading model ({job.model_name})")
        await asyncio.to_thread(transcriber.ensure_loaded, job.model_name)

        opts = job.options or {}

        # Offset transcription progress to leave room for the download phase
        is_yt = job.job_type == "youtube"
        prog_base = 0.25 if is_yt else 0.0
        prog_scale = 0.75 if is_yt else 1.0

        def _on_progress(p: float) -> None:
            # Transcription fills from prog_base up to 0.95 of total
            _live_progress[job_id] = prog_base + p * prog_scale * 0.95

        # ── Transcription ──────────────────────────────────────────────────
        _set_stage(job_id, f"Transcribing with {job.model_name}")
        try:
            segments, info = await asyncio.to_thread(
                transcriber.transcribe_with_progress,
                audio_path,
                on_progress=_on_progress,
                language=opts.get("language") or None,
                task="translate" if opts.get("translate") else "transcribe",
                vad_filter=opts.get("vad_filter", True),
                word_timestamps=opts.get("word_timestamps", True),
                should_continue=lambda: not is_cancel_requested(job_id),
            )
        except TranscriptionCancelled:
            # Don't leave the user's temp upload behind just because they
            # changed their mind part-way through.
            if temp_audio:
                await _cleanup_temp(temp_audio)
            raise

        # ── Diarization (0.95 → 0.99, optional) ──────────────────────────
        speaker_labels: List[Optional[str]] = [None] * len(segments)

        if opts.get("diarize"):
            hf_token: Optional[str] = await get_setting("hf_token")
            if not hf_token:
                print(
                    "[WinWhisper] Diarization requested but hf_token is not set. "
                    "Set it in Settings and re-transcribe.",
                    flush=True,
                )
            else:
                try:
                    _set_stage(job_id, "Identifying speakers")
                    _live_progress[job_id] = 0.95
                    await _update_job(job_id, "processing", progress=0.95)

                    turns = await asyncio.to_thread(
                        diarizer.diarize,
                        audio_path,
                        hf_token,
                        num_speakers=opts.get("num_speakers"),
                        min_speakers=opts.get("min_speakers"),
                        max_speakers=opts.get("max_speakers"),
                    )
                    speaker_labels = merge_speakers(segments, turns)
                except Exception as exc:
                    print(
                        f"[WinWhisper] Diarization failed (continuing without speakers): {exc}",
                        flush=True,
                    )

        # ── Persist ───────────────────────────────────────────────────────
        transcript_id = await _save_results(job, segments, info, speaker_labels)
        await _update_job(job_id, "done", progress=1.0, transcript_id=transcript_id)

        # ── Cleanup temp audio ─────────────────────────────────────────────
        if temp_audio:
            await _cleanup_temp(temp_audio)


# Module-level singleton
worker = JobWorker()


async def recover_stale_jobs() -> None:
    """Re-queues jobs left in queued/processing state by a previous server run."""
    async with async_session_factory() as session:
        result = await session.execute(
            select(Job).where(Job.status.in_(["queued", "processing"]))
        )
        stale = result.scalars().all()
        for job in stale:
            job.status = "queued"
            job.progress = 0.0
            job.updated_at = datetime.utcnow()
        await session.commit()

    for job in stale:
        await worker.enqueue(job.id)

    if stale:
        print(f"[WinWhisper] Re-queued {len(stale)} stale job(s).", flush=True)
