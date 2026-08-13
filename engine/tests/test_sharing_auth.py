"""
Who is allowed to drive this engine.

Until sharing existed the engine bound loopback and the question never arose.
Offering a GPU to your other machines puts it on a tailnet address, where the
answer has to come from somewhere — and Tailscale already knows it: `whois` maps
a source address to the tailnet user owning that machine. Owning the device is
the credential.

The cases that matter are your own laptop (allow), a machine somebody else
shared into your tailnet (refuse — these really do appear alongside your own),
and anything that is not a peer at all (refuse).
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from core import sharing, tailnet

MY_USER = 1111111111111111
SOMEONE_ELSE = 2222222222222222


@pytest.fixture()
def app_for(monkeypatch):
    def build(owners: dict):
        """`owners` maps source IP -> tailnet user id, or absent for 'not a peer'."""
        monkeypatch.setattr(tailnet, "self_user_id", lambda *a, **k: MY_USER)
        monkeypatch.setattr(tailnet, "whois_user_id", lambda ip: owners.get(ip))
        sharing._refused_logged.clear()

        app = FastAPI()
        app.add_middleware(sharing.TailnetOwnerOnly)

        @app.get("/transcripts")
        async def transcripts():
            return [{"id": "t1", "title": "Private recording"}]

        return app
    return build


def _get(app, from_ip: str):
    with TestClient(app, client=(from_ip, 40000)) as client:
        return client.get("/transcripts")


# ── Allowed ──────────────────────────────────────────────────────────────────

def test_loopback_is_always_allowed(app_for):
    """The app itself talks to its engine this way; it must never be gated."""
    assert _get(app_for({}), "127.0.0.1").status_code == 200


def test_your_own_device_is_allowed(app_for):
    app = app_for({"100.75.236.60": MY_USER})
    assert _get(app, "100.75.236.60").status_code == 200


# ── Refused ──────────────────────────────────────────────────────────────────

def test_a_device_shared_into_your_tailnet_is_refused(app_for):
    """
    Not hypothetical: a real tailnet carries machines other people have shared
    in, listed indistinguishably from your own until you check the owner.
    """
    app = app_for({"100.103.177.68": SOMEONE_ELSE})

    response = _get(app, "100.103.177.68")

    assert response.status_code == 403
    assert "your own devices" in response.json()["detail"]


def test_something_that_is_not_a_peer_at_all_is_refused(app_for):
    assert _get(app_for({}), "203.0.113.9").status_code == 403


def test_a_refused_request_never_reaches_the_route(app_for):
    app = app_for({"203.0.113.9": SOMEONE_ELSE})
    assert "Private recording" not in _get(app, "203.0.113.9").text


def test_everything_is_refused_when_tailscale_cannot_answer(monkeypatch):
    """Fail closed: if we cannot establish who is calling, we do not serve them."""
    monkeypatch.setattr(tailnet, "self_user_id", lambda *a, **k: None)
    monkeypatch.setattr(tailnet, "whois_user_id", lambda ip: None)
    sharing._refused_logged.clear()

    app = FastAPI()
    app.add_middleware(sharing.TailnetOwnerOnly)

    @app.get("/transcripts")
    async def transcripts():
        return []

    assert _get(app, "100.75.236.60").status_code == 403
    # ...but the local app keeps working, so a Tailscale outage does not brick it.
    assert _get(app, "127.0.0.1").status_code == 200


# ── Noise control ────────────────────────────────────────────────────────────

def test_a_repeat_offender_is_only_logged_once(app_for, capsys):
    app = app_for({"203.0.113.9": SOMEONE_ELSE})
    for _ in range(3):
        _get(app, "203.0.113.9")

    logged = capsys.readouterr().out.count("refused a request from")

    # Enough to find a misconfigured device by; not enough to bury the log.
    assert logged == 1
