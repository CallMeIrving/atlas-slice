"""设备与精度选择。

torch 体积大、导入慢，因此这里全部懒加载：只在真正需要推理或上报设备信息时才 import，
保证 ``uvicorn app.main:app`` 的启动时间不受影响，也让不依赖 torch 的接口测试可以先跑起来。

硬约束：**MPS 一律 fp32**。fp16 在 MPS 的部分 attention / sdpa 算子上会出 NaN 或直接不支持，
与其给一个「看起来更快但结果全黑」的开关，不如不提供。
"""

from __future__ import annotations

import os
from typing import Any

from ..errors import device_invalid

VALID_DEVICES = ("auto", "cuda", "mps", "cpu")
"""MPS 缺失算子时回落到 CPU，而不是抛 NotImplementedError"""
MPS_FALLBACK_ENV = "PYTORCH_ENABLE_MPS_FALLBACK"


def enable_mps_fallback() -> None:
    os.environ.setdefault(MPS_FALLBACK_ENV, "1")


def try_import_torch() -> Any | None:
    """torch 不可用时返回 None，供状态上报使用（不抛异常）。"""
    try:
        import torch  # noqa: PLC0415
    except Exception:  # pragma: no cover - 依赖缺失时的兜底
        return None
    return torch


def torch_module() -> Any:
    torch = try_import_torch()
    if torch is None:
        from ..errors import ApiError

        raise ApiError("INTERNAL", "PyTorch 不可用，请先安装 requirements.txt", 500)
    return torch


def _mps_available(torch: Any) -> bool:
    backend = getattr(torch.backends, "mps", None)
    return bool(backend is not None and backend.is_available())


def available_devices() -> list[str]:
    """按优先级返回可用设备（cuda > mps > cpu）。"""
    result: list[str] = []
    torch = try_import_torch()
    if torch is not None:
        if torch.cuda.is_available():
            result.append("cuda")
        if _mps_available(torch):
            result.append("mps")
    result.append("cpu")
    return result


def resolve_device(pref: str | None = None) -> Any:
    """把配置值解析成 ``torch.device``；auto 按 cuda > mps > cpu 探测。"""
    torch = torch_module()
    value = (pref or "auto").strip().lower()
    if value not in VALID_DEVICES:
        raise device_invalid(f"未知推理设备：{pref}", {"valid": list(VALID_DEVICES)})
    devices = available_devices()
    if value == "auto":
        return torch.device(devices[0])
    if value not in devices:
        raise device_invalid(f"设备不可用：{value}", {"available": devices, "override": value})
    return torch.device(value)


def resolve_dtype(device: Any | None = None) -> Any:
    """恒返回 float32（含 MPS）。"""
    return torch_module().float32


def empty_cache(device: Any | None = None) -> None:
    """归还推理期间产生的缓存，避免连续任务把峰值内存叠加起来。"""
    torch = try_import_torch()
    if torch is None:
        return
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    backend = getattr(torch.backends, "mps", None)
    if backend is not None and backend.is_available() and hasattr(torch, "mps"):
        torch.mps.empty_cache()


def synchronize(device: Any | None = None) -> None:
    """计时前同步——MPS 没有 cuda.synchronize，用 torch.mps.synchronize。"""
    torch = try_import_torch()
    if torch is None:
        return
    if torch.cuda.is_available():
        torch.cuda.synchronize()
    backend = getattr(torch.backends, "mps", None)
    if backend is not None and backend.is_available() and hasattr(torch, "mps"):
        torch.mps.synchronize()


def is_out_of_memory(exc: BaseException) -> bool:
    """识别 CUDA / MPS / CPU 的 OOM 报错文本。"""
    text = str(exc).lower()
    return (
        "out of memory" in text
        or "mps backend out of memory" in text
        or "cannot allocate memory" in text
    )


def device_report(override: str = "auto", selected: str | None = None) -> dict[str, Any]:
    torch = try_import_torch()
    return {
        "selected": selected or "",
        "available": available_devices(),
        "override": (override or "auto").lower(),
        "dtype": "float32",
        "mps_fallback_env": os.environ.get(MPS_FALLBACK_ENV) == "1",
        "torch_available": torch is not None,
    }