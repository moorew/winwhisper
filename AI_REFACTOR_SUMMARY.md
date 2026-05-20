# AI Refactor Summary

## Modified Files

- `engine/api/routes_models.py`
- `engine/core/database.py`
- `engine/core/diarizer.py`
- `engine/core/hardware.py`
- `engine/core/model_manager.py`
- `engine/core/transcriber.py`
- `engine/features/audio_capture.py`
- `engine/features/dictation.py`
- `engine/features/watch_folder.py`
- `engine/main.py`
- `.github/workflows/release.yml`
- `package-lock.json`
- `package.json`
- `src-tauri/src/lib.rs`
- `src-tauri/tauri.conf.json`
- `src/App.tsx`
- `src/components/Onboarding.tsx`
- `src/pages/Models.tsx`
- `src/pages/Settings.tsx`
- `README.md`
- `AI_REFACTOR_SUMMARY.md`

## Engine Initialization Root Cause

The engine was dying during FastAPI startup because SQLAlchemy could not configure the relationship between `jobs` and `transcripts`. Both tables pointed at each other (`jobs.transcript_id -> transcripts.id` and `transcripts.job_id -> jobs.id`), but the ORM relationships did not specify which foreign key to use. That raised `AmbiguousForeignKeysError` during mapper configuration, aborting the lifespan startup after the engine announced a port.

The startup path also had secondary fragility:

- Heavy optional packages such as `faster_whisper`, `pyannote.audio`, audio libraries, keyboard hooks, and `huggingface_hub` were imported during route/module import, so missing or broken optional dependencies could prevent `/health` and `/models` from ever serving.
- The Tauri shell only looked for one packaged Windows executable path and did not attach to an already running engine or fall back to the Python source engine in dev.
- The bundle config and README described incompatible engine staging locations.

## Engine Initialization Fix

- Made `Job.transcript` and `Transcript.job` use explicit `foreign_keys` in `engine/core/database.py`.
- Added a lightweight SQLite migration pass for old `downloaded_models` schemas before settings are seeded.
- Moved heavy model, diarization, audio, keyboard, and HuggingFace imports to lazy feature-use paths or broad optional import guards.
- Made stale job recovery and watch-folder restore non-fatal during startup.
- Refactored Tauri engine startup to:
  - attach to an existing engine via the stored `engine.port` file when healthy;
  - search packaged resource, dist, legacy binary, and source-dev locations;
  - launch `engine/main.py` in dev when no packaged executable exists;
  - wait for `/health` before emitting `engine-ready`;
  - keep draining stdout/stderr so the child process cannot block on pipes.
- Updated Tauri resources to bundle `engine/dist/winwhisper_engine/` directly.
- Added browser/dev fallback readiness in `src/App.tsx` by probing `/health` when Tauri commands are unavailable.
- Bumped release metadata to `0.1.1` and aligned the release workflow with the direct PyInstaller directory resource path.

## Model Download Logic Fix

The model UI dropped download progress because the backend only inserted active download state after the HuggingFace repo-size request completed. The frontend opened the SSE stream immediately after `POST /models/{name}/download`; if the metadata request was still running, `/download/progress` saw no state, returned `not_started`, and closed the stream.

The fix:

- `model_manager.launch_download()` now creates and stores `DownloadState(status="downloading")` synchronously before scheduling any network work.
- `_run_download()` receives that existing state and updates `total_bytes` after the HuggingFace metadata lookup returns.
- The Models page and onboarding modal optimistically mark the selected model as downloading immediately after the user clicks Download.
- `/models` now still returns the static catalog if local downloaded-model metadata or active-model settings are temporarily unreadable, so the UI continues to offer downloadable models.
- `huggingface_hub` is lazy-loaded, so catalog listing does not depend on download-specific package import success.

## Verification

- `npm run build` passes.
- `python3 -m py_compile $(rg --files engine -g '*.py')` passes.
- `src-tauri/tauri.conf.json` validates as JSON.
- Temporary venv smoke test starts `engine/main.py`, returns `GET /health`, and returns the full `GET /models` catalog.
- Migration smoke test upgrades an old `downloaded_models` table and preserves a downloaded `base` row.
- Download-state smoke test confirms `launch_download()` exposes `downloading` immediately.

`cargo check --manifest-path src-tauri/Cargo.toml` could not be run in this container because `cargo`/`rustc` are not installed.
