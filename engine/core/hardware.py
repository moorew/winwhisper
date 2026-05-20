from __future__ import annotations

import platform
import sys
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class HardwareInfo:
    platform: str
    python_version: str
    cpu: str
    cuda_available: bool
    cuda_version: Optional[str]
    gpu_name: Optional[str]
    gpu_memory_gb: Optional[float]
    recommended_device: str         # "cuda" | "cpu"
    recommended_compute_type: str   # "float16" | "int8_float16" | "int8"
    supported_compute_types: List[str] = field(default_factory=list)


def _detect() -> HardwareInfo:
    cuda_available = False
    cuda_version: Optional[str] = None
    gpu_name: Optional[str] = None
    gpu_memory_gb: Optional[float] = None
    supported_types: List[str] = []

    try:
        import ctranslate2
        try:
            cuda_types = list(ctranslate2.get_supported_compute_types("cuda"))
            if cuda_types:
                cuda_available = True
                supported_types = cuda_types
        except Exception:
            pass

        if not cuda_available:
            try:
                supported_types = list(ctranslate2.get_supported_compute_types("cpu"))
            except Exception:
                supported_types = ["int8", "float32"]
    except Exception:
        supported_types = ["int8", "float32"]

    if cuda_available:
        try:
            import torch
            cuda_version = torch.version.cuda
            gpu_name = torch.cuda.get_device_name(0)
            mem = torch.cuda.get_device_properties(0).total_memory
            gpu_memory_gb = round(mem / (1024 ** 3), 1)
        except Exception:
            pass

    if cuda_available:
        if "float16" in supported_types:
            compute_type = "float16"
        elif "int8_float16" in supported_types:
            compute_type = "int8_float16"
        else:
            compute_type = "int8"
        device = "cuda"
    else:
        compute_type = "int8"
        device = "cpu"

    return HardwareInfo(
        platform=platform.system(),
        python_version=sys.version.split()[0],
        cpu=platform.processor() or platform.machine(),
        cuda_available=cuda_available,
        cuda_version=cuda_version,
        gpu_name=gpu_name,
        gpu_memory_gb=gpu_memory_gb,
        recommended_device=device,
        recommended_compute_type=compute_type,
        supported_compute_types=supported_types,
    )


_cached: Optional[HardwareInfo] = None


def get_hardware() -> HardwareInfo:
    global _cached
    if _cached is None:
        _cached = _detect()
    return _cached
