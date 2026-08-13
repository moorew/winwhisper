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


# Player clients to try, in order, until one produces a file.
#
# YouTube hands each client a different set of format URLs, and a URL is only
# good for the client that issued it. Asking for several at once merges their
# formats and picks the best by bitrate — which can hand back a URL whose client
# needs a proof-of-origin token we cannot supply, and that fails with 403 at
# download time, long after the format was chosen. Nothing in the format
# selector can express "and make sure this one actually works".
#
# So the retry is over whole clients rather than formats. Observed while
# diagnosing this: `web` alone cannot serve format 140 at all ("requested format
# is not available"), yet pairing it with `android_vr` let its unusable URL win
# the selection and 403 the download. `tv` reports DRM on videos the others
# fetch happily.
CLIENT_ATTEMPTS: Tuple[Tuple[str, ...], ...] = (
    ("default",),               # yt-dlp's own maintained choice
    ("android_vr",),            # needs no JS runtime, which a bundled app has not got
    ("android_vr", "web"),
    ("web_safari", "mweb"),
)


# Grows with each attempt: 3s, 6s, 9s. Long enough to outlast a brief throttle,
# short enough that a genuinely unavailable video still fails promptly.
RETRY_BACKOFF_SECONDS = 3.0


class _StalledDownload(RuntimeError):
    """Our own stall guard tripped — a different player client will not help."""


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
        Downloads the best available audio from url into output_dir, trying each
        player client in turn until one works.
        Calls on_progress(0.0–1.0) and on_detail("12.4 MB of 38.1 MB · 2.1 MB/s")
        during the download phase.
        Returns (absolute_file_path, metadata_dict).
        """
        _check_available()

        last_error: Optional[BaseException] = None
        for attempt, clients in enumerate(CLIENT_ATTEMPTS, start=1):
            try:
                return self._download_once(
                    url, output_dir, clients, on_progress, on_detail
                )
            except _StalledDownload:
                # The bytes stopped arriving. That is the network, not the
                # client, and three more attempts would only be three more
                # ninety-second waits.
                raise
            except Exception as exc:
                last_error = exc
                remaining = len(CLIENT_ATTEMPTS) - attempt
                print(
                    f"[WinWhisper] YouTube: player client {'+'.join(clients)} failed "
                    f"({exc.__class__.__name__}: {str(exc).strip()[:160]})"
                    + (f" — trying another ({remaining} left)" if remaining else ""),
                    flush=True,
                )
                if on_progress:
                    on_progress(0.0)
                if remaining:
                    # These 403s are transient and scoped to the address, not to
                    # the client: while diagnosing this I watched all four
                    # clients fail within three seconds, then the first of them
                    # succeed on the very next run. Retrying instantly mostly
                    # re-asks a server that is still saying no.
                    time.sleep(RETRY_BACKOFF_SECONDS * attempt)

        raise RuntimeError(
            f"Could not download audio after trying {len(CLIENT_ATTEMPTS)} player "
            f"clients. YouTube rejected every one. Last error: {last_error}"
        ) from last_error

    def _download_once(
        self,
        url: str,
        output_dir: str,
        clients: Tuple[str, ...],
        on_progress: Optional[Callable[[float], None]] = None,
        on_detail: Optional[Callable[[str], None]] = None,
    ) -> Tuple[str, Dict[str, Any]]:
        """One download attempt with one set of player clients."""
        # Unique per attempt, so a failed try's leftovers can never be mistaken
        # for this one's output by the glob below.
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
            info_dict = d.get("info_dict") or {}
            total = (
                d.get("total_bytes")
                or d.get("total_bytes_estimate")
                # Last resort: the size the extractor advertised. Without it a
                # download yt-dlp cannot size leaves the bar pinned at zero for
                # its whole duration, which reads as a stalled job.
                or info_dict.get("filesize")
                or info_dict.get("filesize_approx")
                or 0
            )
            speed = d.get("speed") or 0
            now = time.monotonic()

            if downloaded != progress_state["bytes"]:
                progress_state["bytes"] = downloaded
                progress_state["changed"] = now
            elif now - progress_state["changed"] > stall_limit:
                raise _StalledDownload(
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
            # Chosen by the caller, which retries with a different set when a
            # download fails. See CLIENT_ATTEMPTS.
            "extractor_args": {"youtube": {"player_client": list(clients)}},
        }

        print(
            f"[WinWhisper] YouTube: downloading audio for {url} "
            f"via player client {'+'.join(clients)}",
            flush=True,
        )
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)

        # Which format actually came back matters when diagnosing a slow or
        # unreadable download after the fact, and it is invisible otherwise.
        size = info.get("filesize") or info.get("filesize_approx") or 0
        print(
            f"[WinWhisper] YouTube: format {info.get('format_id')} "
            f"({info.get('ext')}/{info.get('acodec')}, "
            f"{info.get('abr') or '?'} kbps, "
            f"{size / 1048576:.1f} MB) for a {info.get('duration')}s video",
            flush=True,
        )

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
