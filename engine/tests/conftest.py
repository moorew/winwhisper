"""
Shared fixtures for the engine test suite.

`core.storage` resolves every path at import time, so the storage root has to be
redirected to a throwaway directory *before* any engine module is imported.
That is why the environment juggling below happens at module scope.
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

_TMP_ROOT = tempfile.mkdtemp(prefix="winwhisper-tests-")
os.environ["HOME"] = _TMP_ROOT
os.environ["USERPROFILE"] = _TMP_ROOT
os.environ["APPDATA"] = str(Path(_TMP_ROOT) / "AppData" / "Roaming")

# Allow `import main`, `import core...` when pytest is run from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from main import create_app  # noqa: E402


@pytest.fixture(scope="session")
def client():
    """
    A TestClient with the app's real lifespan (DB init + job worker) running.

    `client=` is set because the engine now checks who is calling: loopback is
    waved through, anything else has to prove it is one of your Tailscale
    devices. TestClient otherwise presents itself as the host "testclient",
    which is neither, so every request would be a 403. A real local request
    carries 127.0.0.1 — this makes the fixture look like one rather than
    carving a hole in the check for tests.
    """
    with TestClient(create_app(), client=("127.0.0.1", 51000)) as test_client:
        yield test_client


@pytest.fixture(scope="session", autouse=True)
def _cleanup_storage():
    yield
    shutil.rmtree(_TMP_ROOT, ignore_errors=True)
