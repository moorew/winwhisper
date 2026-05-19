from __future__ import annotations

from typing import Any, Optional

from sqlalchemy import select

from core.database import Setting, async_session_factory


async def get_setting(key: str, default: Any = None) -> Any:
    async with async_session_factory() as session:
        record = await session.get(Setting, key)
        return record.value if record is not None else default


async def set_setting(key: str, value: Any) -> None:
    async with async_session_factory() as session:
        record = await session.get(Setting, key)
        if record:
            record.value = value
        else:
            session.add(Setting(key=key, value=value))
        await session.commit()


async def get_all_settings() -> dict[str, Any]:
    async with async_session_factory() as session:
        result = await session.execute(select(Setting))
        return {s.key: s.value for s in result.scalars().all()}
