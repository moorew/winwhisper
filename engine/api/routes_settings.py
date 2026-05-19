from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from core.settings import get_all_settings, get_setting, set_setting

router = APIRouter(prefix="/settings", tags=["settings"])


class SettingUpdate(BaseModel):
    value: Any


@router.get("")
async def list_settings() -> dict[str, Any]:
    return await get_all_settings()


@router.get("/{key}")
async def get_one_setting(key: str) -> dict[str, Any]:
    value = await get_setting(key)
    return {"key": key, "value": value}


@router.put("/{key}")
async def update_setting(key: str, body: SettingUpdate) -> dict[str, Any]:
    await set_setting(key, body.value)
    return {"key": key, "value": body.value}


@router.patch("")
async def update_many_settings(body: dict[str, Any]) -> dict[str, list]:
    for key, value in body.items():
        await set_setting(key, value)
    return {"updated": list(body.keys())}
