from __future__ import annotations

import os
import sys
import time
from pathlib import Path

APP_NAME = "WinWhisper"

# How long a working file may sit in the cache before it is assumed abandoned.
#
# Downloads and uploads are deleted when their job finishes or is cancelled, but
# not when it fails — deliberately, because the retry button reads that same
# copy back. Nothing then ever removes the leftovers of a job that failed and
# was never retried, so the cache grows by the size of every failed download,
# permanently. A day is long enough that retrying later still works and short
# enough that the folder does not become a graveyard.
TEMP_TTL_SECONDS = 24 * 60 * 60


def _get_base_dir() -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    # Linux / macOS dev fallback
    return Path.home() / ".local" / "share"


class AppStorage:
    def __init__(self) -> None:
        self.root = _get_base_dir() / APP_NAME
        self.models_dir = self.root / "models"
        self.transcripts_dir = self.root / "transcripts"
        self.temp_dir = self.root / "temp"
        self.exports_dir = self.root / "exports"
        self.watch_dir = self.root / "watch"
        self.db_path = self.root / "winwhisper.db"
        self.port_file = self.root / "engine.port"
        self._ensure_dirs()

    def _ensure_dirs(self) -> None:
        for d in (
            self.root,
            self.models_dir,
            self.transcripts_dir,
            self.temp_dir,
            self.exports_dir,
            self.watch_dir,
        ):
            d.mkdir(parents=True, exist_ok=True)

    def model_path(self, model_name: str) -> Path:
        return self.models_dir / model_name

    def temp_audio_path(self, filename: str) -> Path:
        return self.temp_dir / filename

    def export_path(self, filename: str) -> Path:
        return self.exports_dir / filename

    def write_port(self, port: int) -> None:
        self.port_file.write_text(str(port))

    def clear_port(self) -> None:
        if self.port_file.exists():
            self.port_file.unlink(missing_ok=True)

    def purge_stale_temp(self, ttl_seconds: int = TEMP_TTL_SECONDS) -> tuple[int, int]:
        """
        Deletes cache files left behind by jobs that failed and were never
        retried. Returns (files removed, bytes reclaimed).

        Only files directly inside temp_dir, and only ones older than the TTL:
        a job running right now writes into this same folder, and reclaiming a
        few megabytes is not worth any chance of pulling a file out from under
        it.
        """
        removed = 0
        reclaimed = 0
        cutoff = time.time() - ttl_seconds
        try:
            entries = list(self.temp_dir.iterdir())
        except OSError:
            return (0, 0)

        for entry in entries:
            try:
                if not entry.is_file():
                    continue
                stat = entry.stat()
                if stat.st_mtime >= cutoff:
                    continue
                entry.unlink()
            except OSError:
                continue  # in use, or gone already — either way, leave it
            removed += 1
            reclaimed += stat.st_size
        return (removed, reclaimed)


storage = AppStorage()
