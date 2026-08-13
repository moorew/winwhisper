"""
Discovering which of your machines will do the transcribing.

A device is chosen by hostname and resolved against what discovery actually
found. That indirection is the security boundary: the alternative is letting the
caller hand over a URL, which turns "transcribe on my other machine" into "fetch
whatever address I name".
"""
from __future__ import annotations

import httpx
import pytest

from core import remote, tailnet


def _peer(host, ip, online=True, os_name="windows"):
    return tailnet.Peer(
        hostname=host, ip=ip, os=os_name, dns_name=f"{host}.example.ts.net", online=online
    )


def _responder(sharing: dict):
    """
    Stands in for the network. `sharing` maps ip -> (gpu_name, [models]);
    anything absent refuses the connection, as an unshared machine does.
    """
    def handle(request: httpx.Request) -> httpx.Response:
        host = request.url.host
        if host not in sharing:
            raise httpx.ConnectError("connection refused", request=request)
        gpu, models = sharing[host]
        if request.url.path == "/status":
            return httpx.Response(200, json={
                "status": "ok",
                "version": "0.4.8",
                "hardware": {"gpu_name": gpu, "cuda_available": bool(gpu)},
                "jobs_queued": 0,
                "jobs_processing": 1,
            })
        if request.url.path == "/models":
            return httpx.Response(200, json=[
                {"name": m, "is_downloaded": True} for m in models
            ] + [{"name": "medium", "is_downloaded": False}])
        return httpx.Response(404)
    return handle


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    remote.reset_cache()
    yield
    remote.reset_cache()


def _arrange(monkeypatch, peers, sharing):
    monkeypatch.setattr(tailnet, "own_devices", lambda: peers)
    transport = httpx.MockTransport(_responder(sharing))
    original = httpx.AsyncClient

    def patched(*args, **kwargs):
        kwargs["transport"] = transport
        return original(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", patched)


# ── Discovery ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_sharing_device_reports_its_gpu_and_models(monkeypatch):
    _arrange(
        monkeypatch,
        [_peer("gpu-box", "100.10.0.2")],
        {"100.10.0.2": ("NVIDIA GeForce RTX 5080", ["base", "large-v3"])},
    )

    (device,) = await remote.discover()

    assert device.reachable is True
    assert device.cuda_available is True
    assert device.label == "gpu-box (RTX 5080)"
    # Only what it has on disk — offering the rest would put a silent
    # multi-gigabyte download in front of the job.
    assert device.models == ["base", "large-v3"]
    assert device.jobs_running == 1


@pytest.mark.asyncio
async def test_a_device_that_is_up_but_not_sharing_is_listed_unreachable(monkeypatch):
    """The UI needs to tell "asleep" from "not offering its GPU"."""
    _arrange(monkeypatch, [_peer("work-laptop", "100.10.0.3")], {})

    (device,) = await remote.discover()

    assert device.online is True
    assert device.reachable is False
    assert device.models == []


@pytest.mark.asyncio
async def test_offline_devices_are_never_probed(monkeypatch):
    probed = []

    def handle(request):
        probed.append(request.url.host)
        raise httpx.ConnectError("refused", request=request)

    monkeypatch.setattr(tailnet, "own_devices", lambda: [_peer("spare", "100.10.0.6", online=False)])
    transport = httpx.MockTransport(handle)
    original = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda *a, **k: original(*a, **{**k, "transport": transport})
    )

    (device,) = await remote.discover()

    assert device.reachable is False
    assert probed == []


@pytest.mark.asyncio
async def test_discovery_is_cached(monkeypatch):
    calls = []

    def peers():
        calls.append(1)
        return [_peer("gpu-box", "100.10.0.2")]

    monkeypatch.setattr(tailnet, "own_devices", peers)
    transport = httpx.MockTransport(_responder({"100.10.0.2": ("RTX 5080", ["base"])}))
    original = httpx.AsyncClient
    monkeypatch.setattr(
        httpx, "AsyncClient", lambda *a, **k: original(*a, **{**k, "transport": transport})
    )

    await remote.discover()
    await remote.discover()
    assert len(calls) == 1

    await remote.discover(force=True)
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_no_devices_when_tailscale_is_unavailable(monkeypatch):
    def boom():
        raise tailnet.TailscaleUnavailable("not installed")

    monkeypatch.setattr(tailnet, "own_devices", boom)
    assert await remote.discover() == []


# ── Device resolution, which is the SSRF boundary ────────────────────────────

@pytest.mark.asyncio
async def test_a_known_device_resolves(monkeypatch):
    _arrange(monkeypatch, [_peer("gpu-box", "100.10.0.2")],
             {"100.10.0.2": ("RTX 5080", ["large-v3"])})

    device = await remote.find_device("GPU-BOX")   # case-insensitive

    assert device is not None
    assert device.base_url == f"http://100.10.0.2:{remote.SHARE_PORT}"


@pytest.mark.asyncio
async def test_an_unknown_hostname_does_not_resolve(monkeypatch):
    """
    The point of resolving by name: a caller cannot name a machine that
    discovery has not seen, so it cannot steer this engine at an address of its
    choosing.
    """
    _arrange(monkeypatch, [_peer("gpu-box", "100.10.0.2")],
             {"100.10.0.2": ("RTX 5080", ["large-v3"])})

    assert await remote.find_device("attacker.example.com") is None
    assert await remote.find_device("169.254.169.254") is None
    assert await remote.find_device("") is None


# ── Labels ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("reported,shown", [
    ("NVIDIA GeForce RTX 5080", "RTX 5080"),
    ("NVIDIA GeForce RTX 4090 Laptop GPU", "RTX 4090 Laptop GPU"),
    ("AMD Radeon RX 7900 XTX", "RX 7900 XTX"),
    ("Tesla T4", "Tesla T4"),
])
def test_gpu_names_are_shortened_to_what_people_call_them(reported, shown):
    """
    Vendors report the full marketing name. In a dropdown that is mostly
    padding it pushes the identifying part off the end — the first attempt
    rendered "base · FRACTAL (NVIDIA GeF…".
    """
    assert remote.short_gpu_name(reported) == shown


def test_a_device_without_a_gpu_is_just_its_name():
    device = remote.RemoteDevice(hostname="nas", ip="100.10.0.4", os="linux")
    assert device.label == "nas"
