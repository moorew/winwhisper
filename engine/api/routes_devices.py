"""
Your other machines, and whether any of them will do the transcribing.

The list is built from Tailscale — see core/tailnet.py for why the filtering
there is load-bearing — and then each candidate is asked whether it is running
a shareable engine.
"""

from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter
from pydantic import BaseModel

from core import remote, tailnet
from core.settings import get_setting

router = APIRouter(prefix="/devices", tags=["devices"])


class DeviceResponse(BaseModel):
    hostname: str
    label: str                 # "FRACTAL (RTX 5080)"
    os: str
    online: bool
    # Online says Tailscale can see it; reachable says WinWhisper answered on
    # it. A machine that is up but not sharing is online and not reachable, and
    # the difference is what the UI needs to explain itself.
    reachable: bool
    version: Optional[str] = None
    gpu_name: Optional[str] = None
    cuda_available: bool = False
    models: List[str] = []
    jobs_running: int = 0


class DevicesResponse(BaseModel):
    # False when Tailscale is not installed, not running, or not logged in —
    # in which case there is nothing to configure and the UI should say so
    # rather than showing an empty list.
    tailscale_available: bool
    # Whether *this* machine is offering its engine to the others.
    sharing: bool
    share_port: int
    this_device: Optional[str] = None
    devices: List[DeviceResponse] = []


@router.get("", response_model=DevicesResponse)
async def list_devices(refresh: bool = False) -> DevicesResponse:
    available = await _tailscale_available()
    sharing = bool(await get_setting("share_engine", False))

    if not available:
        return DevicesResponse(
            tailscale_available=False, sharing=sharing, share_port=remote.SHARE_PORT
        )

    devices = await remote.discover(force=refresh)
    return DevicesResponse(
        tailscale_available=True,
        sharing=sharing,
        share_port=remote.SHARE_PORT,
        this_device=await _self_hostname(),
        devices=[
            DeviceResponse(
                hostname=d.hostname,
                label=d.label,
                os=d.os,
                online=d.online,
                reachable=d.reachable,
                version=d.version,
                gpu_name=d.gpu_name,
                cuda_available=d.cuda_available,
                models=d.models,
                jobs_running=d.jobs_running,
            )
            for d in devices
        ],
    )


async def _tailscale_available() -> bool:
    import asyncio

    return await asyncio.to_thread(tailnet.is_available)


async def _self_hostname() -> Optional[str]:
    import asyncio

    try:
        return await asyncio.to_thread(tailnet.self_hostname)
    except tailnet.TailscaleUnavailable:
        return None
