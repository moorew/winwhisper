"""
Deciding who may drive this engine.

The engine has always bound loopback, so "who is calling" never needed asking.
Sharing a GPU with your other machines changes that: the engine now listens on a
tailnet address, and something has to distinguish your laptop from everything
else that can route to it.

Tailscale answers it. `tailscale whois` maps a source address to the tailnet
user who owns that machine, so the credential is simply *owning the device* —
nothing to configure, nothing to leak, nothing to rotate. Devices other people
share into your tailnet carry a different owner and are refused.
"""

from __future__ import annotations

from typing import Set

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from core import tailnet

LOOPBACK = {"127.0.0.1", "::1", "localhost"}

# Peers we have already turned away. Keeps a misconfigured device from writing a
# line per request, while still leaving a trace to find it by.
_refused_logged: Set[str] = set()


def _is_loopback(host: str) -> bool:
    return host in LOOPBACK or host.startswith("127.")


class TailnetOwnerOnly(BaseHTTPMiddleware):
    """
    Allows loopback unconditionally, and anything else only from a device
    belonging to the same tailnet user.

    Applied even when sharing is off. It costs a dictionary lookup for local
    requests, and it means a future change that exposes the port cannot quietly
    expose the data with it.
    """

    async def dispatch(self, request: Request, call_next):
        client = request.client.host if request.client else ""

        if _is_loopback(client):
            return await call_next(request)

        owner = await _owner_of(client)
        mine = await _my_user_id()

        if owner is not None and mine is not None and owner == mine:
            return await call_next(request)

        if client not in _refused_logged:
            _refused_logged.add(client)
            reason = (
                "it is not a Tailscale peer"
                if owner is None
                else "it belongs to a different Tailscale account"
            )
            print(
                f"[WinWhisper] refused a request from {client}: {reason}. "
                "Only your own devices may use this machine's engine.",
                flush=True,
            )

        return JSONResponse(
            status_code=403,
            content={
                "detail": (
                    "This engine only accepts requests from your own devices on "
                    "your Tailscale network."
                )
            },
        )


async def _owner_of(ip: str):
    import asyncio

    try:
        return await asyncio.to_thread(tailnet.whois_user_id, ip)
    except Exception:
        return None


async def _my_user_id():
    import asyncio

    try:
        return await asyncio.to_thread(tailnet.self_user_id)
    except Exception:
        return None
