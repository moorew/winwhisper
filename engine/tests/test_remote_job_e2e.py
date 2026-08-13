"""
Handing a job to another machine and getting the transcript back.

The promise of remote transcription is narrow and easy to get wrong: the GPU box
does the work, and the machine that asked keeps the result. This runs a *real*
second engine in a subprocess, pushes a job through it, and then checks both
halves of that promise — the transcript is here, and nothing was left there.

Costs a ~75 MB model download and a minute of CPU, so it is gated like the other
end-to-end test:

    WINWHISPER_E2E=1 pytest tests/test_remote_job_e2e.py -v
"""
from __future__ import annotations

import asyncio
import math
import os
import struct
import subprocess
import sys
import time
import wave
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("WINWHISPER_E2E") != "1",
    reason="set WINWHISPER_E2E=1 to run the two-engine remote transcription path",
)

httpx = pytest.importorskip("httpx")
pytest.importorskip("faster_whisper", reason="the remote engine needs a real transcriber")

ENGINE_ROOT = Path(__file__).resolve().parents[1]
MODEL = "tiny"


def _speechlike_wav(path: Path, seconds: float = 4.0) -> None:
    """
    A tone sweep, not silence. Whisper returns nothing for pure silence, which
    would let a broken pipeline pass by producing the same empty result.
    """
    rate = 16000
    with wave.open(str(path), "w") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        frames = bytearray()
        for i in range(int(rate * seconds)):
            t = i / rate
            freq = 180 + 120 * math.sin(2 * math.pi * 0.8 * t)
            envelope = 0.4 * (1 + math.sin(2 * math.pi * 2.5 * t)) / 2
            frames += struct.pack("<h", int(12000 * envelope * math.sin(2 * math.pi * freq * t)))
        handle.writeframes(bytes(frames))


