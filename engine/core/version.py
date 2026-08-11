"""
The single source of truth for the engine's version.

It used to be declared separately in main.py and api/routes_health.py, which
drifted apart — /health kept reporting a stale number long after the app had
moved on, and the Settings page (which displays it) was wrong for several
releases. Import it from here; do not redeclare it.

Keep this in step with package.json, src-tauri/Cargo.toml and
src-tauri/tauri.conf.json when cutting a release.
"""
from __future__ import annotations

APP_VERSION = "0.3.1"
