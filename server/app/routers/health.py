"""健康检查与系统信息。

这两个接口**不触达 torch**（设备探测失败时优雅降级），因此可以用来判断
「服务是否起着」而不必等模型权重就位。
"""

from __future__ import annotations

import platform as platform_module
import sys
import time
from importlib.metadata import PackageNotFoundError, version

from fastapi import APIRouter, Depends, Request

from ..config import Settings
from ..deps import get_job_manager, get_model_manager, get_settings_dep
from ..runtime.device import device_report
from ..runtime.jobs import JobManager
from ..runtime.model_manager import ModelManager
from ..schemas import DeviceOut, HealthOut, LimitsOut, SystemOut

router = APIRouter(tags=["system"])


def _package_version(name: str) -> str:
    try:
        return version(name)
    except PackageNotFoundError:
        return "未安装"


def _selected_device(models: ModelManager) -> str:
    try:
        return str(models.device())
    except Exception:  # torch 缺失或设备非法：状态接口不因此失败
        return "unavailable"


@router.get("/health", response_model=HealthOut)
def health(
    request: Request,
    models: ModelManager = Depends(get_model_manager),
    jobs: JobManager = Depends(get_job_manager),
) -> HealthOut:
    started_at = getattr(request.app.state, "started_at", None) or time.time()
    return HealthOut(
        uptime_s=round(time.time() - started_at, 3),
        device=_selected_device(models),
        models_ready=models.models_ready(),
        queue_depth=jobs.queue_depth(),
    )


@router.get("/system", response_model=SystemOut)
def system(
    settings: Settings = Depends(get_settings_dep),
    models: ModelManager = Depends(get_model_manager),
) -> SystemOut:
    report = device_report(settings.device, _selected_device(models))
    return SystemOut(
        python=sys.version.split()[0],
        torch=_package_version("torch"),
        transformers=_package_version("transformers"),
        platform=f"{platform_module.system()} {platform_module.machine()}",
        device=DeviceOut(
            selected=report["selected"],
            available=report["available"],
            override=report["override"],
            dtype=report["dtype"],
            mps_fallback_env=report["mps_fallback_env"],
        ),
        limits=LimitsOut(
            max_upload_bytes=settings.max_upload_bytes,
            max_side=settings.max_side_hard,
            max_layers=settings.max_layers_hard,
            max_queue=settings.max_queue,
        ),
    )