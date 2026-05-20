from __future__ import annotations

import asyncio
import socket
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes_audio import router as audio_router
from api.routes_dictation import router as dictation_router
from api.routes_health import router as health_router
from api.routes_jobs import router as jobs_router
from api.routes_models import router as models_router
from api.routes_settings import router as settings_router
from api.routes_transcription import router as transcription_router
from api.routes_watch_folder import router as watch_folder_router
from core.database import Job, async_session_factory, init_db
from core.hardware import get_hardware
from core.job_worker import recover_stale_jobs, worker
from core.settings import get_setting
from core.storage import storage

APP_VERSION = "0.2.1"


def _find_free_port(start: int = 49200, end: int = 49300) -> int:
    for port in range(start, end):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No free port found in range {start}–{end}")


async def _restore_watch_folder() -> None:
    """Re-starts the watch folder watcher if it was active before shutdown."""
    enabled: bool = await get_setting("watch_folder_enabled", False)
    path: str | None = await get_setting("watch_folder_path")
    model_name: str = await get_setting("watch_folder_model", "base")
    diarize: bool = await get_setting("watch_folder_diarize", False)

    if not (enabled and path and Path(path).exists()):
        return

    from features.watch_folder import watch_folder_service

    loop = asyncio.get_event_loop()

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

    def _sync_cb(file_path: str) -> None:
        asyncio.run_coroutine_threadsafe(_enqueue(file_path), loop)

    watch_folder_service.start(path, _sync_cb)
    print(f"[WinWhisper] Watch folder restored: {path}", flush=True)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # ── Startup ──────────────────────────────────────────────────────────
    await init_db()
    worker.start()

    try:
        await recover_stale_jobs()
    except Exception as exc:
        print(f"[WinWhisper] Could not recover stale jobs: {exc}", flush=True)

    try:
        await _restore_watch_folder()
    except Exception as exc:
        print(f"[WinWhisper] Could not restore watch folder: {exc}", flush=True)

    hw = get_hardware()
    print(
        f"[WinWhisper] device={hw.recommended_device}  "
        f"compute={hw.recommended_compute_type}  "
        f"gpu={hw.gpu_name or 'none'}",
        flush=True,
    )

    yield

    # ── Shutdown ─────────────────────────────────────────────────────────
    await worker.stop()

    from features.watch_folder import watch_folder_service
    watch_folder_service.stop()

    from features.dictation import dictation_engine
    dictation_engine.stop()

    storage.clear_port()
    print("[WinWhisper] Engine shut down cleanly.", flush=True)


def create_app() -> FastAPI:
    app = FastAPI(
        title="WinWhisper Engine",
        version=APP_VERSION,
        docs_url="/docs",
        redoc_url=None,
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "tauri://localhost",
            "http://tauri.localhost",
            "http://localhost",
            "http://localhost:1420",
            "http://127.0.0.1",
            "http://127.0.0.1:1420",
        ],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health_router)
    app.include_router(jobs_router)
    app.include_router(transcription_router)
    app.include_router(models_router)
    app.include_router(audio_router)
    app.include_router(dictation_router)
    app.include_router(watch_folder_router)
    app.include_router(settings_router)

    return app


def main() -> None:
    port = _find_free_port()
    storage.write_port(port)

    # Tauri reads this line from sidecar stdout to discover the port
    print(f"WINWHISPER_PORT={port}", flush=True)

    uvicorn.run(
        create_app(),
        host="127.0.0.1",
        port=port,
        log_level="warning",
        access_log=False,
    )


if __name__ == "__main__":
    main()
