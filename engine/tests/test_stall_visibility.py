"""
Making a wedged job describable.

Everything between "Transcribing" and the first segment happens inside native
code: the container is decoded, voice activity detection sweeps the whole file,
then the first window is encoded. None of it reports anything, so on a long
recording the progress bar holds still for minutes and a genuine hang is
indistinguishable from ordinary work.

These cover the two things that tell them apart — a stage label that moves
before any segment exists, and a watchdog that dumps thread stacks into
engine.log once a phase has gone quiet for too long.
"""
from __future__ import annotations

import io
import time

from core import watchdog
from core.transcriber import Transcriber


class _Seg:
    def __init__(self, index: int, text: str) -> None:
        self.start, self.end, self.text = float(index), float(index + 1), text
        self.words = None


class _Model:
    def transcribe(self, _audio, **_kwargs):
        def gen():
            yield _Seg(0, " Hello.")
            yield _Seg(1, " Goodbye.")

        class _Info:
            duration = 2.0
            language = "en"
        return gen(), _Info()


def _transcriber() -> Transcriber:
    t = Transcriber()
    t._model = _Model()
    t._model_name, t._device = "tiny", "cpu"
    return t


# ── Stage reporting ──────────────────────────────────────────────────────────

def test_stages_are_reported_before_the_first_segment():
    stages: list[str] = []
    _transcriber().transcribe_with_progress("a.wav", on_stage=stages.append)

    # The point of the exercise: the user is told what is happening during the
    # stretch where the percentage cannot move.
    assert stages[0] == "Decoding audio"
    assert "Detecting speech" in stages
    assert stages.index("Detecting speech") < stages.index("Transcribing")


def test_stage_callback_is_optional():
    segments, _ = _transcriber().transcribe_with_progress("a.wav")
    assert len(segments) == 2


def test_vad_disabled_still_names_its_phase():
    stages: list[str] = []
    _transcriber().transcribe_with_progress("a.wav", vad_filter=False, on_stage=stages.append)
    assert "Preparing audio" in stages
    assert "Detecting speech" not in stages


def test_cancelling_before_the_first_segment_is_honoured():
    """
    A job abandoned during decoding or speech detection used to run to
    completion: cancellation was only checked between segments, and on a long
    file the first one can be minutes away.
    """
    import pytest

    from core.transcriber import TranscriptionCancelled

    stages: list[str] = []
    with pytest.raises(TranscriptionCancelled):
        _transcriber().transcribe_with_progress(
            "a.wav", should_continue=lambda: False, on_stage=stages.append
        )
    # Gave up at the first boundary rather than transcribing anything.
    assert stages == []


def test_watchdog_is_cleared_once_transcription_returns():
    _transcriber().transcribe_with_progress("a.wav")
    assert watchdog._activity is None


# ── Watchdog ─────────────────────────────────────────────────────────────────

def _drain(monkeypatch) -> io.StringIO:
    """Runs one watchdog sweep immediately instead of on its 15s timer."""
    buffer = io.StringIO()
    monkeypatch.setattr("sys.stdout", buffer)
    return buffer


def test_a_quiet_phase_dumps_stacks(monkeypatch):
    monkeypatch.setattr(watchdog, "FIRST_DUMP_SECONDS", 0.0)
    buffer = _drain(monkeypatch)

    watchdog.begin("voice activity detection")
    watchdog._watch_once()
    watchdog.end()

    out = buffer.getvalue()
    assert "STALL" in out
    assert "voice activity detection" in out
    # The stack dump is the whole point — a line saying "stalled" without one
    # would leave us exactly as blind as before.
    assert "Traceback" in out or "File " in out


def test_a_phase_that_keeps_beating_is_left_alone(monkeypatch):
    monkeypatch.setattr(watchdog, "FIRST_DUMP_SECONDS", 5.0)
    buffer = _drain(monkeypatch)

    watchdog.begin("transcribing")
    time.sleep(0.01)
    watchdog.beat()
    watchdog._watch_once()
    watchdog.end()

    assert "STALL" not in buffer.getvalue()


def test_nothing_is_reported_when_no_phase_is_running(monkeypatch):
    monkeypatch.setattr(watchdog, "FIRST_DUMP_SECONDS", 0.0)
    buffer = _drain(monkeypatch)

    watchdog.end()
    watchdog._watch_once()

    assert buffer.getvalue() == ""


def test_repeated_dumps_back_off(monkeypatch):
    monkeypatch.setattr(watchdog, "FIRST_DUMP_SECONDS", 0.0)
    monkeypatch.setattr(watchdog, "REPEAT_DUMP_SECONDS", 3600.0)
    buffer = _drain(monkeypatch)

    watchdog.begin("transcribing")
    watchdog._watch_once()          # first dump fires
    first = buffer.getvalue()
    watchdog._watch_once()          # second is held back by the longer interval
    watchdog.end()

    # Counted on the header rather than the "STALL" prefix, which every line of
    # the stack dump also carries.
    marker = "has not reported progress"
    assert first.count(marker) == 1
    assert buffer.getvalue().count(marker) == 1


# ── Output encoding ──────────────────────────────────────────────────────────

def test_engine_output_is_pinned_to_utf8():
    """
    The shell reads stdout and mirrors it into engine.log. It used to stop
    draining the moment a byte failed to decode as UTF-8, at which point the
    pipe filled and the engine blocked forever on its next print() — mid-job,
    with no error, and with the stall watchdog silenced because its own output
    went down the same pipe. A YouTube job died on the first em dash it tried
    to log.
    """
    import sys

    from main import _force_utf8_output

    _force_utf8_output()
    for stream in (sys.stdout, sys.stderr):
        encoding = getattr(stream, "encoding", "")
        if encoding:  # pytest may swap in a stream without one
            assert encoding.lower().replace("-", "") == "utf8"


def test_the_lines_we_log_survive_a_round_trip():
    """Every non-ASCII character the engine prints has to encode cleanly."""
    from core.watchdog import _elapsed

    lines = [
        "[WinWhisper] YouTube: downloaded 8.8 MB (573s of audio) — handing to the transcriber",
        "[WinWhisper] job abc12345: Decoding audio · base",
        f"[WinWhisper] STALL: quiet for {_elapsed(190)}",
    ]
    for line in lines:
        assert line.encode("utf-8").decode("utf-8") == line
