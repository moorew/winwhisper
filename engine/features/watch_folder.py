from __future__ import annotations

import time
import threading
from pathlib import Path
from typing import Callable, Optional

SUPPORTED_EXTENSIONS = {
    ".mp3", ".mp4", ".m4a", ".wav", ".flac",
    ".ogg", ".webm", ".mkv", ".aac", ".opus", ".wma",
}

try:
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler, FileCreatedEvent, FileMovedEvent
    _WATCHDOG_AVAILABLE = True
except ImportError:
    _WATCHDOG_AVAILABLE = False
    Observer = None              # type: ignore
    FileSystemEventHandler = object  # type: ignore


class _AudioHandler(FileSystemEventHandler):  # type: ignore[misc]
    def __init__(self, on_file: Callable[[str], None]) -> None:
        super().__init__()
        self._on_file = on_file

    def _handle(self, path: str) -> None:
        p = Path(path)
        if p.suffix.lower() not in SUPPORTED_EXTENSIONS:
            return
        # Give the OS a moment to finish writing the file before queuing it
        time.sleep(1.5)
        if p.exists() and p.stat().st_size > 0:
            self._on_file(str(p))

    def on_created(self, event) -> None:
        if not event.is_directory:
            self._handle(event.src_path)

    def on_moved(self, event) -> None:
        # Handles files moved/copied into the watch folder
        if not event.is_directory:
            self._handle(event.dest_path)


class WatchFolderService:
    """
    Monitors a directory and calls on_file for every new audio/video file.
    The on_file callback is called from a watchdog thread — the caller is
    responsible for bridging to asyncio via asyncio.run_coroutine_threadsafe.
    """

    def __init__(self) -> None:
        self._observer: Optional[object] = None
        self._folder_path: Optional[str] = None

    @property
    def is_running(self) -> bool:
        return self._observer is not None and self._observer.is_alive()  # type: ignore[union-attr]

    @property
    def folder_path(self) -> Optional[str]:
        return self._folder_path

    def start(self, folder_path: str, on_file: Callable[[str], None]) -> None:
        if not _WATCHDOG_AVAILABLE:
            raise RuntimeError(
                "watchdog is not installed. Run: pip install watchdog"
            )
        self.stop()

        handler = _AudioHandler(on_file)
        observer = Observer()
        observer.schedule(handler, folder_path, recursive=False)
        observer.start()

        self._observer = observer
        self._folder_path = folder_path

    def stop(self) -> None:
        if self._observer:
            self._observer.stop()   # type: ignore[union-attr]
            self._observer.join()   # type: ignore[union-attr]
            self._observer = None
            self._folder_path = None


# Module-level singleton
watch_folder_service = WatchFolderService()
