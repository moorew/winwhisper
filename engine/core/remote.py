"""
Finding, and talking to, WinWhisper engines on your other machines.

Every install runs an engine. One of them may have a GPU. This module is how a
laptop finds that machine and hands it work — and, critically, how the finished
transcript comes back so it lives on the machine that asked for it. The remote
engine keeps nothing.

Two halves:

* discovery — which of your devices are running a shareable engine right now;
* a client — submit, follow, collect, clean up.

Device selection is by hostname, resolved here against what discovery actually
found. Callers never pass a URL: accepting one would let anything that can reach
the local API make this engine fetch an address of its choosing.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import httpx

from core import tailnet

# The port a shared engine listens on. Fixed, so a peer needs one probe rather
# than a sweep — the local engine's own port is picked from 49200-49300 at
# startup and is not predictable from another machine.
SHARE_PORT = 49277

# Discovery is polled by the UI while the model picker is open.
DISCOVERY_TTL_SECONDS = 30.0

# A machine that is up answers in milliseconds on a tailnet; one that is not
# should not hold up the list.
PROBE_TIMEOUT_SECONDS = 1.5

# Generous: the remote may be loading a model, and this is a local network.
REQUEST_TIMEOUT_SECONDS = 60.0


@dataclass
class RemoteDevice:
    hostname: str
    ip: str
    os: str
    port: int = SHARE_PORT
    online: bool = False
    reachable: bool = False
    version: Optional[str] = None
    gpu_name: Optional[str] = None
    cuda_available: bool = False
    # Only models the device has on disk. Offering one it lacks would put a
    # silent multi-gigabyte download in front of the job.
    models: List[str] = field(default_factory=list)
    jobs_running: int = 0

    @property
    def base_url(self) -> str:
        return f"http://{self.ip}:{self.port}"

    @property
    def label(self) -> str:
        """"FRACTAL (RTX 5080)" — what the model picker shows."""
        if self.gpu_name:
            return f"{self.hostname} ({short_gpu_name(self.gpu_name)})"
        return self.hostname


# Vendors report the full marketing name — "NVIDIA GeForce RTX 5080". Inside a
# dropdown that is mostly padding, and it pushes the part that identifies the
# card off the end. People call it a 5080.
_GPU_NOISE = ("NVIDIA ", "GeForce ", "AMD ", "Radeon ", "Intel(R) ", "Intel ")


def short_gpu_name(name: str) -> str:
    trimmed = name.strip()
    changed = True
    while changed:
        changed = False
        for prefix in _GPU_NOISE:
            if trimmed.lower().startswith(prefix.lower()):
                trimmed = trimmed[len(prefix):].lstrip()
                changed = True
    return trimmed or name.strip()


async def _probe(client: httpx.AsyncClient, peer: tailnet.Peer) -> Optional[RemoteDevice]:
    device = RemoteDevice(
        hostname=peer.hostname, ip=peer.ip, os=peer.os, online=peer.online
    )
    if not peer.online:
        return device

    base = device.base_url
    try:
        status = (await client.get(f"{base}/status", timeout=PROBE_TIMEOUT_SECONDS)).json()
    except Exception:
        # Not running WinWhisper, not sharing, or asleep. All the same to us.
        return device

    hardware = status.get("hardware") or {}
    device.reachable = True
    device.version = status.get("version")
    device.gpu_name = hardware.get("gpu_name")
    device.cuda_available = bool(hardware.get("cuda_available"))
    device.jobs_running = (status.get("jobs_processing") or 0) + (status.get("jobs_queued") or 0)

    try:
        models = (await client.get(f"{base}/models", timeout=PROBE_TIMEOUT_SECONDS)).json()
        device.models = [m["name"] for m in models if m.get("is_downloaded")]
    except Exception:
        device.models = []

    return device


_cache: List[RemoteDevice] = []
_cached_at: float = 0.0
_lock = asyncio.Lock()


async def discover(force: bool = False) -> List[RemoteDevice]:
    """Your devices, each annotated with whether it is sharing an engine."""
    global _cache, _cached_at

    async with _lock:
        if not force and _cache and time.monotonic() - _cached_at < DISCOVERY_TTL_SECONDS:
            return _cache

        try:
            peers = await asyncio.to_thread(tailnet.own_devices)
        except tailnet.TailscaleUnavailable:
            _cache, _cached_at = [], time.monotonic()
            return _cache

        async with httpx.AsyncClient() as client:
            probed = await asyncio.gather(
                *(_probe(client, p) for p in peers), return_exceptions=True
            )

        _cache = [d for d in probed if isinstance(d, RemoteDevice)]
        _cached_at = time.monotonic()
        return _cache


async def find_device(hostname: str) -> Optional[RemoteDevice]:
    """
    Resolves a hostname to a device we have actually seen.

    The guard, not a convenience: the alternative is taking a URL from the
    caller, which would turn "transcribe on my other machine" into "fetch
    whatever address I name".
    """
    wanted = (hostname or "").strip().lower()
    if not wanted:
        return None
    for device in await discover():
        if device.hostname.lower() == wanted:
            return device
    for device in await discover(force=True):
        if device.hostname.lower() == wanted:
            return device
    return None


def reset_cache() -> None:
    global _cache, _cached_at
    _cache, _cached_at = [], 0.0


# ── Client: handing a job to another machine and getting the result back ─────

class RemoteEngineError(RuntimeError):
    """The remote engine refused, failed, or went away mid-job."""


def _client(base_url: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=base_url, timeout=REQUEST_TIMEOUT_SECONDS)


async def submit_youtube(base_url: str, url: str, model: str, options: Dict[str, Any]) -> str:
    async with _client(base_url) as client:
        response = await client.post("/transcribe/youtube", json={
            "url": url,
            "model_name": model,
            "language": options.get("language"),
            "diarize": bool(options.get("diarize")),
            "translate": bool(options.get("translate")),
            "word_timestamps": options.get("word_timestamps", True),
            "vad_filter": options.get("vad_filter", True),
        })
    if response.status_code >= 400:
        raise RemoteEngineError(f"{response.status_code}: {response.text[:200]}")
    return response.json()["job_id"]


async def submit_file(
    base_url: str, path: str, filename: str, model: str, options: Dict[str, Any]
) -> str:
    """
    Streams a local file to the remote engine.

    The path only exists on this machine, so a remote job cannot reference it —
    the bytes have to travel. Sent from disk rather than read into memory
    because these are media files.
    """
    data = {
        "model_name": model,
        "diarize": str(bool(options.get("diarize"))).lower(),
        "translate": str(bool(options.get("translate"))).lower(),
        "word_timestamps": str(options.get("word_timestamps", True)).lower(),
        "vad_filter": str(options.get("vad_filter", True)).lower(),
    }
    if options.get("language"):
        data["language"] = options["language"]

    with open(path, "rb") as handle:
        async with _client(base_url) as client:
            response = await client.post(
                "/transcribe/upload",
                files={"file": (filename, handle, "application/octet-stream")},
                data=data,
                timeout=None,  # a long upload is not a stalled one
            )
    if response.status_code >= 400:
        raise RemoteEngineError(f"{response.status_code}: {response.text[:200]}")
    return response.json()["job_id"]


async def poll_job(base_url: str, job_id: str) -> Dict[str, Any]:
    async with _client(base_url) as client:
        response = await client.get(f"/jobs/{job_id}")
    if response.status_code >= 400:
        raise RemoteEngineError(f"{response.status_code}: {response.text[:200]}")
    return response.json()


async def fetch_transcript(base_url: str, transcript_id: str) -> Dict[str, Any]:
    async with _client(base_url) as client:
        response = await client.get(f"/transcripts/{transcript_id}")
    if response.status_code >= 400:
        raise RemoteEngineError(f"{response.status_code}: {response.text[:200]}")
    return response.json()


async def cancel_job(base_url: str, job_id: str) -> None:
    try:
        async with _client(base_url) as client:
            await client.post(f"/jobs/{job_id}/cancel")
    except Exception:
        pass  # best effort; the local job is ending either way


async def cleanup(base_url: str, job_id: str, transcript_id: Optional[str]) -> None:
    """
    Removes our work from the other machine once the transcript is safely here.

    The promise is that the device you asked from is the device that keeps the
    result. Leaving a copy behind on the GPU box would quietly break that.
    """
    try:
        async with _client(base_url) as client:
            if transcript_id:
                await client.delete(f"/transcripts/{transcript_id}")
            await client.delete(f"/jobs/{job_id}")
    except Exception as exc:
        print(
            f"[WinWhisper] could not tidy up on the remote engine ({exc}). "
            "The transcript is stored locally regardless.",
            flush=True,
        )
