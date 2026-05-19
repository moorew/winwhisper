from __future__ import annotations

import os
import sys
from pathlib import Path

APP_NAME = "WinWhisper"


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


storage = AppStorage()
