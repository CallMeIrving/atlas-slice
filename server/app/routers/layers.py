"""图层拆分作业：提交、轮询、取消、取产物。

``run_pipeline`` / ``write_outputs`` 都在 runner 闭包内延迟导入——这两个模块拉起
numpy / cv2 / torch，放在模块级会让 ``import app.main`` 变慢，也让免权重的接口测试
不得不先装齐推理依赖。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, Response, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import ValidationError

from ..config import Settings
from ..deps import get_job_manager, get_model_manager, get_settings_dep
from ..errors import (
    ApiError,
    invalid_params,
    job_not_found,
    model_missing,
    payload_too_large,
    unsupported_media,
)
from ..models.registry import MODEL_FOR_KEY, ROLE_LABELS, model_by_id
from ..runtime.jobs import JobHandle, JobManager, JobRecord
from ..runtime.model_manager import ModelManager
from ..runtime.storage import safe_job_id, safe_layer_id
from ..schemas import DetectResultOut, JobStatusOut, LayerListOut, SplitAccepted, SplitParams

router = APIRouter(prefix="/layers", tags=["layers"])

"""背景层复用图层 PNG 的 URL 约定，物理文件是 job_dir/background.png"""
BACKGROUND_ID = "L0000"


def _parse_params(raw: str) -> SplitParams:
    try:
        return SplitParams.model_validate_json(raw)
    except ValidationError as exc:
        # 只带回简明定位信息：pydantic 的 ctx 里可能带异常对象，直接透传会序列化失败
        errors = [
            {"loc": list(item["loc"]), "msg": item["msg"], "type": item["type"]}
            for item in exc.errors()[:5]
        ]
        raise invalid_params("params 不是合法的参数 JSON", {"errors": errors}) from exc


def _assert_image(file: UploadFile) -> None:
    content_type = (file.content_type or "").lower()
    if content_type and not content_type.startswith("image/"):
        raise unsupported_media(f"只接受图片上传：{content_type}", {"content_type": content_type})


def _installed(models: ModelManager, key: str) -> bool:
    model = model_by_id(MODEL_FOR_KEY[key])
    return model is not None and models.is_installed(model)


def _assert_models_ready(spec: SplitParams, models: ModelManager) -> None:
    """提交前就把缺失的权重挡掉，用户拿到的是同步的 409 而不是作业里的失败。

    ``auto`` 只要任一检测器可用；两个都没有时报主检测器（GroundingDINO）的缺失，
    与 runner 的回落顺序一致。
    """
    keys: list[str] = []
    if spec.detector == "florence2":
        keys.append("detect:florence2")
    elif spec.detector == "grounding-dino":
        keys.append("detect")
    elif not (_installed(models, "detect") or _installed(models, "detect:florence2")):
        keys.append("detect")
    if spec.segmenter == "sam":
        keys.append("segment")

    for key in keys:
        model = model_by_id(MODEL_FOR_KEY[key])
        if model is None or models.is_installed(model):
            continue
        raise model_missing(model.repo_id, ROLE_LABELS.get(key, key), models.missing(model))


def _not_ready(record: JobRecord, what: str) -> ApiError:
    return ApiError(
        "JOB_NOT_FOUND",
        f"作业尚未产出{what}：{record.job_id}",
        404,
        {"job_id": record.job_id, "status": record.status},
    )


def _artifact(record: JobRecord, name: str) -> Path:
    if record.dir is None:
        raise job_not_found(record.job_id)
    path = record.dir / name
    if not path.exists():
        raise _not_ready(record, name)
    return path


def _manifest(record: JobRecord) -> dict:
    path = _artifact(record, "manifest.json")
    from ..pipeline.exporter import read_manifest  # noqa: PLC0415

    return read_manifest(path.parent)


def _png_response(data: bytes) -> Response:
    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": "private, max-age=3600"},
    )


@router.post("/split", response_model=SplitAccepted, status_code=status.HTTP_202_ACCEPTED)
async def start_split(
    file: UploadFile = File(..., description="待拆分的 UI 截图"),
    params: str = Form(..., description="SplitParams 的 JSON 字符串"),
    settings: Settings = Depends(get_settings_dep),
    models: ModelManager = Depends(get_model_manager),
    jobs: JobManager = Depends(get_job_manager),
) -> SplitAccepted:
    spec = _parse_params(params)
    _assert_image(file)
    payload = await file.read()
    if len(payload) > settings.max_upload_bytes:
        raise payload_too_large(settings.max_upload_bytes, len(payload))
    if not payload:
        raise invalid_params("上传内容为空")
    filename = Path(file.filename or "image.png").name
    _assert_models_ready(spec, models)

    def runner(handle: JobHandle) -> None:
        from ..pipeline.exporter import write_outputs  # noqa: PLC0415
        from ..pipeline.runner import run_pipeline  # noqa: PLC0415

        outcome = run_pipeline(
            job_id=handle.job_id,
            image_bytes=payload,
            filename=filename,
            params=spec,
            models=models,
            settings=settings,
            progress=handle.progress,
            check_cancel=handle.record.cancel.is_set,
        )
        for warning in outcome.warnings:
            handle.warn(warning)
        handle.set_image(outcome.image_info)
        handle.progress("export", 0.2, "正在写入图层产物…")
        manifest = write_outputs(
            job_dir=handle.dir,
            job_id=handle.job_id,
            source_rgb=outcome.source_rgb,
            image_info=outcome.image_info,
            layers=outcome.layers,
            background_rgba=outcome.background_rgba,
            background_mode=spec.background,
            warnings=list(outcome.warnings),
        )
        handle.set_layers(manifest["layers"], manifest["counts"])
        handle.set_background(manifest["background"])
        handle.set_urls(manifest["manifest_url"], manifest["zip_url"])
        handle.progress("export", 1.0, f"完成，共 {len(manifest['layers'])} 个图层")

    record = jobs.submit(kind="split", runner=runner, message="已排队")
    return SplitAccepted(**record.accepted())


@router.post("/detect", response_model=DetectResultOut)
async def start_detect(
    file: UploadFile = File(..., description="待检测的 UI 截图"),
    params: str = Form(..., description="SplitParams 的 JSON 字符串（只用 classes/detector/box_threshold/text_threshold/max_side）"),
    settings: Settings = Depends(get_settings_dep),
    models: ModelManager = Depends(get_model_manager),
) -> DetectResultOut:
    """仅检测不分割：返回框列表，供前端预检和编辑后提交拆分。"""
    spec = _parse_params(params)
    _assert_image(file)
    payload = await file.read()
    if len(payload) > settings.max_upload_bytes:
        raise payload_too_large(settings.max_upload_bytes, len(payload))
    if not payload:
        raise invalid_params("上传内容为空")
    # detect 端点只需要检测器，不需要 segmenter
    detect_keys: list[str] = []
    if spec.detector == "florence2":
        detect_keys.append("detect:florence2")
    elif spec.detector == "grounding-dino":
        detect_keys.append("detect")
    elif not (_installed(models, "detect") or _installed(models, "detect:florence2")):
        detect_keys.append("detect")
    for key in detect_keys:
        model = model_by_id(MODEL_FOR_KEY[key])
        if model is None or models.is_installed(model):
            continue
        raise model_missing(model.repo_id, ROLE_LABELS.get(key, key), models.missing(model))

    from ..pipeline.runner import detect_only  # noqa: PLC0415

    result = detect_only(
        image_bytes=payload,
        params=spec,
        models=models,
        settings=settings,
    )
    return DetectResultOut(**result)


@router.get("/jobs/{job_id}", response_model=JobStatusOut)
def get_job(
    job_id: str,
    jobs: JobManager = Depends(get_job_manager),
) -> JobStatusOut:
    record = jobs.get(safe_job_id(job_id))
    return JobStatusOut(**record.to_dict())


@router.delete("/jobs/{job_id}")
def cancel_job(
    job_id: str,
    jobs: JobManager = Depends(get_job_manager),
) -> dict[str, str]:
    """协作式取消：只置标志，真正的停止发生在管线的阶段与元素边界。"""
    record = jobs.cancel(safe_job_id(job_id))
    state = "cancelling" if record.status in ("queued", "running") else record.status
    return {"job_id": record.job_id, "status": state}


@router.get("/jobs/{job_id}/layers", response_model=LayerListOut)
def list_layers(
    job_id: str,
    jobs: JobManager = Depends(get_job_manager),
) -> LayerListOut:
    """按 z 升序（从后到前）返回图层清单。"""
    record = jobs.get(safe_job_id(job_id))
    manifest = _manifest(record)
    return LayerListOut(
        job_id=record.job_id,
        source=manifest["source"],
        layers=manifest["layers"],
        background=manifest.get("background"),
        counts=manifest.get("counts", {}),
        warnings=manifest.get("warnings", []),
        manifest_url=manifest["manifest_url"],
        zip_url=manifest["zip_url"],
    )


@router.get("/jobs/{job_id}/layers/{layer_id}.png")
def get_layer_png(
    job_id: str,
    layer_id: str,
    canvas: str = "crop",
    jobs: JobManager = Depends(get_job_manager),
) -> Response:
    """默认返回按 alpha_bbox 裁切的 RGBA 小图；``?canvas=full`` 补成原图尺寸。"""
    record = jobs.get(safe_job_id(job_id))
    target = safe_layer_id(layer_id)
    if record.dir is None:
        raise job_not_found(record.job_id)

    if target == BACKGROUND_ID:
        return _png_response(_artifact(record, "background.png").read_bytes())

    from ..pipeline.exporter import render_layer_png  # noqa: PLC0415

    image = record.image or {}
    size = (int(image.get("width") or 1), int(image.get("height") or 1))
    try:
        data = render_layer_png(record.dir, target, size, canvas == "full")
    except FileNotFoundError as exc:
        raise _not_ready(record, f"图层 PNG：{target}") from exc
    return _png_response(data)


@router.get("/jobs/{job_id}/manifest.json")
def get_manifest(
    job_id: str,
    jobs: JobManager = Depends(get_job_manager),
) -> FileResponse:
    record = jobs.get(safe_job_id(job_id))
    return FileResponse(_artifact(record, "manifest.json"), media_type="application/json")


@router.get("/jobs/{job_id}/bundle.zip")
def get_bundle(
    job_id: str,
    jobs: JobManager = Depends(get_job_manager),
) -> FileResponse:
    record = jobs.get(safe_job_id(job_id))
    return FileResponse(
        _artifact(record, "bundle.zip"),
        media_type="application/zip",
        filename=f"{record.job_id}-layers.zip",
    )