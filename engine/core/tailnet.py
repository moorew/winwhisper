"""
A thin, read-only wrapper over the Tailscale CLI.

Remote transcription needs three facts from Tailscale: which of your machines
are reachable, what this machine's own tailnet address is, and — when another
machine asks to use this one's GPU — whether the caller is really yours.

The CLI is used rather than the LocalAPI socket because on Windows that socket
lives under \\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled and
needs administrator rights, which the app does not have and should not want.
`tailscale status --json` and `tailscale whois --json` need no elevation.

Nothing here mutates Tailscale state. The worst any call can do is time out.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

# Windows would otherwise flash a console window for every invocation, and this
# module is called on a timer.
_CREATE_NO_WINDOW = 0x08000000

# `tailscale status --json` is not cheap: on a tailnet using Mullvad exit nodes
# it returns hundreds of peers and tens of kilobytes. Discovery polls, so the
# result is held briefly.
STATUS_TTL_SECONDS = 20.0

# Peer identity changes far less often than peer reachability, and this one is
# consulted on the request path when another machine is using our GPU.
WHOIS_TTL_SECONDS = 300.0

CLI_TIMEOUT_SECONDS = 10.0

# Machines that could plausibly run an engine. Phones and TVs are on the tailnet
# too and probing them is pure latency.
ENGINE_CAPABLE_OS = {"windows", "linux", "macOS"}


class TailscaleUnavailable(RuntimeError):
    """Tailscale is not installed, not running, or not logged in."""


@dataclass(frozen=True)
class Peer:
    hostname: str
    ip: str
    os: str
    dns_name: str
    online: bool


def _candidate_binaries() -> List[str]:
    found = shutil.which("tailscale")
    if found:
        return [found]
    # Not on PATH for every user on Windows, and the .app bundle on macOS never
    # is. These are the stock install locations.
    if sys.platform == "win32":
        program_files = [
            os.environ.get("ProgramFiles", r"C:\Program Files"),
            os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
        ]
        return [os.path.join(p, "Tailscale", "tailscale.exe") for p in program_files if p]
    if sys.platform == "darwin":
        return ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"]
    return []


def _run(args: List[str]) -> str:
    """Runs the CLI and returns stdout, or raises TailscaleUnavailable."""
    last_error: Optional[str] = None
    for binary in _candidate_binaries():
        if not os.path.exists(binary) and shutil.which(binary) is None:
            continue
        try:
            result = subprocess.run(
                [binary, *args],
                capture_output=True,
                text=True,
                timeout=CLI_TIMEOUT_SECONDS,
                creationflags=_CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            last_error = f"{exc.__class__.__name__}: {exc}"
            continue
        if result.returncode == 0:
            return result.stdout
        last_error = (result.stderr or result.stdout or "").strip()[:200]

    raise TailscaleUnavailable(
        last_error or "the tailscale command was not found on this machine"
    )


# ── status ────────────────────────────────────────────────────────────────────

_status_lock = threading.Lock()
_status_cache: Optional[Dict[str, Any]] = None
_status_at: float = 0.0


def status(force: bool = False) -> Dict[str, Any]:
    """Parsed `tailscale status --json`, cached for STATUS_TTL_SECONDS."""
    global _status_cache, _status_at
    with _status_lock:
        fresh = _status_cache is not None and time.monotonic() - _status_at < STATUS_TTL_SECONDS
        if fresh and not force:
            return _status_cache  # type: ignore[return-value]

    parsed = json.loads(_run(["status", "--json"]))

    with _status_lock:
        _status_cache = parsed
        _status_at = time.monotonic()
    return parsed


def is_available() -> bool:
    try:
        return status().get("BackendState") == "Running"
    except (TailscaleUnavailable, ValueError):
        return False


def self_user_id(raw: Optional[Dict[str, Any]] = None) -> Optional[int]:
    return ((raw or status()).get("Self") or {}).get("UserID")


def tailnet_ipv4(raw: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """This machine's 100.x address — what the shared server binds to."""
    for address in ((raw or status()).get("Self") or {}).get("TailscaleIPs") or []:
        if ":" not in address:
            return address
    return None


def self_hostname(raw: Optional[Dict[str, Any]] = None) -> Optional[str]:
    return ((raw or status()).get("Self") or {}).get("HostName")


def own_devices(raw: Optional[Dict[str, Any]] = None) -> List[Peer]:
    """
    Your machines, and only yours.

    Three filters, each earning its place on a real tailnet:

    * the MagicDNS suffix — a tailnet using Mullvad exit nodes carries hundreds
      of peers that are not yours at all (602 peers, 573 of them Mullvad, on the
      tailnet this was written against). Without this, discovery would probe
      every VPN endpoint in the world;
    * the owning user — devices other people share *into* your tailnet appear
      alongside your own and must not be trusted with your files;
    * the operating system — phones and TVs cannot run an engine.
    """
    raw = raw or status()
    me = raw.get("Self") or {}
    suffix = raw.get("MagicDNSSuffix")
    my_user = me.get("UserID")
    if not suffix or my_user is None:
        return []

    devices: List[Peer] = []
    for peer in (raw.get("Peer") or {}).values():
        dns_name = (peer.get("DNSName") or "").rstrip(".")
        if not dns_name.endswith(suffix):
            continue
        if peer.get("UserID") != my_user:
            continue
        if peer.get("OS") not in ENGINE_CAPABLE_OS:
            continue
        ips = peer.get("TailscaleIPs") or []
        ipv4 = next((a for a in ips if ":" not in a), None)
        if not ipv4:
            continue
        devices.append(
            Peer(
                hostname=peer.get("HostName") or dns_name,
                ip=ipv4,
                os=peer.get("OS") or "",
                dns_name=dns_name,
                online=bool(peer.get("Online")),
            )
        )
    devices.sort(key=lambda p: (not p.online, p.hostname.lower()))
    return devices


# ── whois ─────────────────────────────────────────────────────────────────────

_whois_lock = threading.Lock()
_whois_cache: Dict[str, tuple] = {}  # ip -> (user_id, expires_at)


def whois_user_id(ip: str) -> Optional[int]:
    """
    The tailnet user who owns the machine at `ip`, or None if it is not a peer.

    This is the credential when another machine asks to use this one's GPU:
    owning the device is what grants access, and Tailscale is the one that can
    answer it. Cached, because it sits on the request path.
    """
    now = time.monotonic()
    with _whois_lock:
        hit = _whois_cache.get(ip)
        if hit and hit[1] > now:
            return hit[0]

    try:
        parsed = json.loads(_run(["whois", "--json", ip]))
        user_id = (parsed.get("Node") or {}).get("User")
    except (TailscaleUnavailable, ValueError, AttributeError):
        user_id = None

    with _whois_lock:
        _whois_cache[ip] = (user_id, now + WHOIS_TTL_SECONDS)
    return user_id


def reset_caches() -> None:
    """Test hook, and used after the sharing setting changes."""
    global _status_cache, _status_at
    with _status_lock:
        _status_cache, _status_at = None, 0.0
    with _whois_lock:
        _whois_cache.clear()
