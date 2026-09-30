#!/usr/bin/env python3
"""环境自检：解释器 / torch / MPS / 权重就位 / 磁盘余量。

在报「跑不通」之前先跑这个，能把「没装依赖」「设备选错」「权重缺文件」
「磁盘满了」这几类问题一次性区分开。
"""

from __future__ import annotations

import os
import platform
import shutil
import sys
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import APP_VERSION  # noqa: E402
from app.config import Settings  # noqa: E402
from app.runtime.device import (  # noqa: E402
    MPS_FALLBACK_ENV,
    available_devices,
    resolve_device,
    resolve_dtype,
    try_import_torch,
)
from app.runtime.model_manager import ModelManager  # noqa: E402


def package_version(name: str) -> str:
    try:
        return version(name)
    except PackageNotFoundError:
        return "未安装"


def format_bytes(value: int) -> str:
    if value >= 1024**3:
        return f"{value / 1024**3:.1f}GB"
    if value >= 1024**2:
        return f"{value / 1024**2:.1f}MB"
    return f"{value}B"


def main() -> int:
    settings = Settings()
    models = ModelManager(settings)
    torch = try_import_torch()

    print(f"图层拆分服务 v{APP_VERSION}")
    print(f"解释器：Python {sys.version.split()[0]}  ({platform.system()} {platform.machine()})")
    print(f"依赖：torch {package_version('torch')} / torchvision {package_version('torchvision')}"
          f" / transformers {package_version('transformers')}")
    print()

    print("推理设备")
    if torch is None:
        print("  ✗ 无法 import torch：venv 没建好或依赖没装 → make install")
    else:
        backend = getattr(torch.backends, "mps", None)
        mps_ok = bool(backend is not None and backend.is_available())
        fallback = os.environ.get(MPS_FALLBACK_ENV) == "1"
        print(f"  可用设备：{'、'.join(available_devices())}")
        print(f"  MPS 可用：{mps_ok}")
        print(f"  {MPS_FALLBACK_ENV}：{'已设置' if fallback else '未设置（服务启动时会自动设置）'}")
        print(f"  配置 device：{settings.device}")
        try:
            resolved = resolve_device(settings.device)
            print(f"  实际解析为：{resolved}  dtype={resolve_dtype(resolved)}")
        except Exception as exc:
            print(f"  ✗ 设备不可用：{exc}")
    print()

    print("权重")
    print(f"  目录：{settings.models_dir}")
    for row in models.status():
        state = "就位" if row["installed"] else "缺失"
        print(f"  [{state}] {row['role']:<8} {row['id']:<20} {format_bytes(row['approx_bytes'])}")
        for name in row["missing"]:
            print(f"            - 缺少 {name}")
    print(f"  主流程（detect + segment）就绪：{models.models_ready()}")
    if not models.models_ready():
        print("  → 下载：python scripts/download_models.py --host=https://hf-mirror.com")
    print()

    print("磁盘")
    for label, path in (("权重", settings.models_dir), ("临时产物", settings.tmp_dir)):
        target = path if path.exists() else path.parent
        usage = shutil.disk_usage(target)
        print(f"  {label}：{path}  可用 {format_bytes(usage.free)} / 共 {format_bytes(usage.total)}")
    print()

    if torch is None:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())