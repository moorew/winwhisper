from __future__ import annotations

from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from core.hardware import get_hardware
from core.job_worker import worker
from core.settings import get_setting

router = APIRouter(tags=["system"])

APP_VERSION = "0.1.7"


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
