from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from core.settings import get_setting, set_setting
from core.transcriber import transcriber
from features.dictation import dictation_engine

router = APIRouter(prefix="/dictation", tags=["dictation"])


class DictationStartRequest(BaseModel):
    hotkey: Optional[str] = None   # None → use saved setting


class DictationStatusResponse(BaseModel):
    active: bool
    hotkey: Optional[str]
    model_loaded: bool
    loaded_model: Optional[str]


@router.get("/status", response_model=DictationStatusResponse)
async def dictation_status() -> DictationStatusResponse:
    hotkey: str = await get_setting("dictation_hotkey", "ctrl+shift+space")
    return DictationStatusResponse(
        active=dictation_engine.is_active,
        hotkey=hotkey,
        model_loaded=transcriber.is_loaded,
        loaded_model=transcriber.loaded_model,
    )


@router.post("/start")
async def start_dictation(req: DictationStartRequest) -> dict:
    """
    Registers the global hotkey. While held, the mic records; on release the
    audio is transcribed and injected as keystrokes into the focused window.

    Requires a Whisper model to already be loaded (i.e. at least one
    transcription job has run since startup).
    """
    hotkey: str = req.hotkey or await get_setting("dictation_hotkey", "ctrl+shift+space")

    if not transcriber.is_loaded:
        raise HTTPException(
            400,
            "No Whisper model is loaded yet. "
            "Transcribe a file first, or wait for the job queue to process one.",
        )

    if dictation_engine.is_active:
        return {"status": "already_active", "hotkey": dictation_engine.hotkey}

    try:
        dictation_engine.start(hotkey)
    except RuntimeError as exc:
        raise HTTPException(503, str(exc))

    await set_setting("dictation_hotkey", hotkey)
    return {"status": "started", "hotkey": hotkey}


@router.post("/stop")
async def stop_dictation() -> dict:
    if not dictation_engine.is_active:
        return {"status": "not_active"}
    dictation_engine.stop()
    return {"status": "stopped"}
