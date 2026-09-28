"""管线编排：detect → ocr → segment → refine → zorder → background。

不依赖 HTTP，可以直接用 ``python -m app.pipeline.runner --image xxx.png`` 单跑，
方便在接前端之前先把模型调通。
"""

from __future__ import annotations

import argparse
import io
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import cv2
import numpy as np
from PIL import Image

from ..config import Settings
from ..errors import bad_image
from ..models.registry import model_by_role
from ..runtime.jobs import JobCancelled
from ..runtime.model_manager import ModelManager
from .backends import Candidate, Detection, TextRegion, box_intersection, clamp_box, scale_box
from .background import build_background
from .mask_refine import alpha_bbox, refine_mask
from .text_alpha import text_alpha, threshold_from_text_threshold
from .zorder import order_layers

ProgressFn = Callable[[str, float, str], None]
CancelFn = Callable[[], bool]


@dataclass
class PipelineOutcome:
    source_rgb: np.ndarray
    image_info: dict[str, Any]
    layers: list[Candidate] = field(default_factory=list)
    background_rgba: np.ndarray | None = None
    warnings: list[str] = field(default_factory=list)


def decode_image(data: bytes) -> Image.Image:
    """解码上传的图片。统一转 RGB——OpenCV 不接受 4 通道输入。"""
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as exc:  # PIL 的异常类型很杂，这里统一收敛
        raise bad_image(f"无法解析图片：{exc}") from exc
    try:
        return image.convert("RGB")
    except Exception as exc:  # pragma: no cover
        raise bad_image(f"不支持的图片格式：{exc}") from exc


def _noop_progress(stage: str, fraction: float, message: str = "") -> None:
    return None


def _never_cancel() -> bool:
    return False


def _check(check_cancel: CancelFn) -> None:
    if check_cancel():
        raise JobCancelled()


def _quad_bbox(quad: list[tuple[int, int]]) -> tuple[int, int, int, int]:
    xs = [point[0] for point in quad]
    ys = [point[1] for point in quad]
    return min(xs), min(ys), max(xs), max(ys)


def _best_text_region(box: tuple[int, int, int, int], regions: list[TextRegion]) -> TextRegion | None:
    best: TextRegion | None = None
    best_overlap = 0
    for region in regions:
        overlap = box_intersection(box, _quad_bbox(region.quad))
        if overlap > best_overlap:
            best, best_overlap = region, overlap
    return best if best is not None else None


def _resolve_detector_key(choice: str, models: ModelManager, warnings: list[str]) -> str:
    """把 UI 的 detector 选项解析成内部角色键。

    ``auto`` 只在 GroundingDINO 未安装、而 Florence-2 就位时才回退——回退会显式写进 warnings，
    不会悄悄换模型。
    """
    if choice == "florence2":
        return "detect:florence2"
    if choice != "auto":
        return "detect"
    primary = model_by_role("detect")
    if primary is not None and models.is_installed(primary):
        return "detect"
    fallback = model_by_role("ocr")
    if fallback is not None and models.is_installed(fallback):
        warnings.append("未安装 GroundingDINO 权重，auto 已回退到 Florence-2 检测。")
        return "detect:florence2"
    # 两个都没有：走默认路径，让 require 抛出的 MODEL_MISSING 指向更常见的那个仓库
    return "detect"


