from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

try:
    import yt_dlp
    _YT_DLP_AVAILABLE = True
except ImportError:
    _YT_DLP_AVAILABLE = False


class _YtdlLogger:
    """Forwards yt-dlp's messages into the engine log rather than the console."""

    def debug(self, msg: str) -> None:
        # yt-dlp routes info-level lines here prefixed with "[debug] ".
        if msg and not msg.startswith("[debug] "):
            print(f"[WinWhisper] yt-dlp: {msg}", flush=True)

    def info(self, msg: str) -> None:
        print(f"[WinWhisper] yt-dlp: {msg}", flush=True)

    def warning(self, msg: str) -> None:
        print(f"[WinWhisper] yt-dlp warning: {msg}", flush=True)

    def error(self, msg: str) -> None:
        print(f"[WinWhisper] yt-dlp error: {msg}", flush=True)


def _check_available() -> None:
    if not _YT_DLP_AVAILABLE:
        raise RuntimeError("yt-dlp is not installed. Run: pip install yt-dlp")


class YouTubeExtractor:
    """
    Wraps yt-dlp for audio extraction and metadata fetching.
    All methods are synchronous — call via asyncio.to_thread.
    """

    def get_metadata(self, url: str) -> Dict[str, Any]:
        """
        Fetches video metadata without downloading.
        Returns dict with: title, duration, uploader, thumbnail, video_id.
        """
        _check_available()

        ydl_opts = {
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "extract_flat": False,
            "no_color": True,
            "socket_timeout": 20,
            "logger": _YtdlLogger(),
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)

        return {
            "title": info.get("title", url),
            "duration": info.get("duration"),          # seconds
            "uploader": info.get("uploader"),
            "thumbnail": info.get("thumbnail"),
            "video_id": info.get("id"),
            "channel": info.get("channel"),
            "view_count": info.get("view_count"),
        }

    def extract_audio(
        self,
        url: str,
        output_dir: str,
        on_progress: Optional[Callable[[float], None]] = None,
    ) -> Tuple[str, Dict[str, Any]]:
        """
        Downloads the best available audio from url into output_dir.
        Calls on_progress(0.0–1.0) during the download phase.
        Returns (absolute_file_path, metadata_dict).
        """
        _check_available()

        # Unique prefix so parallel downloads never collide
        prefix = uuid.uuid4().hex[:8]

        def _hook(d: dict) -> None:
            if on_progress is None:
                return
            status = d.get("status")
            if status == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate", 0)
                downloaded = d.get("downloaded_bytes", 0)
                if total and total > 0:
                    on_progress(min(downloaded / total, 0.99))
            elif status == "finished":
                on_progress(1.0)

        ydl_opts = {
            # Prefer m4a (AAC) or webm; both are natively readable by ffmpeg/faster-whisper
            "format": "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best",
            "outtmpl": str(Path(output_dir) / f"yt_{prefix}_%(id)s.%(ext)s"),
            "progress_hooks": [_hook],
            "quiet": True,
            "no_warnings": True,
            # Without a socket timeout a stalled connection hangs this thread
            # forever, and the job sits on "processing" with no way to tell a
            # slow download from a dead one.
            "socket_timeout": 30,
            "retries": 3,
            "fragment_retries": 3,
            # We report progress through the hook; yt-dlp's own progress bar
            # would otherwise spam the stdout the Tauri shell reads and logs.
            "noprogress": True,
            "no_color": True,
            # Stamping the file with the video's Last-Modified date calls
            # os.utime(), which raises OSError [Errno 22] on Windows whenever
            # that timestamp falls outside the range NTFS accepts. The mtime is
            # worth nothing to us and the failure looked like an instant,
            # unexplained YouTube error.
            "updatetime": False,
            # Belt and braces on a platform that rejects : ? * " < > | in names.
            "windowsfilenames": True,
            # Route yt-dlp's own output through our logger rather than letting
            # it write to stdout/stderr directly — the shell reads stdout to
            # discover the engine port, and a bundled app has no real console.
            "logger": _YtdlLogger(),
        }

        print(f"[WinWhisper] YouTube: downloading audio for {url}", flush=True)
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)

        video_id = info.get("id", "unknown")

        # Locate the downloaded file — yt-dlp may choose a different extension
        candidates = sorted(Path(output_dir).glob(f"yt_{prefix}_{video_id}.*"))
        if not candidates:
            candidates = sorted(Path(output_dir).glob(f"yt_{prefix}_*.*"))

        if not candidates:
            raise FileNotFoundError(
                f"Downloaded audio file not found in {output_dir} for: {url}"
            )

        metadata = {
            "title": info.get("title", url),
            "duration": info.get("duration"),
            "uploader": info.get("uploader"),
            "thumbnail": info.get("thumbnail"),
            "video_id": video_id,
        }

        size_mb = candidates[0].stat().st_size / (1024 * 1024)
        print(
            f"[WinWhisper] YouTube: downloaded {size_mb:.1f} MB "
            f"({metadata['duration']}s of audio) — handing to the transcriber",
            flush=True,
        )
        return str(candidates[0]), metadata


# Module-level singleton
extractor = YouTubeExtractor()
