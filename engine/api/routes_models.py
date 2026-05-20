from __future__ import annotations

import asyncio
import json
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from core import model_manager
from core.settings import get_setting, set_setting

router = APIRouter(prefix="/models", tags=["models"])

MODEL_CATALOG: dict[str, dict] = {
    "tiny": {
        "repo_id": "guillaumekln/faster-whisper-tiny",
        "size_mb": 75,
        "speed": "~32x realtime",
        "description": "Fastest, lowest accuracy",
    },
    "tiny.en": {
        "repo_id": "guillaumekln/faster-whisper-tiny.en",
        "size_mb": 75,
        "speed": "~32x realtime",
        "description": "English-only tiny",
    },
    "base": {
        "repo_id": "guillaumekln/faster-whisper-base",
        "size_mb": 145,
        "speed": "~16x realtime",
        "description": "Good balance of speed and accuracy",
    },
    "base.en": {
        "repo_id": "guillaumekln/faster-whisper-base.en",
        "size_mb": 145,
        "speed": "~16x realtime",
        "description": "English-only base",
    },
    "small": {
        "repo_id": "guillaumekln/faster-whisper-small",
        "size_mb": 461,
        "speed": "~6x realtime",
        "description": "Better accuracy, moderate speed",
    },
    "small.en": {
        "repo_id": "guillaumekln/faster-whisper-small.en",
        "size_mb": 461,
        "speed": "~6x realtime",
        "description": "English-only small",
    },
    "medium": {
        "repo_id": "guillaumekln/faster-whisper-medium",
        "size_mb": 1530,
        "speed": "~2x realtime",
        "description": "High accuracy, slower",
    },
    "medium.en": {
        "repo_id": "guillaumekln/faster-whisper-medium.en",
        "size_mb": 1530,
        "speed": "~2x realtime",
        "description": "English-only medium",
    },
    "large-v2": {
        "repo_id": "guillaumekln/faster-whisper-large-v2",
        "size_mb": 3090,
        "speed": "~1x realtime",
        "description": "Near-human accuracy, requires good GPU",
    },
    "large-v3": {
        "repo_id": "Systran/faster-whisper-large-v3",
        "size_mb": 3090,
        "speed": "~1x realtime",
        "description": "Latest and most accurate Whisper model",
    },
}


class ModelInfo(BaseModel):
    name: str
    repo_id: str
    size_mb: int
    speed: str
    description: str
    is_downloaded: bool
    is_active: bool
    size_bytes_local: Optional[int] = None
    compute_type: Optional[str] = None
    is_downloading: bool = False
    download_progress: Optional[float] = None


@router.get("", response_model=List[ModelInfo])
async def list_models() -> List[ModelInfo]:
    try:
        downloaded = {m.name: m for m in await model_manager.list_downloaded()}
    except Exception as exc:
        print(f"[WinWhisper] Could not read downloaded model metadata: {exc}", flush=True)
        downloaded = {}

    try:
        active: str = await get_setting("active_model", "base")
    except Exception as exc:
        print(f"[WinWhisper] Could not read active model setting: {exc}", flush=True)
        active = "base"

    result = []
    for name, info in MODEL_CATALOG.items():
        state = model_manager.get_state(name)
        downloading = state is not None and state.status == "downloading"
        result.append(
            ModelInfo(
                name=name,
                is_downloaded=name in downloaded,
                is_active=name == active,
                size_bytes_local=downloaded[name].size_bytes if name in downloaded else None,
                compute_type=downloaded[name].compute_type if name in downloaded else None,
                is_downloading=downloading,
                download_progress=state.progress if downloading else None,
                **info,
            )
        )
    return result


@router.post("/{model_name}/download", status_code=202)
async def start_download(model_name: str) -> dict:
    if model_name not in MODEL_CATALOG:
        raise HTTPException(404, f"Unknown model: {model_name}")

    if model_manager.is_downloading(model_name):
        raise HTTPException(409, f"Model '{model_name}' is already downloading")

    downloaded = {m.name for m in await model_manager.list_downloaded()}
    if model_name in downloaded:
        return {"status": "already_downloaded", "model": model_name}

    hf_token: Optional[str] = await get_setting("hf_token")
    repo_id = MODEL_CATALOG[model_name]["repo_id"]

    model_manager.launch_download(model_name, repo_id, hf_token)
    return {"status": "queued", "model": model_name}


@router.get("/{model_name}/download/progress")
async def download_progress_stream(
    model_name: str, request: Request
) -> EventSourceResponse:
    if model_name not in MODEL_CATALOG:
        raise HTTPException(404, f"Unknown model: {model_name}")

    async def event_gen():
        while True:
            if await request.is_disconnected():
                break

            state = model_manager.get_state(model_name)

            if state is None:
                # No active download — check DB for completed status
                downloaded = {m.name for m in await model_manager.list_downloaded()}
                yield {
                    "data": json.dumps({
                        "model": model_name,
                        "status": "done" if model_name in downloaded else "not_started",
                        "progress": 1.0 if model_name in downloaded else 0.0,
                    })
                }
                return

            yield {"data": json.dumps(state.as_event())}

            if state.status in ("done", "failed", "cancelled"):
                return

            await asyncio.sleep(0.5)

    return EventSourceResponse(event_gen())


@router.post("/{model_name}/download/cancel")
async def cancel_download(model_name: str) -> dict:
    if model_name not in MODEL_CATALOG:
        raise HTTPException(404, f"Unknown model: {model_name}")
    cancelled = model_manager.cancel_download(model_name)
    return {"cancelled": cancelled, "model": model_name}


@router.post("/{model_name}/activate")
async def activate_model(model_name: str) -> dict:
    if model_name not in MODEL_CATALOG:
        raise HTTPException(404, f"Unknown model: {model_name}")
    downloaded = {m.name for m in await model_manager.list_downloaded()}
    if model_name not in downloaded:
        raise HTTPException(400, f"Model '{model_name}' is not downloaded yet")
    await set_setting("active_model", model_name)
    return {"active_model": model_name}


@router.delete("/{model_name}", status_code=204)
async def delete_model(model_name: str) -> None:
    if model_name not in MODEL_CATALOG:
        raise HTTPException(404, f"Unknown model: {model_name}")
    if model_manager.is_downloading(model_name):
        raise HTTPException(409, "Cancel the download before deleting")
    await model_manager.remove_model(model_name)
