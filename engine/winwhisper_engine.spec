# -*- mode: python ; coding: utf-8 -*-
# Run from the engine/ directory:  pyinstaller winwhisper_engine.spec
#
# Produces a single-file EXE so Tauri can embed it as an external binary.
# The EXE self-extracts to a temp directory on first run (~2–4 s overhead
# on cold start, acceptable for a sidecar that runs for the app's lifetime).

block_cipher = None

from PyInstaller.utils.hooks import collect_dynamic_libs, collect_data_files

ct2_binaries = collect_dynamic_libs("ctranslate2")
ct2_datas    = collect_data_files("ctranslate2")
torch_datas  = collect_data_files("torch", includes=["**/*.dll"])
pyannote_datas    = collect_data_files("pyannote.audio")
asteroid_datas    = collect_data_files("asteroid_filterbanks", include_py_files=True)
speechbrain_datas = collect_data_files("speechbrain")

a = Analysis(
    ["main.py"],
    pathex=["."],
    binaries=ct2_binaries,
    datas=[
        ("api",     "api"),
        ("core",    "core"),
        ("features","features"),
        *ct2_datas,
        *torch_datas,
        *pyannote_datas,
        *asteroid_datas,
        *speechbrain_datas,
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
        "pyannote.audio", "pyannote.core", "pyannote.database", "pyannote.pipeline",
        "asteroid_filterbanks", "speechbrain",
        "torchaudio", "torchaudio.transforms", "torchaudio.functional",
        "huggingface_hub", "huggingface_hub.utils",
        "soundfile", "numpy",
        "watchdog.observers", "watchdog.observers.polling",
        "yt_dlp",
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

# Single-file EXE — all binaries and datas embedded
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    exclude_binaries=False,
    name="winwhisper_engine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=["vcruntime140.dll", "python3*.dll"],
    # console=True is required: Tauri reads WINWHISPER_PORT= from this stdout
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)