def run_pipeline(
    *,
    job_id: str,
    image_bytes: bytes,
    filename: str,
    params: Any,
    models: ModelManager,
    settings: Settings,
    progress: ProgressFn | None = None,
    check_cancel: CancelFn | None = None,
) -> PipelineOutcome:
    report = progress or _noop_progress
    cancelled = check_cancel or _never_cancel
    warnings: list[str] = []

    report("detect", 0.02, "正在解析图片…")
    image = decode_image(image_bytes)
    width, height = image.size
    if max(width, height) > settings.max_side_hard:
        raise bad_image(
            f"图片过大：{width}×{height}，硬上限为 {settings.max_side_hard}px",
            {"width": width, "height": height, "max_side": settings.max_side_hard},
        )

    max_layers = min(int(params.max_layers), settings.max_layers_hard)
    max_side = min(int(params.max_side), settings.max_side_hard)
    scale = min(1.0, max_side / max(width, height))
    work = image if scale >= 1.0 else image.resize(
        (max(1, round(width * scale)), max(1, round(height * scale))), Image.LANCZOS
    )
    work_rgb = np.asarray(work, dtype=np.uint8)
    _check(cancelled)

    # ---------- detect ----------
    classes = [spec.model_dump() for spec in params.classes]
    detect_key = _resolve_detector_key(params.detector, models, warnings)
    warm = models.is_loaded(detect_key)
    report("detect", 0.1, "正在检测 UI 元素…" if warm else "首次加载检测模型，约 20-40 秒…")
    detector = models.require(detect_key)
    detections: list[Detection] = detector.detect(
        work, classes, params.box_threshold, params.text_threshold
    )
    if not detections:
        warnings.append(
            "检测器没有返回任何元素。请确认类别 prompt 为英文小写，且各类之间以句点分隔。"
        )
    detections = detections[: max_layers * 2]
    report("detect", 1.0, f"检测到 {len(detections)} 个候选")
    _check(cancelled)

    # ---------- ocr ----------
    regions: list[TextRegion] = []
    wants_text = any(spec.category == "text" for spec in params.classes)
    if params.ocr and wants_text and detections:
        ocr_model = model_by_role("ocr")
        if ocr_model is not None and models.is_installed(ocr_model):
            report("ocr", 0.1, "正在识别文本区域…")
            regions = models.require("ocr").read(work)
            report("ocr", 1.0, f"识别到 {len(regions)} 处文本")
        else:
            warnings.append(
                "未安装 OCR 权重，文本层退化为矩形范围（缺少笔画级紧致 alpha）。"
                "安装方式：python scripts/download_models.py --repo=ocr"
            )
        _check(cancelled)

    # ---------- segment ----------
    boxes = [clamp_box(item.box, work.width, work.height) for item in detections]
    masks: list[np.ndarray] = []
    if boxes:
        if params.segmenter == "sam":
            report("segment", 0.05, "正在精细分割（SAM）…")
            masks = models.require("segment").segment(work, boxes)
            report("segment", 0.9, f"已分割 {len(masks)} 个元素")
        else:
            for box in boxes:
                mask = np.zeros((work.height, work.width), dtype=bool)
                x1, y1, x2, y2 = box
                mask[y1:y2, x1:x2] = True
                masks.append(mask)
            report("segment", 0.5, "按检测框直接取矩形范围")
    report("segment", 1.0, "分割完成")
    _check(cancelled)

    # ---------- refine ----------
    report("refine", 0.02, "正在整理图层边缘…")
    text_min_area = max(4, int(params.min_area * scale * scale))
    text_threshold = threshold_from_text_threshold(params.text_threshold)
    candidates: list[Candidate] = []
    total = max(1, len(detections))
    for index, (detection, box, mask) in enumerate(
        zip(detections, boxes, masks + [None] * max(0, len(detections) - len(masks)))
    ):
        _check(cancelled)
        report("refine", min(0.95, (index + 1) / total), f"正在整理图层 {index + 1}/{total}（{detection.label}）")

        alpha_work: np.ndarray | None = None
        text_value: str | None = None
        if detection.category == "text" and regions:
            region = _best_text_region(box, regions)
            if region is not None:
                alpha_work = text_alpha(
                    work_rgb, region.quad, text_min_area, threshold=text_threshold, feather=params.feather
                )
                text_value = region.text
        if alpha_work is None or not alpha_work.any():
            if mask is None:
                continue
            alpha_work = refine_mask(mask, max(4, int(params.min_area * scale * scale)), params.feather)
        if alpha_work is None or not alpha_work.any():
            continue

        alpha = alpha_work if scale >= 1.0 else cv2.resize(
            alpha_work, (width, height), interpolation=cv2.INTER_LINEAR
        )
        box_original = clamp_box(scale_box(box, 1.0 / scale), width, height)
        candidates.append(
            Candidate(
                id=f"c{len(candidates) + 1:04d}",
                label=detection.label,
                prompt=detection.prompt,
                category=detection.category,
                score=detection.score,
                source="detect+sam" if params.segmenter == "sam" else "detect",
                box=box_original,
                mask=None,
                text=text_value,
                alpha=alpha,
            )
        )
    report("refine", 1.0, f"整理出 {len(candidates)} 个图层")
    _check(cancelled)

    # ---------- zorder ----------
    report("zorder", 0.3, "正在计算图层顺序…")
    ordered = order_layers(candidates, exclusive=bool(params.exclusive_layers))
    for item in ordered:
        item.alpha_bbox = alpha_bbox(item.alpha) if item.alpha is not None else None
    ordered = [item for item in ordered if item.alpha_bbox is not None]
    if len(ordered) > max_layers:
        # 超出上限时按 得分 × 面积 截断，并在 warnings 里说明
        ordered.sort(key=lambda item: -(item.score * float((item.alpha > 0).sum())))
        dropped = len(ordered) - max_layers
        ordered = ordered[:max_layers]
        ordered.sort(key=lambda item: item.z)
        warnings.append(f"图层数超过上限 {max_layers}，已按得分×面积截断 {dropped} 个")
    report("zorder", 1.0, f"共 {len(ordered)} 个图层")
    _check(cancelled)

    # ---------- background ----------
    source_rgb = np.asarray(image, dtype=np.uint8)
    background_rgba = None
    if params.background != "none" and ordered:
        report("background", 0.3, "正在生成背景层…")
        background_rgba = build_background(
            source_rgb,
            [item.alpha for item in ordered if item.alpha is not None],
            params.background,
        )
    elif params.background == "none":
        background_rgba = build_background(source_rgb, [], "none")
    report("background", 1.0, "背景层完成")

    image_info = {"name": filename, "width": width, "height": height, "scale": round(scale, 4)}
    return PipelineOutcome(
        source_rgb=source_rgb,
        image_info=image_info,
        layers=ordered,
        background_rgba=background_rgba,
        warnings=warnings,
    )


