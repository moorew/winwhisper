"""
Working out which machines on a tailnet are yours.

The filtering here is not defensive tidiness — it was written against a real
tailnet that carries 602 peers, of which 573 are Mullvad exit nodes and several
are devices other people have shared in. Discovery probes what survives this
function, so getting it wrong means either probing every VPN endpoint in the
world or handing your files to somebody else's laptop.

The fixture below is synthetic and mirrors that shape. Real hostnames, addresses
and user IDs are deliberately not committed.
"""
from __future__ import annotations

import json

import pytest

from core import tailnet

MY_USER = 1111111111111111
OTHER_USER = 2222222222222222
SUFFIX = "example-tailnet.ts.net"


def _peer(host, os_name, ip, user=MY_USER, online=True, dns=None):
    return {
        "HostName": host,
        "OS": os_name,
        "UserID": user,
        "Online": online,
        "DNSName": dns or f"{host.lower()}.{SUFFIX}.",
        "TailscaleIPs": [ip, "fd7a:115c:a1e0::1"],
    }


def _status(peers):
    return {
        "BackendState": "Running",
        "MagicDNSSuffix": SUFFIX,
        "Self": {
            "HostName": "laptop",
            "UserID": MY_USER,
            "DNSName": f"laptop.{SUFFIX}.",
            "TailscaleIPs": ["100.10.0.1", "fd7a:115c:a1e0::9"],
        },
        "Peer": {f"key{i}": p for i, p in enumerate(peers)},
    }


FIXTURE = _status([
    _peer("gpu-box", "windows", "100.10.0.2"),
    _peer("work-laptop", "windows", "100.10.0.3"),
    _peer("nas", "linux", "100.10.0.4"),
    _peer("desktop", "macOS", "100.10.0.5"),
    _peer("spare", "windows", "100.10.0.6", online=False),
    # Not yours: shared into the tailnet by somebody else.
    _peer("someone-else-pc", "linux", "100.10.0.7", user=OTHER_USER),
    # Not yours: a Mullvad exit node. Real tailnets carry hundreds.
    _peer("us-lax-wg-402", "linux", "100.20.0.1", user=OTHER_USER,
          dns="us-lax-wg-402.mullvad.ts.net."),
    _peer("de-fra-wg-401", "linux", "100.20.0.2", user=OTHER_USER,
          dns="de-fra-wg-401.mullvad.ts.net."),
    # Yours, but cannot run an engine.
    _peer("my-phone", "android", "100.10.0.8"),
    _peer("my-tablet", "iOS", "100.10.0.9"),
    _peer("living-room", "tvOS", "100.10.0.10"),
])


@pytest.fixture(autouse=True)
def _no_real_cli(monkeypatch):
    """Never shell out to a real tailscale during tests."""
    tailnet.reset_caches()
    monkeypatch.setattr(
        tailnet, "_run",
        lambda args: (_ for _ in ()).throw(AssertionError(f"unexpected CLI call: {args}")),
    )
    yield
    tailnet.reset_caches()


def _use(monkeypatch, payload):
    monkeypatch.setattr(tailnet, "_run", lambda args: json.dumps(payload))


# ── Device filtering ─────────────────────────────────────────────────────────

def test_only_your_own_engine_capable_devices_survive(monkeypatch):
    _use(monkeypatch, FIXTURE)

    names = [d.hostname for d in tailnet.own_devices()]

    assert names == ["desktop", "gpu-box", "nas", "work-laptop", "spare"]


def test_devices_shared_into_your_tailnet_are_excluded(monkeypatch):
    _use(monkeypatch, FIXTURE)
    assert "someone-else-pc" not in [d.hostname for d in tailnet.own_devices()]


