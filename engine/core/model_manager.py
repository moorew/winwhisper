from __future__ import annotations

import asyncio
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional

from sqlalchemy import select

from core.database import DownloadedModel, async_session_factory
from core.hardware import get_hardware
from core.storage import storage


# ── Download state ───────────────────────────────────────────────────────────

@dataclass
class DownloadState:
    model_name: str
    total_bytes: int
    downloaded_bytes: int = 0
    status: str = "downloading"   # downloading | done | failed | cancelled
    error: Optional[str] = None

    @property
    def progress(self) -> float:
        if self.total_bytes <= 0:
            return 0.0
        return min(self.downloaded_bytes / self.total_bytes, 1.0)

    def as_event(self) -> dict:
        return {
            "model": self.model_name,
            "status": self.status,
            "progress": round(self.progress, 4),
            "downloaded_mb": round(self.downloaded_bytes / (1024 * 1024), 1),
            "total_mb": round(self.total_bytes / (1024 * 1024), 1),
            "error": self.error,
        }


# Module-level state — lives for the lifetime of the server process
_active: Dict[str, DownloadState] = {}
_tasks: Dict[str, asyncio.Task] = {}
_HF_API_CLS = None
_HF_SNAPSHOT_DOWNLOAD = None
_HF_IMPORT_ERROR: Optional[BaseException] = None


def _get_huggingface_hub():
    global _HF_API_CLS, _HF_SNAPSHOT_DOWNLOAD, _HF_IMPORT_ERROR
    if _HF_API_CLS is not None and _HF_SNAPSHOT_DOWNLOAD is not None:
        return _HF_API_CLS, _HF_SNAPSHOT_DOWNLOAD
    if _HF_IMPORT_ERROR is not None:
        raise RuntimeError(
            "huggingface-hub is not available. Run: pip install huggingface-hub"
        ) from _HF_IMPORT_ERROR

    try:
        from huggingface_hub import HfApi, snapshot_download
    except Exception as exc:
        _HF_IMPORT_ERROR = exc
        raise RuntimeError(
            "huggingface-hub is not available. Run: pip install huggingface-hub"
        ) from exc

    _HF_API_CLS = HfApi
    _HF_SNAPSHOT_DOWNLOAD = snapshot_download
    return _HF_API_CLS, _HF_SNAPSHOT_DOWNLOAD


# ── Public helpers ────────────────────────────────────────────────────────────

def get_state(model_name: str) -> Optional[DownloadState]:
    return _active.get(model_name)


def is_downloading(model_name: str) -> bool:
    s = _active.get(model_name)
    return s is not None and s.status == "downloading"


def launch_download(
    model_name: str,
    repo_id: str,
    hf_token: Optional[str],
) -> None:
    """Schedules a download task on the running event loop."""
    state = DownloadState(model_name=model_name, total_bytes=0)
    _active[model_name] = state

    task = asyncio.create_task(
        _run_download(model_name, repo_id, hf_token, state),
        name=f"download-{model_name}",
    )
    _tasks[model_name] = task


def cancel_download(model_name: str) -> bool:
    task = _tasks.get(model_name)
    if task and not task.done():
        task.cancel()
        return True
    return False


async def remove_model(model_name: str) -> None:
    model_path = storage.model_path(model_name)
    if model_path.exists():
        await asyncio.to_thread(shutil.rmtree, str(model_path), True)
    async with async_session_factory() as session:
        result = await session.execute(
            select(DownloadedModel).where(DownloadedModel.name == model_name)
        )
        record = result.scalar_one_or_none()
        if record:
            await session.delete(record)
            await session.commit()
    _active.pop(model_name, None)


async def list_downloaded() -> List[DownloadedModel]:
    async with async_session_factory() as session:
        result = await session.execute(select(DownloadedModel))
        # Detach objects so they stay usable outside the session
        records = list(result.scalars().all())
        for r in records:
            await session.refresh(r)
        return records


# ── Internal implementation ───────────────────────────────────────────────────

def _get_repo_size_sync(repo_id: str, hf_token: Optional[str]) -> int:
    """Returns total byte count of all files in the HuggingFace repo."""
    try:
        hf_api_cls, _ = _get_huggingface_hub()
        api = hf_api_cls()
        info = api.repo_info(repo_id, files_metadata=True, token=hf_token)
        return sum(f.size or 0 for f in (info.siblings or []))
    except Exception:
        return 0


def _snapshot_sync(repo_id: str, local_dir: str, hf_token: Optional[str]) -> None:
    _, hf_snapshot_download = _get_huggingface_hub()
    hf_snapshot_download(
        repo_id=repo_id,
        local_dir=local_dir,
        token=hf_token,
        local_files_only=False,
        ignore_patterns=[
            "*.msgpack",
            "flax_model*",
            "tf_model*",
            "rust_model.ot",
            "*.h5",
            "*.ot",
        ],
    )


async def _monitor_dir(model_path: Path, state: DownloadState) -> None:
    """Polls the download directory to estimate bytes written."""
    while state.status == "downloading":
        try:
            state.downloaded_bytes = sum(
                f.stat().st_size for f in model_path.rglob("*") if f.is_file()
            )
        except Exception:
            pass
        await asyncio.sleep(0.75)


async def _persist(model_name: str, model_path: Path, repo_id: str) -> None:
    hw = get_hardware()
    size_bytes = sum(f.stat().st_size for f in model_path.rglob("*") if f.is_file())
    async with async_session_factory() as session:
        result = await session.execute(
            select(DownloadedModel).where(DownloadedModel.name == model_name)
        )
        record = result.scalar_one_or_none()
        if record:
            record.size_bytes = size_bytes
            record.downloaded_at = datetime.utcnow()
            record.compute_type = hw.recommended_compute_type
            record.hub_repo_id = repo_id
        else:
            session.add(
                DownloadedModel(
                    name=model_name,
                    size_bytes=size_bytes,
                    compute_type=hw.recommended_compute_type,
                    hub_repo_id=repo_id,
                )
            )
        await session.commit()


async def _run_download(
    model_name: str,
    repo_id: str,
    hf_token: Optional[str],
    state: DownloadState,
) -> None:
    model_path = storage.model_path(model_name)
    model_path.mkdir(parents=True, exist_ok=True)

    # Best-effort size estimate; 0 means indeterminate progress bar on frontend
    state.total_bytes = await asyncio.to_thread(_get_repo_size_sync, repo_id, hf_token)

    monitor = asyncio.create_task(_monitor_dir(model_path, state))

    try:
        await asyncio.to_thread(_snapshot_sync, repo_id, str(model_path), hf_token)
        state.status = "done"
        state.downloaded_bytes = state.total_bytes or sum(
            f.stat().st_size for f in model_path.rglob("*") if f.is_file()
        )
        await _persist(model_name, model_path, repo_id)
    except asyncio.CancelledError:
        state.status = "cancelled"
    except Exception as exc:
        state.status = "failed"
        state.error = str(exc)
    finally:
        monitor.cancel()
        _tasks.pop(model_name, None)