def _main(argv: list[str] | None = None) -> int:
    """脱离 HTTP 单跑，用于先把模型调通：python -m app.pipeline.runner --image xxx.png"""
    parser = argparse.ArgumentParser(description="图层拆分管线单跑")
    parser.add_argument("--image", required=True)
    parser.add_argument("--out", default="", help="输出目录，默认 server/tmp/manual")
    parser.add_argument("--prompt", default="button,icon,text,panel", help="逗号分隔的英文提示词")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--max-side", type=int, default=1536)
    args = parser.parse_args(argv)

    from ..schemas import ClassSpec, SplitParams  # noqa: PLC0415

    settings = Settings(device=args.device)
    settings.tmp_dir.mkdir(parents=True, exist_ok=True)
    models = ModelManager(settings)

    classes = []
    for phrase in [item.strip() for item in args.prompt.split(",") if item.strip()]:
        classes.append(ClassSpec(label=phrase, prompt=phrase, category="other"))
    params = SplitParams(classes=classes, max_side=args.max_side)

    image_path = Path(args.image)
    out_dir = Path(args.out) if args.out else settings.tmp_dir / "manual"
    out_dir.mkdir(parents=True, exist_ok=True)

    def report(stage: str, fraction: float, message: str = "") -> None:
        print(f"[{stage:>10}] {fraction * 100:5.1f}%  {message}", file=sys.stderr)

    from .exporter import write_outputs  # noqa: PLC0415

    outcome = run_pipeline(
        job_id="manual",
        image_bytes=image_path.read_bytes(),
        filename=image_path.name,
        params=params,
        models=models,
        settings=settings,
        progress=report,
    )
    manifest = write_outputs(
        job_dir=out_dir,
        job_id="manual",
        source_rgb=outcome.source_rgb,
        image_info=outcome.image_info,
        layers=outcome.layers,
        background_rgba=outcome.background_rgba,
        background_mode=params.background,
        warnings=outcome.warnings,
    )
    print(f"图层数：{len(manifest['layers'])}  产物目录：{out_dir}")
    for warning in manifest["warnings"]:
        print(f"注意：{warning}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(_main())