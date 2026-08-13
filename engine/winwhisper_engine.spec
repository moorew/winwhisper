# -*- mode: python ; coding: utf-8 -*-
# Run from the engine/ directory:  pyinstaller winwhisper_engine.spec
#
# Produces a directory bundle — faster startup than --onefile, and avoids
# the 2 GB mmap limit in NSIS for large single-file EXEs.
# GPU acceleration for transcription is provided by CTranslate2 (bundled here);
# PyTorch only needs to be CPU-only since pyannote.audio runs fine on CPU.

block_cipher = None

from PyInstaller.utils.hooks import collect_dynamic_libs, collect_data_files

ct2_binaries  = collect_dynamic_libs("ctranslate2")
ct2_datas     = collect_data_files("ctranslate2")
torch_datas   = collect_data_files("torch")
pyannote_datas     = collect_data_files("pyannote.audio")
asteroid_datas     = collect_data_files("asteroid_filterbanks", include_py_files=True)
speechbrain_datas  = collect_data_files("speechbrain")

# faster-whisper ships the Silero VAD model as package data
# (faster_whisper/assets/silero_vad_v6.onnx). Listing faster_whisper as a
# hidden import pulls in its Python modules but NOT that file, so every
# transcription with vad_filter=True — the default — died at runtime with
# "NO_SUCHFILE: Load model ... silero_vad_v6.onnx failed".
fw_datas           = collect_data_files("faster_whisper")
# onnxruntime loads the VAD model and keeps its own data alongside the
# native extension; collect both so the VAD path is fully self-contained.
onnx_datas         = collect_data_files("onnxruntime")
onnx_binaries      = collect_dynamic_libs("onnxruntime")

# httpx talks to a WinWhisper engine on another of your machines. It builds an
# SSL context when a client is constructed, which needs certifi's cacert.pem —
# a data file, so nothing in the import graph pulls it in. Same shape of gap as
# the Silero VAD model, which shipped missing and broke every transcription.
certifi_datas      = collect_data_files("certifi")

a = Analysis(
    ["main.py"],
    pathex=["."],
    binaries=[*ct2_binaries, *onnx_binaries],
    datas=[
        ("api",      "api"),
        ("core",     "core"),
        ("features", "features"),
        *ct2_datas,
        *torch_datas,
        *pyannote_datas,
        *asteroid_datas,
        *speechbrain_datas,
        *fw_datas,
        *onnx_datas,
        *certifi_datas,
    ],
    hiddenimports=[
        "uvicorn.logging",
        "uvicorn.loops", "uvicorn.loops.auto", "uvicorn.loops.asyncio",
        "uvicorn.protocols", "uvicorn.protocols.http", "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl", "uvicorn.protocols.http.httptools_impl",
        "uvicorn.protocols.websockets", "uvicorn.protocols.websockets.auto",
        "uvicorn.protocols.websockets.websockets_impl",
        "uvicorn.lifespan", "uvicorn.lifespan.on", "uvicorn.lifespan.off",
        "aiosqlite",
        "sqlalchemy.dialects.sqlite", "sqlalchemy.dialects.sqlite.aiosqlite",
        "sqlalchemy.ext.asyncio",
        "faster_whisper", "ctranslate2", "tokenizers",
        "onnxruntime", "onnxruntime.capi", "onnxruntime.capi._pybind_state",
        "pyannote.audio", "pyannote.core", "pyannote.database", "pyannote.pipeline",
        "asteroid_filterbanks", "speechbrain",
        "torchaudio", "torchaudio.transforms", "torchaudio.functional",
        "huggingface_hub", "huggingface_hub.utils",
        "soundfile", "numpy",
        "watchdog.observers", "watchdog.observers.polling",
        "yt_dlp",
        # Imported at module scope by core/remote.py: if these are missed the
        # engine does not start at all, rather than losing one feature.
        "httpx", "httpcore", "h11", "certifi",
        "docx",
        "pydantic", "pydantic_core", "pydantic_settings",
        "sse_starlette", "sse_starlette.sse",
        "anyio", "anyio.abc", "anyio._backends._asyncio",
        "starlette", "starlette.middleware.cors",
        "keyboard", "pynput",
    ],
    hookspath=[],
    runtime_hooks=[],
    excludes=["matplotlib", "IPython", "notebook"],
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,   # directory mode — binaries collected separately
    name="winwhisper_engine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # console=True is required: Tauri reads WINWHISPER_PORT= from this stdout
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name="winwhisper_engine",
)