def test_mullvad_exit_nodes_are_excluded(monkeypatch):
    """
    The reason this matters: on the tailnet this was built against, 573 of 602
    peers were Mullvad nodes. Probing them would be the whole of discovery.
    """
    _use(monkeypatch, FIXTURE)
    hosts = [d.hostname for d in tailnet.own_devices()]
    assert not any(h.endswith("-wg-402") or h.endswith("-wg-401") for h in hosts)


def test_phones_and_tvs_are_excluded(monkeypatch):
    _use(monkeypatch, FIXTURE)
    hosts = [d.hostname for d in tailnet.own_devices()]
    assert "my-phone" not in hosts and "my-tablet" not in hosts
    assert "living-room" not in hosts


def test_offline_devices_are_listed_last_but_kept(monkeypatch):
    """Kept so the UI can say "gpu-box is offline" rather than silently omitting it."""
    _use(monkeypatch, FIXTURE)
    devices = tailnet.own_devices()
    assert devices[-1].hostname == "spare"
    assert devices[-1].online is False


def test_ipv4_is_preferred_over_ipv6(monkeypatch):
    _use(monkeypatch, FIXTURE)
    assert all(":" not in d.ip for d in tailnet.own_devices())


def test_no_devices_when_magicdns_is_off(monkeypatch):
    """Without a suffix there is no way to tell your peers from anyone else's."""
    payload = dict(FIXTURE)
    payload["MagicDNSSuffix"] = None
    _use(monkeypatch, payload)
    assert tailnet.own_devices() == []


# ── Self ─────────────────────────────────────────────────────────────────────

def test_self_details(monkeypatch):
    _use(monkeypatch, FIXTURE)
    assert tailnet.tailnet_ipv4() == "100.10.0.1"
    assert tailnet.self_user_id() == MY_USER
    assert tailnet.self_hostname() == "laptop"


def test_unavailable_when_the_cli_is_missing(monkeypatch):
    def boom(_args):
        raise tailnet.TailscaleUnavailable("not found")
    monkeypatch.setattr(tailnet, "_run", boom)
    assert tailnet.is_available() is False


# ── whois, which is the access decision ──────────────────────────────────────

def test_whois_identifies_the_owning_user(monkeypatch):
    monkeypatch.setattr(
        tailnet, "_run",
        lambda args: json.dumps({"Node": {"User": MY_USER, "Name": "gpu-box."}}),
    )
    assert tailnet.whois_user_id("100.10.0.2") == MY_USER


def test_whois_is_cached(monkeypatch):
    calls = []

    def once(args):
        calls.append(args)
        return json.dumps({"Node": {"User": MY_USER}})

    monkeypatch.setattr(tailnet, "_run", once)
    tailnet.whois_user_id("100.10.0.2")
    tailnet.whois_user_id("100.10.0.2")
    # It sits on the request path while another machine is using this one's GPU.
    assert len(calls) == 1


def test_whois_returns_none_for_a_stranger(monkeypatch):
    def boom(_args):
        raise tailnet.TailscaleUnavailable("no match for IP")
    monkeypatch.setattr(tailnet, "_run", boom)
    assert tailnet.whois_user_id("203.0.113.5") is None


def test_whois_survives_unparseable_output(monkeypatch):
    monkeypatch.setattr(tailnet, "_run", lambda args: "not json at all")
    assert tailnet.whois_user_id("100.10.0.2") is None


# ── status caching ───────────────────────────────────────────────────────────

def test_status_is_cached(monkeypatch):
    calls = []

    def counted(args):
        calls.append(args)
        return json.dumps(FIXTURE)

    monkeypatch.setattr(tailnet, "_run", counted)
    tailnet.status()
    tailnet.status()
    # 35 KB of JSON on a real tailnet; discovery polls.
    assert len(calls) == 1


def test_status_can_be_forced(monkeypatch):
    calls = []

    def counted(args):
        calls.append(args)
        return json.dumps(FIXTURE)

    monkeypatch.setattr(tailnet, "_run", counted)
    tailnet.status()
    tailnet.status(force=True)
    assert len(calls) == 2
