from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from core.database import Job, async_session_factory
from core.job_worker import worker
from core.settings import get_setting, set_setting
from features.watch_folder import SUPPORTED_EXTENSIONS, watch_folder_service

router = APIRouter(prefix="/watch-folder", tags=["watch-folder"])


class WatchFolderStartRequest(BaseModel):
    folder_path: str
    model_name: str = "base"
    diarize: bool = False


class WatchFolderStatusResponse(BaseModel):
    running: bool
    folder_path: str | None
    supported_extensions: List[str]


@router.get("/status", response_model=WatchFolderStatusResponse)
async def watch_folder_status() -> WatchFolderStatusResponse:
    return WatchFolderStatusResponse(
        running=watch_folder_service.is_running,
        folder_path=watch_folder_service.folder_path,
        supported_extensions=sorted(SUPPORTED_EXTENSIONS),
    )


@router.post("/start")
async def start_watch_folder(req: WatchFolderStartRequest) -> dict:
    """
    Starts monitoring a folder. Any audio/video file dropped in is automatically
    queued for transcription with the specified model.
    """
    folder = Path(req.folder_path)
    if not folder.exists():
        raise HTTPException(404, f"Folder not found: {req.folder_path}")
    if not folder.is_dir():
        raise HTTPException(400, f"Path is not a directory: {req.folder_path}")

    loop = asyncio.get_event_loop()
    model_name = req.model_name
    diarize = req.diarize

    async def _enqueue(file_path: str) -> None:
        async with async_session_factory() as session:
            job = Job(
                id=str(uuid.uuid4()),
                status="queued",
                job_type="file",
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
        print(f"[WatchFolder] Queued: {file_path}", flush=True)

    def _sync_callback(file_path: str) -> None:
        asyncio.run_coroutine_threadsafe(_enqueue(file_path), loop)

    try:
        watch_folder_service.start(req.folder_path, _sync_callback)
    except RuntimeError as exc:
        raise HTTPException(503, str(exc))

    await set_setting("watch_folder_enabled", True)
    await set_setting("watch_folder_path", req.folder_path)
    await set_setting("watch_folder_model", model_name)
    await set_setting("watch_folder_diarize", diarize)

    return {"status": "started", "path": req.folder_path, "model": model_name}


@router.post("/stop")
async def stop_watch_folder() -> dict:
    if not watch_folder_service.is_running:
        return {"status": "not_running"}
    watch_folder_service.stop()
    await set_setting("watch_folder_enabled", False)
    return {"status": "stopped"}
