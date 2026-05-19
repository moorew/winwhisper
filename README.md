# WinWhisper

A free, open-source transcription app for Windows — powered by [OpenAI Whisper](https://github.com/openai/whisper).

![WinWhisper screenshot placeholder](https://placehold.co/900x500/1e1e2e/cdd6f4?text=WinWhisper)

## Why this exists

[MacWhisper](https://goodsnooze.gumroad.com/l/macwhisper) is a great native Whisper app — but it's macOS only. Windows users have been stuck with browser tools, Python scripts, or paid cloud services. WinWhisper fills that gap: a proper native desktop app, local processing, no subscription, no data leaving your machine.

If you're on macOS, go buy MacWhisper — Jordi has done fantastic work and deserves the support. WinWhisper exists solely because there wasn't a Windows equivalent, not to compete with or copy from his app.

---

## Features

- **Local-only** — audio never leaves your machine
- **GPU-accelerated** — NVIDIA CUDA supported out of the box, falls back to CPU
- **All Whisper model sizes** — tiny to large-v3, download in-app
- **Speaker diarization** — who said what, powered by pyannote.audio
- **YouTube transcription** — paste a URL, get a transcript
- **System audio capture** — record what's playing (WASAPI loopback)
- **Watch folder** — drop files into a folder, they auto-transcribe
- **Global dictation hotkey** — hold a key to record, release to type
- **Export** — TXT, SRT, VTT, JSON
- **Dark/light mode**

## Installation

Download `WinWhisper-vX.X.X-setup.exe` from the [Releases](https://github.com/moorew/winwhisper/releases) page and run the installer.

> **SmartScreen warning:** Windows will warn about an unknown publisher on first run. Click **More info → Run anyway**. This is expected for unsigned open-source software.

### Requirements
- Windows 10 / 11 (x64)
- 4 GB RAM minimum; 8 GB+ recommended for medium/large models
- NVIDIA GPU with CUDA 12.1+ for GPU acceleration (CPU fallback works without a GPU)

### First run
1. Open WinWhisper — the transcription engine starts automatically
2. Go to **Models** and download a model (`base` is a good starting point)
3. Drag an audio or video file onto the dashboard, or paste a YouTube URL

---

## Building from source

### Prerequisites

| Tool | Version |
|------|---------|
| Python | 3.11 |
| Node.js | 20+ |
| Rust | stable |
| Tauri CLI | v2 |

### 1. Build the Python engine

```bash
cd engine
pip install -r requirements.txt
pip install pyinstaller
pyinstaller winwhisper_engine.spec
```

This produces `engine/dist/winwhisper_engine.exe`.

### 2. Stage the sidecar

```bash
mkdir -p src-tauri/binaries
copy engine\dist\winwhisper_engine.exe src-tauri\binaries\winwhisper_engine-x86_64-pc-windows-msvc.exe
```

### 3. Build the Tauri app

```bash
npm install
npm run tauri:build
```

The installer is output to `src-tauri/target/release/bundle/nsis/`.

### Dev mode (without sidecar)

Set `VITE_ENGINE_URL=http://127.0.0.1:49200` and run the engine manually:

```bash
# Terminal 1
cd engine && python main.py

# Terminal 2
npm run dev
```

---

## Architecture

```
winwhisper/
├── engine/                  # Python sidecar (FastAPI + uvicorn)
│   ├── core/                # Database, transcriber, diarizer, model manager
│   ├── api/                 # REST API routes
│   └── features/            # Audio capture, dictation, watch folder, YouTube
├── src/                     # React 18 frontend
│   ├── pages/               # Dashboard, Editor, Models, Settings
│   └── components/          # Layout, UI primitives
└── src-tauri/               # Tauri 2 shell (Rust)
    └── src/lib.rs           # Sidecar lifecycle, system tray
```

The Tauri shell spawns the Python engine as a sidecar, reads the port it announces on stdout (`WINWHISPER_PORT=XXXXX`), waits for the TCP port to accept connections, then shows the window. The React frontend calls the engine over localhost HTTP.

---

## Technology

| Layer | Stack |
|-------|-------|
| Shell | [Tauri 2](https://tauri.app) (Rust) |
| Frontend | React 18 + Vite + TailwindCSS |
| Engine | FastAPI + uvicorn (Python) |
| Transcription | [faster-whisper](https://github.com/SYSTRAN/faster-whisper) + [CTranslate2](https://github.com/OpenNMT/CTranslate2) |
| Diarization | [pyannote.audio](https://github.com/pyannote/pyannote-audio) |
| Audio | PyAudioWPatch (WASAPI loopback) |
| YouTube | yt-dlp |

---

## Credits

- [OpenAI Whisper](https://github.com/openai/whisper) — the speech recognition model (MIT licence)
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — optimised CTranslate2 inference
- [pyannote.audio](https://github.com/pyannote/pyannote-audio) — speaker diarization
- [Tauri](https://tauri.app) — the native shell framework
- [MacWhisper](https://goodsnooze.gumroad.com/l/macwhisper) by Jordi Bruin — the inspiration for building a proper native Whisper desktop experience (go check it out if you're on Mac)

---

## Contributing

PRs and issues welcome. This is early-stage software — there's plenty to improve.

A few areas that would make good first contributions:
- Waveform playback in the transcript editor
- Microphone recording from the dashboard
- Batch export of multiple transcripts
- Auto-update support

## Licence

MIT — see [LICENSE](LICENSE).
