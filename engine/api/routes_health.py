from __future__ import annotations

import asyncio

from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from core.hardware import get_hardware
from core.job_worker import worker
from core.settings import get_setting
from core.version import APP_VERSION

router = APIRouter(tags=["system"])


class HealthResponse(BaseModel):
    status: str
    version: str


class HardwareDetail(BaseModel):
    platform: str
    cpu: str
    cuda_available: bool
    cuda_version: Optional[str]
    gpu_name: Optional[str]
    gpu_memory_gb: Optional[float]
    recommended_device: str
    recommended_compute_type: str


class StorageResponse(BaseModel):
    models_bytes: int
    transcripts_bytes: int
    cache_bytes: int
    total_bytes: int
    models_dir: str


class StatusResponse(BaseModel):
    status: str
    version: str
    hardware: HardwareDetail
    active_model: Optional[str]
    loaded_model: Optional[str]
    jobs_queued: int
    jobs_processing: int


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", version=APP_VERSION)


def _dir_size(path) -> int:
    """Total bytes under a directory, ignoring anything unreadable."""
    total = 0
    if not path.exists():
        return 0
    for entry in path.rglob("*"):
        try:
            if entry.is_file():
                total += entry.stat().st_size
        except OSError:
            continue
    return total


@router.get("/storage", response_model=StorageResponse)
async def storage_usage() -> StorageResponse:
    """
    Disk used under %APPDATA%\\WinWhisper, broken down for the Settings
    storage bar. Walking the model directory is the only slow part and it is
    a handful of large files, so this stays fast enough to call on page load.
    """
    from core.storage import storage as app_storage

    models = await asyncio.to_thread(_dir_size, app_storage.models_dir)
    transcripts = await asyncio.to_thread(_dir_size, app_storage.transcripts_dir)
    cache = await asyncio.to_thread(_dir_size, app_storage.temp_dir)
    try:
        db = app_storage.db_path.stat().st_size
    except OSError:
        db = 0

    return StorageResponse(
        models_bytes=models,
        # The database holds the transcript text itself, so it belongs here
        # rather than in the cache figure.
        transcripts_bytes=transcripts + db,
        cache_bytes=cache,
        total_bytes=models + transcripts + db + cache,
        models_dir=str(app_storage.models_dir),
    )


@router.get("/status", response_model=StatusResponse)
async def status() -> StatusResponse:
    hw = get_hardware()
    active_model: Optional[str] = await get_setting("active_model")

    from core.transcriber import transcriber

    return StatusResponse(
        status="ok",
        version=APP_VERSION,
        hardware=HardwareDetail(
            platform=hw.platform,
            cpu=hw.cpu,
            cuda_available=hw.cuda_available,
            cuda_version=hw.cuda_version,
            gpu_name=hw.gpu_name,
            gpu_memory_gb=hw.gpu_memory_gb,
            recommended_device=hw.recommended_device,
            recommended_compute_type=hw.recommended_compute_type,
        ),
        active_model=active_model,
        loaded_model=transcriber.loaded_model,
        jobs_queued=worker.queue_size,
        jobs_processing=1 if worker.is_processing else 0,
    )
