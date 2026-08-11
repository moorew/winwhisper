"""
Guards against version drift.

The version used to be declared twice in Python and again in three packaging
files. They fell out of step: /health reported a stale number for several
releases and the Settings page showed "0.1.1" long after 0.2.x shipped.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from core.version import APP_VERSION

REPO_ROOT = Path(__file__).resolve().parents[2]


def test_version_is_declared_once_in_python():
    declarations = []
    for path in (REPO_ROOT / "engine").rglob("*.py"):
        if "tests" in path.parts:
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if re.match(r"\s*APP_VERSION\s*=\s*[\"']", line):
                # as_posix() so the comparison holds on Windows too.
                declarations.append(
                    f"{path.relative_to(REPO_ROOT).as_posix()}: {line.strip()}"
                )
    assert declarations == [f"engine/core/version.py: APP_VERSION = \"{APP_VERSION}\""], (
        f"APP_VERSION must be declared only in core/version.py, found: {declarations}"
    )


def test_health_endpoint_reports_the_shared_version(client):
    assert client.get("/health").json()["version"] == APP_VERSION
    assert client.get("/status").json()["version"] == APP_VERSION


def test_packaging_files_agree_with_the_engine():
    package_json = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
    assert package_json["version"] == APP_VERSION, "package.json is out of step"

    tauri_conf = json.loads(
        (REPO_ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
    )
    assert tauri_conf["version"] == APP_VERSION, "tauri.conf.json is out of step"

    cargo = (REPO_ROOT / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8")
    cargo_version = re.search(r'^version\s*=\s*"([^"]+)"', cargo, re.MULTILINE).group(1)
    assert cargo_version == APP_VERSION, "Cargo.toml is out of step"
