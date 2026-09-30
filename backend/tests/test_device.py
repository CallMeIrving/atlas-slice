"""设备与精度：auto 探测、非法值、OOM 识别、MPS 回落开关。"""

from __future__ import annotations

import os

import pytest

from app.errors import ApiError
from app.runtime.device import (
    MPS_FALLBACK_ENV,
    available_devices,
    device_report,
    empty_cache,
    enable_mps_fallback,
    is_out_of_memory,
    resolve_device,
    resolve_dtype,
    synchronize,
    torch_module,
    try_import_torch,
)

torch = pytest.importorskip("torch", reason="设备用例需要 torch")


def test_cpu_is_always_available():
    assert available_devices()[-1] == "cpu"
    assert "cpu" in available_devices()


def test_resolve_device_explicit_cpu():
    assert str(resolve_device("cpu")) == "cpu"
    assert str(resolve_device("CPU")) == "cpu"


def test_resolve_device_auto_picks_first_available():
    assert str(resolve_device("auto")) == available_devices()[0]


def test_resolve_device_rejects_unknown_value():
    with pytest.raises(ApiError) as excinfo:
        resolve_device("tpu")
    assert excinfo.value.code == "DEVICE_INVALID"
    assert excinfo.value.status_code == 400


def test_resolve_device_rejects_unavailable_backend():
    if "cuda" in available_devices():
        pytest.skip("本机有 CUDA，无法测试不可用分支")
    with pytest.raises(ApiError) as excinfo:
        resolve_device("cuda")
    assert excinfo.value.code == "DEVICE_INVALID"


def test_dtype_is_always_float32():
    assert resolve_dtype(resolve_device("cpu")) is torch.float32


def test_enable_mps_fallback_sets_env(monkeypatch):
    monkeypatch.delenv(MPS_FALLBACK_ENV, raising=False)
    enable_mps_fallback()
    assert os.environ[MPS_FALLBACK_ENV] == "1"


def test_empty_cache_and_synchronize_are_safe_on_cpu():
    empty_cache(resolve_device("cpu"))
    synchronize(resolve_device("cpu"))


def test_out_of_memory_detection():
    assert is_out_of_memory(RuntimeError("MPS backend out of memory (1.0 GB)"))
    assert is_out_of_memory(RuntimeError("CUDA out of memory. Tried to allocate"))
    assert is_out_of_memory(RuntimeError("Cannot allocate memory"))
    assert not is_out_of_memory(RuntimeError("shape mismatch"))


def test_device_report_shape():
    report = device_report("mps", "mps")
    assert report["override"] == "mps"
    assert report["selected"] == "mps"
    assert report["dtype"] == "float32"
    assert isinstance(report["available"], list)
    assert isinstance(report["mps_fallback_env"], bool)


def test_torch_module_is_importable():
    assert try_import_torch() is not None
    assert torch_module() is torch