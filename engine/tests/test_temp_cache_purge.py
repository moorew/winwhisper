"""
Clearing working files left behind by jobs that failed.

Downloads and uploads are removed when their job finishes or is cancelled, but
deliberately not when it fails — the retry button reads that same copy back, so
deleting it would turn "try again" into "find the file again". Nothing then ever
removed the leftovers of a job that failed and was never retried, so the cache
grew by the size of every failed download and never shrank. A user reported
their YouTube jobs wedging repeatedly; each of those runs left its audio behind.
"""
from __future__ import annotations

import time

import pytest

from core.storage import AppStorage, TEMP_TTL_SECONDS


@pytest.fixture()
def store(tmp_path, monkeypatch) -> AppStorage:
    monkeypatch.setenv("APPDATA", str(tmp_path))
    monkeypatch.setattr("core.storage._get_base_dir", lambda: tmp_path)
    return AppStorage()


def _write(store: AppStorage, name: str, size: int, age_seconds: float):
    path = store.temp_dir / name
    path.write_bytes(b"x" * size)
    when = time.time() - age_seconds
    import os
    os.utime(path, (when, when))
    return path


def test_abandoned_files_are_removed(store):
    old = _write(store, "yt_abc_video.m4a", 1024, TEMP_TTL_SECONDS + 60)

    removed, reclaimed = store.purge_stale_temp()

    assert (removed, reclaimed) == (1, 1024)
    assert not old.exists()


def test_recent_files_are_kept(store):
    """
    A job failed ten minutes ago and its card still offers "try again" — pulling
    the audio out from under that is exactly what this must not do.
    """
    fresh = _write(store, "yt_def_video.m4a", 2048, 600)

    removed, reclaimed = store.purge_stale_temp()

    assert (removed, reclaimed) == (0, 0)
    assert fresh.exists()


def test_a_file_being_written_right_now_is_kept(store):
    running = _write(store, "yt_ghi_video.m4a.part", 512, 0)
    store.purge_stale_temp()
    assert running.exists()


def test_mixed_ages_remove_only_the_old(store):
    old_a = _write(store, "a.m4a", 100, TEMP_TTL_SECONDS + 1)
    old_b = _write(store, "b.wav", 200, TEMP_TTL_SECONDS * 5)
    fresh = _write(store, "c.m4a", 400, 5)

    removed, reclaimed = store.purge_stale_temp()

    assert removed == 2
    assert reclaimed == 300
    assert not old_a.exists() and not old_b.exists()
    assert fresh.exists()


def test_directories_are_left_alone(store):
    nested = store.temp_dir / "somedir"
    nested.mkdir()
    import os
    when = time.time() - TEMP_TTL_SECONDS * 2
    os.utime(nested, (when, when))

    removed, _ = store.purge_stale_temp()

    assert removed == 0
    assert nested.is_dir()


def test_purging_an_empty_cache_is_fine(store):
    assert store.purge_stale_temp() == (0, 0)


def test_the_other_app_directories_are_untouched(store):
    """The purge is scoped to the cache — models are gigabytes and not ours."""
    import os
    model = store.models_dir / "large-v3"
    model.mkdir(parents=True, exist_ok=True)
    marker = model / "model.bin"
    marker.write_bytes(b"weights")
    when = time.time() - TEMP_TTL_SECONDS * 30
    os.utime(marker, (when, when))

    store.purge_stale_temp()

    assert marker.exists()
