from __future__ import annotations

import uuid
from datetime import datetime
from typing import AsyncGenerator, List, Optional

from sqlalchemy import (
    Boolean, Column, DateTime, Float, ForeignKey,
    Integer, JSON, String, Text,
)
from sqlalchemy.ext.asyncio import (
    AsyncSession, async_sessionmaker, create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase, relationship

from core.storage import storage

DATABASE_URL = f"sqlite+aiosqlite:///{storage.db_path}"

engine = create_async_engine(DATABASE_URL, echo=False)
async_session_factory = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def _uuid() -> str:
    return str(uuid.uuid4())


# ── ORM Models ──────────────────────────────────────────────────────────────

class Job(Base):
    __tablename__ = "jobs"

    id = Column(String(36), primary_key=True, default=_uuid)
    status = Column(String(20), nullable=False, default="queued")
    # queued | processing | done | failed | cancelled
    job_type = Column(String(20), nullable=False)
    # file | youtube | microphone | loopback | dictation

    source_path = Column(String, nullable=True)
    source_url = Column(String, nullable=True)
    source_name = Column(String, nullable=True)

    model_name = Column(String(50), nullable=False, default="base")
    language = Column(String(10), nullable=True)   # None = auto-detect
    options = Column(JSON, nullable=False, default=dict)
    # keys: diarize, translate, word_timestamps, vad_filter

    progress = Column(Float, nullable=False, default=0.0)   # 0.0–1.0
    error_message = Column(Text, nullable=True)

    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)

    transcript_id = Column(String(36), ForeignKey("transcripts.id"), nullable=True)
    transcript = relationship("Transcript", back_populates="job", uselist=False)


class Transcript(Base):
    __tablename__ = "transcripts"

    id = Column(String(36), primary_key=True, default=_uuid)
    job_id = Column(String(36), ForeignKey("jobs.id"), nullable=False)
    title = Column(String(255), nullable=False)
    language = Column(String(10), nullable=True)
    language_probability = Column(Float, nullable=True)
    duration = Column(Float, nullable=True)         # seconds
    word_count = Column(Integer, nullable=False, default=0)
    source_type = Column(String(20), nullable=False)
    # file | youtube | microphone | loopback

    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    job = relationship("Job", back_populates="transcript")
    segments = relationship(
        "Segment",
        back_populates="transcript",
        cascade="all, delete-orphan",
        order_by="Segment.segment_index",
    )
    speakers = relationship(
        "Speaker",
        back_populates="transcript",
        cascade="all, delete-orphan",
    )


class Segment(Base):
    __tablename__ = "segments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    transcript_id = Column(String(36), ForeignKey("transcripts.id"), nullable=False)
    segment_index = Column(Integer, nullable=False)

    start = Column(Float, nullable=False)   # seconds
    end = Column(Float, nullable=False)     # seconds
    text = Column(Text, nullable=False)

    speaker_label = Column(String(50), nullable=True)   # SPEAKER_00
    confidence = Column(Float, nullable=True)            # avg word confidence
    cps = Column(Float, nullable=True)                   # characters per second

    # Word-level timestamps: [{"word": str, "start": float, "end": float, "probability": float}]
    words = Column(JSON, nullable=True)

    transcript = relationship("Transcript", back_populates="segments")


class Speaker(Base):
    __tablename__ = "speakers"

    id = Column(Integer, primary_key=True, autoincrement=True)
    transcript_id = Column(String(36), ForeignKey("transcripts.id"), nullable=False)

    label = Column(String(50), nullable=False)    # SPEAKER_00, SPEAKER_01
    name = Column(String(100), nullable=True)      # user-assigned friendly name
    color = Column(String(7), nullable=True)       # hex color #RRGGBB

    transcript = relationship("Transcript", back_populates="speakers")


class DownloadedModel(Base):
    __tablename__ = "downloaded_models"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(50), unique=True, nullable=False)
    # tiny | base | small | medium | large-v2 | large-v3

    size_bytes = Column(Integer, nullable=True)
    downloaded_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    is_active = Column(Boolean, nullable=False, default=False)
    compute_type = Column(String(20), nullable=False, default="int8")
    # float32 | float16 | int8 | int8_float16

    hub_repo_id = Column(String(100), nullable=True)


class Setting(Base):
    __tablename__ = "settings"

    key = Column(String(100), primary_key=True)
    value = Column(JSON, nullable=True)


# ── Init ────────────────────────────────────────────────────────────────────

async def init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await _seed_defaults()


async def _seed_defaults() -> None:
    defaults: dict = {
        "active_model": "base",
        "active_microphone": None,
        "dictation_hotkey": "ctrl+shift+space",
        "watch_folder_enabled": False,
        "watch_folder_path": None,
        "diarization_enabled": False,
        "hf_token": None,
        "language": None,
        "translate_to_english": False,
        "vad_filter": True,
        "word_timestamps": True,
        "theme": "system",
        "cps_warning_threshold": 21.0,
    }
    async with async_session_factory() as session:
        for key, value in defaults.items():
            existing = await session.get(Setting, key)
            if existing is None:
                session.add(Setting(key=key, value=value))
        await session.commit()


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_factory() as session:
        yield session
