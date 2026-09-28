"""模型清单、权重下载与显式加载。

下载复用作业系统（单 worker 串行），前端用同一套轮询逻辑看进度。
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, status

from ..config import Settings
from ..deps import get_job_manager, get_model_manager, get_settings_dep
from ..models.download import DEFAULT_HOST, download_repo, resolve_targets
from ..runtime.jobs import JobHandle, JobManager
from ..runtime.model_manager import ModelManager
from ..schemas import (
    ModelDownloadRequest,
    ModelListOut,
    ModelLoadOut,
    ModelLoadRequest,
    SplitAccepted,
)

router = APIRouter(prefix="/models", tags=["models"])

DOWNLOAD_COMMAND = "cd server && .venv/bin/python scripts/download_models.py"


@router.get("", response_model=ModelListOut)
def list_models(
    models: ModelManager = Depends(get_model_manager),
) -> ModelListOut:
    return ModelListOut(
        models_dir=str(models.models_dir),
        models=models.status(),
        download_command=f"{DOWNLOAD_COMMAND} --host={DEFAULT_HOST}",
    )


@router.post("/download", response_model=SplitAccepted, status_code=status.HTTP_202_ACCEPTED)
def start_download(
    payload: ModelDownloadRequest,
    settings: Settings = Depends(get_settings_dep),
    jobs: JobManager = Depends(get_job_manager),
) -> SplitAccepted:
    targets = resolve_targets(payload.repo)
    host = payload.host
    label = "、".join(model.label for model in targets)

    def runner(handle: JobHandle) -> None:
        total = len(targets)
        for index, model in enumerate(targets):
            handle.progress("download", index / total, f"正在下载 {model.label}…")

            def report(fraction: float, message: str, index: int = index) -> None:
                handle.progress("download", (index + fraction) / total, message)

            _, warning = download_repo(
                model,
                models_dir=settings.models_dir,
                host=host,
                progress=report,
            )
            if warning:
                handle.warn(warning)
        handle.progress("download", 1.0, "权重下载完成")

    record = jobs.submit(kind="download", runner=runner, message=f"已排队：{label}")
    return SplitAccepted(**record.accepted())


@router.post("/load", response_model=ModelLoadOut)
def load_model(
    payload: ModelLoadRequest,
    models: ModelManager = Depends(get_model_manager),
) -> ModelLoadOut:
    """预热：把权重读进内存并落定设备，避免首次拆分等 20-40 秒。"""
    _, load_ms = models.load(payload.role)
    return ModelLoadOut(role=payload.role, loaded=True, load_ms=load_ms)


@router.post("/unload", response_model=ModelLoadOut)
def unload_model(
    payload: ModelLoadRequest,
    models: ModelManager = Depends(get_model_manager),
) -> ModelLoadOut:
    models.unload(payload.role)
    return ModelLoadOut(role=payload.role, loaded=False, load_ms=0)