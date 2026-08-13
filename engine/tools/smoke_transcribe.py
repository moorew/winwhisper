"""
End-to-end smoke test against an already-running engine, over HTTP.

Run against the *bundled* PyInstaller engine in CI. Checking that the exe boots
and prints a port is not enough: v0.3.0 booted perfectly and then failed every
single transcription, because the spec never collected faster-whisper's data
files and faster_whisper/assets/silero_vad_v6.onnx was missing from the bundle.
Only actually pushing audio through the pipeline catches a missing data file,
DLL, or lazily-imported module.

Deliberately stdlib-only — it runs against a frozen bundle, not this source
tree, so it cannot rely on the engine's dependencies being importable here.

    python smoke_transcribe.py --port 49200 [--model tiny] [--timeout 900]
"""
from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import tempfile
import time
import urllib.error
import urllib.request
import wave
from pathlib import Path


def _request(url: str, payload: dict | None = None, method: str | None = None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    if data:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = resp.read().decode()
        return resp.status, (json.loads(body) if body else None)


def _write_tone_wav(path: Path, seconds: float = 3.0, rate: int = 16_000) -> None:
    """A 440 Hz tone. Whisper will transcribe little or nothing from it — the
    point is that the pipeline runs to completion, not what it says."""
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = bytearray()
        for i in range(int(rate * seconds)):
            frames += struct.pack("<h", int(12_000 * math.sin(2 * math.pi * 440 * (i / rate))))
        w.writeframes(bytes(frames))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--model", default="tiny")
    ap.add_argument("--timeout", type=int, default=900)
    args = ap.parse_args()

    base = f"http://127.0.0.1:{args.port}"
    deadline = time.time() + args.timeout

    # The engine prints WINWHISPER_PORT= before uvicorn actually binds — the
    # Tauri shell polls for the same reason — so wait for /health to answer.
    health = None
    while time.time() < deadline:
        try:
            status, health = _request(f"{base}/health")
            if status == 200:
                break
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(1)
    if not health:
        print("[smoke] FAIL: engine never served /health")
        return 1
    print(f"[smoke] /health -> {health}", flush=True)

    # Remote transcription lives behind this route, and reaching it proves the
    # frozen bundle carries httpx and the Tailscale wrapper. A build runner has
    # no Tailscale, so the honest answer is "unavailable" — the point is that it
    # answers at all rather than 500-ing on a missing import.
    status, devices = _request(f"{base}/devices")
    if status != 200:
        print(f"[smoke] FAIL: /devices returned {status}")
        return 1
    print(
        f"[smoke] /devices -> tailscale_available={devices.get('tailscale_available')} "
        f"sharing={devices.get('sharing')} devices={len(devices.get('devices') or [])}",
        flush=True,
    )

    # ── Download the smallest model ───────────────────────────────────────
    print(f"[smoke] downloading model '{args.model}' ...", flush=True)
    _request(f"{base}/models/{args.model}/download", payload={})
    while time.time() < deadline:
        _, models = _request(f"{base}/models")
        entry = next((m for m in models if m["name"] == args.model), None)
        if entry and entry["is_downloaded"]:
            print(f"[smoke] model downloaded ({entry['size_bytes_local']} bytes)", flush=True)
            break
        time.sleep(3)
    else:
        print("[smoke] FAIL: model download timed out")
        return 1

    # ── Transcribe, with VAD explicitly on ────────────────────────────────
    # vad_filter=True is the app's default and the exact path that was broken:
    # it is what loads the Silero ONNX model out of the bundle.
    audio = Path(tempfile.gettempdir()) / "winwhisper-smoke.wav"
    _write_tone_wav(audio)
    print(f"[smoke] transcribing {audio} with vad_filter=true ...", flush=True)

    status, created = _request(f"{base}/transcribe/file", payload={
        "file_path": str(audio),
        "model_name": args.model,
        "vad_filter": True,
        "word_timestamps": True,
    })
    if status != 202:
        print(f"[smoke] FAIL: could not queue job ({status})")
        return 1

    job_id = created["job_id"]
    while time.time() < deadline:
        _, job = _request(f"{base}/jobs/{job_id}")
        if job["status"] in ("done", "failed", "cancelled"):
            break
        time.sleep(2)
    else:
        print("[smoke] FAIL: transcription timed out")
        return 1

    print(f"[smoke] job finished: {job['status']}", flush=True)
    if job["status"] != "done":
        print(f"[smoke] FAIL: {job['error_message']}")
        return 1

    _, detail = _request(f"{base}/transcripts/{job['transcript_id']}")
    print(f"[smoke] transcript OK — {len(detail['segments'])} segment(s), "
          f"source_available={detail['source_available']}", flush=True)
    print("[smoke] PASS: the bundled engine transcribes end to end.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
