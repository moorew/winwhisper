"""
Regression tests for GPU detection and the CPU fallback.

Both exist because of a real failure: CTranslate2's PyPI wheels are built with
CUDA support, so `get_supported_compute_types("cuda")` reports float16 even on
machines with no NVIDIA card. The engine trusted that, selected device="cuda",
and every transcription died with "Library cublas64_12.dll is not found".
"""
from __future__ import annotations

import core.hardware as hardware
from core.transcriber import _is_gpu_runtime_error


# ── Detection ────────────────────────────────────────────────────────────────

def _detect_with(monkeypatch, device_count, cuda_types=("float16", "int8")):
    """Runs _detect() against a stubbed ctranslate2."""
    class FakeCT2:
        @staticmethod
        def get_cuda_device_count():
            return device_count

        @staticmethod
        def get_supported_compute_types(device):
            return set(cuda_types) if device == "cuda" else {"int8", "float32"}

    monkeypatch.setitem(__import__("sys").modules, "ctranslate2", FakeCT2)
    return hardware._detect()


def test_no_gpu_falls_back_to_cpu_even_when_build_reports_cuda_types(monkeypatch):
    # The exact shape of the bug: a CUDA-capable *build* on a GPU-less machine.
    info = _detect_with(monkeypatch, device_count=0)
    assert info.recommended_device == "cpu"
    assert info.recommended_compute_type == "int8"
    assert info.cuda_available is False


def test_real_gpu_is_used_when_present(monkeypatch):
    info = _detect_with(monkeypatch, device_count=1)
    assert info.recommended_device == "cuda"
    assert info.recommended_compute_type == "float16"
    assert info.cuda_available is True


def test_gpu_without_float16_support_uses_a_supported_type(monkeypatch):
    info = _detect_with(monkeypatch, device_count=1, cuda_types=("int8_float16", "int8"))
    assert info.recommended_device == "cuda"
    assert info.recommended_compute_type == "int8_float16"


def test_detection_survives_a_ctranslate2_that_raises(monkeypatch):
    class ExplodingCT2:
        @staticmethod
        def get_cuda_device_count():
            raise RuntimeError("driver not loaded")

        @staticmethod
        def get_supported_compute_types(device):
            raise RuntimeError("nope")

    monkeypatch.setitem(__import__("sys").modules, "ctranslate2", ExplodingCT2)
    info = hardware._detect()
    assert info.recommended_device == "cpu"


# ── Error classification ─────────────────────────────────────────────────────

def test_gpu_runtime_errors_are_recognised():
    for message in (
        "Library libcublas.so.12 is not found or cannot be loaded",
        "Library cublas64_12.dll is not found",
        "cuDNN failed to initialize",
        "CUDA driver version is insufficient",
        "CUDA out of memory",
    ):
        assert _is_gpu_runtime_error(RuntimeError(message)), message


def test_ordinary_errors_are_not_treated_as_gpu_failures():
    for message in (
        "No such file or directory: audio.mp3",
        "Invalid audio format",
        "model.bin is corrupt",
    ):
        assert not _is_gpu_runtime_error(ValueError(message)), message
