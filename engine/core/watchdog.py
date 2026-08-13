"""
A stall detector for the job worker.

Transcription spends long stretches inside native code — decoding a container,
running voice activity detection, then CTranslate2 inference — and none of it
reports anything on its own. When one of those never returns, the job sits at a
fixed percentage forever and the log holds no clue as to which one it was.

This module keeps a single "what is happening right now" marker. A daemon thread
watches it, and when nothing has moved for long enough it dumps the stack of
every live thread to stdout, which the Tauri shell mirrors into engine.log. That
turns "it hangs" into a stack trace naming the exact call.

It never kills anything. A slow machine transcribing a three-hour file is
indistinguishable from a hang until it finishes, and abandoning real work would
be worse than the wait.
"""

from __future__ import annotations

import sys
import threading
import time
import traceback
from typing import Optional

# How long an activity may go without a heartbeat before we dump stacks.
FIRST_DUMP_SECONDS = 180.0

# Subsequent dumps back off so a genuinely slow job does not fill the log.
REPEAT_DUMP_SECONDS = 600.0

_lock = threading.Lock()
_activity: Optional[str] = None
_since: float = 0.0
_beat: float = 0.0
_dumps: int = 0
_thread: Optional[threading.Thread] = None


def begin(activity: str) -> None:
    """Marks the start of a phase that is expected to make progress."""
    global _activity, _since, _beat, _dumps
    now = time.monotonic()
    with _lock:
        _activity = activity
        _since = now
        _beat = now
        _dumps = 0


def beat() -> None:
    """Reports that the current phase is still moving."""
    global _beat, _dumps
    now = time.monotonic()
    with _lock:
        _beat = now
        _dumps = 0


def end() -> None:
    """Clears the marker — nothing is being watched until the next begin()."""
    global _activity
    with _lock:
        _activity = None


def _elapsed(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    return f"{m}m{s:02d}s"


def _thread_stacks() -> list:
    """
    Every live thread's Python stack, as plain lines.

    Deliberately not faulthandler: that writes to a file descriptor, and a
    frozen Windows build is not guaranteed to have a usable one for stdout. This
    goes through print() like every other engine line, so it lands in
    engine.log in order rather than racing the stderr stream.
    """
    names = {t.ident: t.name for t in threading.enumerate()}
    lines = []
    for ident, frame in sys._current_frames().items():
        lines.append(f"--- thread {names.get(ident, '?')} ({ident}) ---")
        for entry in traceback.format_stack(frame):
            lines.extend(entry.rstrip().splitlines())
    return lines


def _watch_once() -> None:
    """One sweep. Separated from the timer so it can be driven directly."""
    global _beat, _dumps

    with _lock:
        activity = _activity
        if activity is None:
            return
        now = time.monotonic()
        quiet = now - _beat
        threshold = FIRST_DUMP_SECONDS if _dumps == 0 else REPEAT_DUMP_SECONDS
        if quiet < threshold:
            return
        since = now - _since
        _dumps += 1
        # Counts as activity for the next interval, so a phase that stays quiet
        # backs off rather than dumping on every sweep.
        _beat = now

    print(
        f"[WinWhisper] STALL: '{activity}' has not reported progress for "
        f"{_elapsed(quiet)} ({_elapsed(since)} in this phase). "
        "Thread stacks follow — this is diagnostic, the job is still running.",
        flush=True,
    )
    try:
        for line in _thread_stacks():
            print(f"[WinWhisper] STALL:   {line}", flush=True)
    except Exception as exc:  # pragma: no cover - diagnostics must not throw
        print(f"[WinWhisper] STALL: could not dump thread stacks: {exc}", flush=True)


def _watch() -> None:
    while True:
        time.sleep(15.0)
        try:
            _watch_once()
        except Exception:  # pragma: no cover - the watcher must outlive its own bugs
            pass


def start() -> None:
    """Starts the watcher once; safe to call repeatedly."""
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    _thread = threading.Thread(target=_watch, name="stall-watchdog", daemon=True)
    _thread.start()
