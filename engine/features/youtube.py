from __future__ import annotations

import time
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

try:
    import yt_dlp
    _YT_DLP_AVAILABLE = True
except ImportError:
    _YT_DLP_AVAILABLE = False


# No bytes for this long during a download means it is not coming back.
STALL_SECONDS = 90


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
        on_detail: Optional[Callable[[str], None]] = None,
    ) -> Tuple[str, Dict[str, Any]]:
        """
        Downloads the best available audio from url into output_dir.
        Calls on_progress(0.0–1.0) and on_detail("12.4 MB of 38.1 MB · 2.1 MB/s")
        during the download phase.
        Returns (absolute_file_path, metadata_dict).
        """
        _check_available()

        # Unique prefix so parallel downloads never collide
        prefix = uuid.uuid4().hex[:8]

        # If nothing arrives for this long the connection is dead in all but
        # name — YouTube throttles hard when yt-dlp has no JS runtime to solve
        # its challenge with, and a trickle keeps the socket timeout from ever
        # firing. Better to fail with a reason than block the worker forever.
        stall_limit = STALL_SECONDS
        progress_state = {"bytes": 0, "changed": time.monotonic(), "logged": 0.0}

        def _hook(d: dict) -> None:
            status = d.get("status")
            if status == "finished":
                if on_progress:
                    on_progress(1.0)
                return
            if status != "downloading":
                return

            downloaded = d.get("downloaded_bytes") or 0
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            speed = d.get("speed") or 0
            now = time.monotonic()

            if downloaded != progress_state["bytes"]:
                progress_state["bytes"] = downloaded
                progress_state["changed"] = now
            elif now - progress_state["changed"] > stall_limit:
                raise RuntimeError(
                    f"YouTube download stalled — no data for {stall_limit}s "
                    f"after {downloaded / 1048576:.1f} MB. The video may be "
                    "rate-limited; try again or use a different video."
                )

            if on_progress and total > 0:
                on_progress(min(downloaded / total, 0.99))

            # Always report *something*: with the total unknown a percentage
            # would sit at zero for the whole download, which is what made a
            # working download look like a hang.
            if on_detail:
                parts = [f"{downloaded / 1048576:.1f} MB"]
                if total:
                    parts[0] += f" of {total / 1048576:.1f} MB"
                if speed:
                    parts.append(f"{speed / 1048576:.1f} MB/s")
                on_detail(" · ".join(parts))

            if now - progress_state["logged"] > 5:
                progress_state["logged"] = now
                print(
                    f"[WinWhisper] YouTube: {downloaded / 1048576:.1f} MB"
                    + (f" of {total / 1048576:.1f} MB" if total else "")
                    + (f" at {speed / 1048576:.2f} MB/s" if speed else ""),
                    flush=True,
                )

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
            # We do not ship ffmpeg, so container fixups cannot run. Whisper
            # reads the raw stream perfectly well; attempting the fixup only
            # produces a warning and, for some formats, a hard failure.
            "fixup": "never",
            # Player clients that do not need a JavaScript runtime. Without
            # this yt-dlp works through the JS-dependent clients first, which
            # on a machine with no runtime means slow fallbacks and throttled
            # transfers.
            # ios is omitted deliberately: it needs a PO token we cannot supply and only
            # produces a warning before being skipped.
            "extractor_args": {"youtube": {"player_client": ["android_vr", "web"]}},
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