class RemoteEngine:
    """A second WinWhisper engine, as another of your machines would run it."""

    def __init__(self, home: Path):
        self.home = home
        self.process: subprocess.Popen | None = None
        self.port: int | None = None

    def start(self) -> None:
        env = {**os.environ, "HOME": str(self.home), "PYTHONUNBUFFERED": "1"}
        env.pop("APPDATA", None)
        self.home.mkdir(parents=True, exist_ok=True)
        self.process = subprocess.Popen(
            [sys.executable, "main.py"],
            cwd=str(ENGINE_ROOT),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        deadline = time.time() + 120
        while time.time() < deadline:
            line = self.process.stdout.readline()
            if not line:
                break
            if line.startswith("WINWHISPER_PORT="):
                self.port = int(line.split("=", 1)[1].strip())
                break
        assert self.port, "the remote engine never announced a port"
        # Keep draining, or it blocks on a full pipe once it starts logging.
        import threading
        threading.Thread(target=self._drain, daemon=True).start()
        self._wait_healthy()

    def _drain(self) -> None:
        for _ in self.process.stdout:  # type: ignore[union-attr]
            pass

    def _wait_healthy(self) -> None:
        deadline = time.time() + 120
        while time.time() < deadline:
            try:
                if httpx.get(f"{self.url}/health", timeout=2).status_code == 200:
                    return
            except Exception:
                time.sleep(0.5)
        raise AssertionError("the remote engine never became healthy")

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def ensure_model(self) -> None:
        httpx.post(f"{self.url}/models/{MODEL}/download", timeout=600)
        deadline = time.time() + 600
        while time.time() < deadline:
            models = httpx.get(f"{self.url}/models", timeout=30).json()
            if any(m["name"] == MODEL and m["is_downloaded"] for m in models):
                return
            time.sleep(2)
        raise AssertionError(f"the remote engine never downloaded {MODEL}")

    def transcripts(self) -> list:
        return httpx.get(f"{self.url}/transcripts", timeout=30).json()

    def jobs(self) -> list:
        return httpx.get(f"{self.url}/jobs", timeout=30).json()

    def stop(self) -> None:
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.process.kill()


@pytest.fixture(scope="module")
def remote_engine(tmp_path_factory):
    engine = RemoteEngine(tmp_path_factory.mktemp("gpu-box-home"))
    engine.start()
    engine.ensure_model()
    yield engine
    engine.stop()


@pytest.fixture()
def as_device(monkeypatch, remote_engine):
    """Presents the subprocess engine as a discovered device called 'gpu-box'."""
    from core import remote as remote_mod

    device = remote_mod.RemoteDevice(
        hostname="gpu-box",
        ip="127.0.0.1",
        os="linux",
        port=remote_engine.port,
        online=True,
        reachable=True,
        gpu_name="Test GPU",
        cuda_available=True,
        models=[MODEL],
    )

    async def find(hostname):
        return device if hostname.lower() == "gpu-box" else None

    monkeypatch.setattr(remote_mod, "find_device", find)
    return device


async def _run_remote_job(tmp_path, job_type="file", source=None):
    """Creates a local job bound to 'gpu-box' and runs it through the worker."""
    import uuid

    from core.database import Job, async_session_factory, init_db
    from core.job_worker import worker

    await init_db()
    job_id = str(uuid.uuid4())
    async with async_session_factory() as session:
        session.add(Job(
            id=job_id,
            status="queued",
            job_type=job_type,
            source_path=str(source) if job_type == "file" else None,
            source_url=source if job_type == "youtube" else None,
            source_name=Path(source).name if job_type == "file" else source,
            model_name=MODEL,
            remote_device="gpu-box",
            options={"word_timestamps": True, "vad_filter": True},
        ))
        await session.commit()

    await worker._process(job_id)
    return job_id


def test_the_transcript_lands_here_and_not_there(tmp_path, remote_engine, as_device):
    """
    The whole arrangement in one assertion pair: our database has it, theirs
    does not.
    """
    from core.database import Job, Transcript, async_session_factory

    audio = tmp_path / "clip.wav"
    _speechlike_wav(audio)

    job_id = asyncio.run(_run_remote_job(tmp_path, "file", audio))

    async def check():
        async with async_session_factory() as session:
            job = await session.get(Job, job_id)
            assert job.status == "done", job.error_message
            assert job.remote_device == "gpu-box"
            assert job.transcript_id
            transcript = await session.get(Transcript, job.transcript_id)
            assert transcript is not None
            assert transcript.job_id == job_id
            return transcript

    transcript = asyncio.run(check())
    assert transcript.duration and transcript.duration > 0

    # ...and the other machine kept nothing.
    assert remote_engine.transcripts() == []
    assert [j for j in remote_engine.jobs() if j["status"] != "cancelled"] == []


def test_a_missing_model_on_the_remote_is_reported_not_silently_downgraded(
    tmp_path, monkeypatch, remote_engine
):
    """
    Falling back to the local CPU would turn a one-minute job into a twenty-
    minute one without saying so. Better to fail with the reason.
    """
    from core import remote as remote_mod

    device = remote_mod.RemoteDevice(
        hostname="gpu-box", ip="127.0.0.1", os="linux", port=remote_engine.port,
        online=True, reachable=True, models=["large-v3"],   # not the one we ask for
    )

    async def find(hostname):
        return device

    monkeypatch.setattr(remote_mod, "find_device", find)

    audio = tmp_path / "clip2.wav"
    _speechlike_wav(audio, seconds=1.0)

    # The worker loop is what turns a raised error into a failed row; driving
    # _process directly means the exception itself is the observable.
    with pytest.raises(RuntimeError) as raised:
        asyncio.run(_run_remote_job(tmp_path, "file", audio))

    assert MODEL in str(raised.value)
    assert "gpu-box" in str(raised.value)
    assert "download it on that machine" in str(raised.value)


def test_an_unreachable_device_fails_with_a_useful_message(tmp_path, monkeypatch):
    from core import remote as remote_mod

    async def find(hostname):
        return remote_mod.RemoteDevice(
            hostname="gpu-box", ip="100.10.0.2", os="windows", online=True, reachable=False
        )

    monkeypatch.setattr(remote_mod, "find_device", find)

    audio = tmp_path / "clip3.wav"
    _speechlike_wav(audio, seconds=1.0)

    with pytest.raises(RuntimeError) as raised:
        asyncio.run(_run_remote_job(tmp_path, "file", audio))

    assert "awake" in str(raised.value)
    assert "gpu-box" in str(raised.value)
