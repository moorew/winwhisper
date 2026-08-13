"""
Falling back between YouTube player clients.

A player client's format URLs are only good for that client. Asking for several
at once merges their formats and picks the best by bitrate, which can hand back
a URL belonging to a client that needs a proof-of-origin token we cannot supply
— and that fails with 403 at download time, long after the format was chosen.
Nothing in the format selector can express "and make sure this one works", so
the fallback has to be over whole clients.

Seen in the field: a job died on `HTTP Error 403: Forbidden` having tried
exactly one combination.
"""
from __future__ import annotations

import pytest

from features import youtube


@pytest.fixture(autouse=True)
def _no_waiting(monkeypatch):
    """
    The backoff between attempts is real; waiting for it in tests is not.

    yt-dlp is also stubbed present: the fast suite installs requirements-dev.txt
    only, which leaves it out on purpose, and the retry logic under test never
    reaches it.
    """
    monkeypatch.setattr(youtube.time, "sleep", lambda _s: None)
    monkeypatch.setattr(youtube, "_YT_DLP_AVAILABLE", True)


def _record_attempts(monkeypatch, outcomes):
    """
    Replaces the single-attempt download with a script of outcomes, and records
    which client sets were tried.
    """
    tried: list[tuple] = []
    remaining = list(outcomes)

    def fake(_self, _url, _out, clients, _on_progress=None, _on_detail=None):
        tried.append(clients)
        result = remaining.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(youtube.YouTubeExtractor, "_download_once", fake)
    return tried


def test_a_403_moves_on_to_the_next_client(monkeypatch):
    tried = _record_attempts(monkeypatch, [
        RuntimeError("HTTP Error 403: Forbidden"),
        ("C:/temp/audio.m4a", {"title": "Second time lucky"}),
    ])

    path, meta = youtube.extractor.extract_audio("https://youtu.be/x", "C:/temp")

    assert path == "C:/temp/audio.m4a"
    assert meta["title"] == "Second time lucky"
    assert tried == [youtube.CLIENT_ATTEMPTS[0], youtube.CLIENT_ATTEMPTS[1]]


def test_every_client_is_tried_before_giving_up(monkeypatch):
    tried = _record_attempts(
        monkeypatch,
        [RuntimeError("HTTP Error 403: Forbidden")] * len(youtube.CLIENT_ATTEMPTS),
    )

    with pytest.raises(RuntimeError) as exc:
        youtube.extractor.extract_audio("https://youtu.be/x", "C:/temp")

    assert tried == list(youtube.CLIENT_ATTEMPTS)
    # The message has to name the real cause; "download failed" sends whoever
    # reads it looking in the wrong place.
    assert "403" in str(exc.value)
    assert str(len(youtube.CLIENT_ATTEMPTS)) in str(exc.value)


def test_the_first_client_that_works_is_the_only_one_used(monkeypatch):
    tried = _record_attempts(monkeypatch, [("C:/temp/a.m4a", {"title": "t"})])

    youtube.extractor.extract_audio("https://youtu.be/x", "C:/temp")

    assert tried == [youtube.CLIENT_ATTEMPTS[0]]


def test_a_stalled_transfer_is_not_retried(monkeypatch):
    """
    Bytes that stopped arriving are the network's doing, not the client's.
    Retrying would only buy three more ninety-second waits.
    """
    tried = _record_attempts(monkeypatch, [youtube._StalledDownload("no data for 90s")])

    with pytest.raises(youtube._StalledDownload):
        youtube.extractor.extract_audio("https://youtu.be/x", "C:/temp")

    assert len(tried) == 1


def test_progress_resets_between_attempts(monkeypatch):
    """A failed attempt leaves the bar part-filled; the next one starts again."""
    _record_attempts(monkeypatch, [
        RuntimeError("HTTP Error 403: Forbidden"),
        ("C:/temp/a.m4a", {"title": "t"}),
    ])
    reported: list[float] = []

    youtube.extractor.extract_audio(
        "https://youtu.be/x", "C:/temp", on_progress=reported.append
    )

    assert 0.0 in reported


def test_the_preferred_clients_need_no_javascript_runtime():
    """
    A bundled app ships no JS runtime, so a client that depends on one falls
    back slowly and gets throttled. android_vr is the one that does not.
    """
    assert youtube.CLIENT_ATTEMPTS[0] == ("default",)
    assert ("android_vr",) in youtube.CLIENT_ATTEMPTS
