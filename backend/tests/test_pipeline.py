"""管线：包含森林与 z 序、去重、alpha_bbox、背景策略、取消、解码错误、上限与缩放。"""

from __future__ import annotations

import io
import os

import numpy as np
import pytest
from PIL import Image

from app.config import Settings
from app.errors import ApiError
from app.pipeline.backends import Candidate, Detection, TextRegion
from app.pipeline.background import build_background
from app.pipeline.detect_grounding_dino import build_prompt, match_class, normalize_prompt
from app.pipeline.mask_refine import alpha_bbox, refine_mask
from app.pipeline.runner import decode_image, run_pipeline
from app.pipeline.zorder import order_layers
from app.runtime.jobs import JobCancelled
from app.runtime.model_manager import ModelManager
from app.schemas import ClassSpec, SplitParams
from conftest import FakeDetector, FakeOcr, RectSegmenter, install_fake_weights

SIZE = 96


def _candidate(cid: str, category: str, box, score: float = 0.8) -> Candidate:
    x1, y1, x2, y2 = box
    alpha = np.zeros((SIZE, SIZE), dtype=np.uint8)
    alpha[y1:y2, x1:x2] = 255
    return Candidate(
        id=cid,
        label=category,
        prompt=category,
        category=category,
        score=score,
        source="detect+sam",
        box=box,
        alpha=alpha,
        alpha_bbox=(x1, y1, x2, y2),
    )


# ---------------------------------------------------------------- 排序 / 森林


def test_order_layers_builds_containment_forest():
    layers = [
        _candidate("c0001", "icon", (24, 24, 36, 36), score=0.7),
        _candidate("c0002", "panel", (2, 2, 94, 94), score=0.9),
        _candidate("c0003", "button", (20, 20, 60, 36), score=0.8),
    ]
    ordered = order_layers(layers)
    by_id = {item.id: item for item in ordered}

    assert by_id["c0002"].parent_id is None
    assert by_id["c0003"].parent_id == "c0002"
    assert by_id["c0001"].parent_id == "c0003"
    # z 升序：面板在最底，图标在最上
    assert [item.id for item in ordered] == ["c0002", "c0003", "c0001"]
    assert [item.z for item in ordered] == [1, 2, 3]


def test_order_layers_dedupes_same_category_overlap():
    layers = [
        _candidate("c0001", "button", (10, 10, 50, 30), score=0.4),
        _candidate("c0002", "button", (11, 11, 51, 31), score=0.9),
    ]
    ordered = order_layers(layers)
    assert len(ordered) == 1
    assert ordered[0].id == "c0002"


def test_order_layers_keeps_cross_category_overlap():
    layers = [
        _candidate("c0001", "button", (10, 10, 50, 30), score=0.4),
        _candidate("c0002", "icon", (11, 11, 49, 29), score=0.9),
    ]
    assert len(order_layers(layers)) == 2


def test_category_rank_breaks_ties_at_same_depth():
    layers = [
        _candidate("c0001", "text", (2, 2, 40, 20)),
        _candidate("c0002", "panel", (2, 30, 40, 60)),
    ]
    ordered = order_layers(layers)
    assert [item.category for item in ordered] == ["panel", "text"]


def test_exclusive_subtracts_descendant_alpha():
    layers = [
        _candidate("c0001", "panel", (2, 2, 94, 94)),
        _candidate("c0002", "icon", (24, 24, 36, 36)),
    ]
    ordered = order_layers(layers, exclusive=True)
    panel = next(item for item in ordered if item.id == "c0001")
    icon = next(item for item in ordered if item.id == "c0002")
    assert panel.alpha[30, 30] == 0   # 子层位置被挖空
    assert panel.alpha[5, 5] == 255
    assert icon.alpha[30, 30] == 255


def test_parent_requires_meaningfully_larger_area():
    """面积只大一点点不算父层，避免同一元素被拆成父子。"""
    layers = [
        _candidate("c0001", "panel", (10, 10, 50, 50)),
        _candidate("c0002", "decoration", (11, 11, 49, 49)),
    ]
    ordered = order_layers(layers)
    assert all(item.parent_id is None for item in ordered)


# ---------------------------------------------------------------- 掩膜后处理


def test_refine_mask_drops_small_components():
    mask = np.zeros((SIZE, SIZE), dtype=bool)
    mask[10:20, 10:20] = True
    mask[40:41, 40:41] = True
    alpha = refine_mask(mask, min_area=20, feather=0)
    assert alpha is not None
    assert alpha[15, 15] == 255
    assert alpha[40, 40] == 0


def test_refine_mask_returns_none_when_empty():
    assert refine_mask(np.zeros((8, 8), dtype=bool), min_area=4, feather=0) is None


def test_alpha_bbox_is_tight():
    alpha = np.zeros((SIZE, SIZE), dtype=np.uint8)
    alpha[12:30, 20:44] = 255
    assert alpha_bbox(alpha) == (20, 12, 44, 30)
    assert alpha_bbox(np.zeros((SIZE, SIZE), dtype=np.uint8)) is None


def test_build_background_modes():
    rgb = np.full((SIZE, SIZE, 3), 100, dtype=np.uint8)
    alpha = np.zeros((SIZE, SIZE), dtype=np.uint8)
    alpha[20:40, 20:40] = 255

    none = build_background(rgb, [alpha], "none")
    assert none.shape == (SIZE, SIZE, 4)
    assert (none[..., 3] == 255).all()

    erased = build_background(rgb, [alpha], "erase")
    assert erased[30, 30, 3] == 0
    assert erased[5, 5, 3] == 255

    inpainted = build_background(rgb, [alpha], "inpaint")
    assert (inpainted[..., 3] == 255).all()
    assert inpainted.shape == (SIZE, SIZE, 4)


def test_build_background_without_elements_keeps_original():
    rgb = np.full((SIZE, SIZE, 3), 100, dtype=np.uint8)
    out = build_background(rgb, [], "inpaint")
    assert (out[..., 3] == 255).all()


# ---------------------------------------------------------------- 提示词


def test_build_prompt_normalizes_and_separates():
    prompt, mapping = build_prompt(
        [
            {"label": "按钮", "prompt": "  Button  ", "category": "button"},
            {"label": "进度条", "prompt": "progress bar", "category": "progress"},
        ]
    )
    assert prompt == "button . progress bar ."
    assert set(mapping) == {"button", "progress bar"}


def test_build_prompt_empty_when_no_phrases():
    prompt, mapping = build_prompt([{"label": "", "prompt": "", "category": "other"}])
    assert prompt == ""
    assert mapping == {}


def test_match_class_falls_back_to_containment():
    _, mapping = build_prompt([{"label": "按钮", "prompt": "button", "category": "button"}])
    assert match_class("button", mapping)["category"] == "button"
    assert match_class("a button", mapping)["category"] == "button"
    assert match_class("slider", mapping) is None
    assert normalize_prompt("  Progress   BAR ") == "progress bar"


# ---------------------------------------------------------------- 端到端


def _manager(settings: Settings, *, detections, regions=None, segmenter=None) -> ModelManager:
    def factory(role, model_dir, device, dtype):  # noqa: ANN001
        if role in ("detect", "detect:florence2"):
            return FakeDetector(detections)
        if role == "segment":
            return segmenter or RectSegmenter()
        if role == "ocr":
            return FakeOcr(regions or [])
        raise AssertionError(role)

    return ModelManager(settings, factory=factory)


def _params(**overrides) -> SplitParams:
    base = {
        "classes": [
            ClassSpec(label="面板", prompt="panel", category="panel"),
            ClassSpec(label="按钮", prompt="button", category="button"),
            ClassSpec(label="文本", prompt="text", category="text"),
        ],
        "ocr": False,
        "max_side": 256,
        "background": "inpaint",
    }
    base.update(overrides)
    return SplitParams(**base)


def _image(size: int = SIZE) -> bytes:
    buffer = io.BytesIO()
    Image.fromarray(np.full((size, size, 3), 150, dtype=np.uint8), mode="RGB").save(buffer, "PNG")
    return buffer.getvalue()


def test_run_pipeline_end_to_end(settings, ready_models):
    detections = [
        Detection(label="面板", prompt="panel", category="panel", score=0.9, box=(2, 2, 94, 94)),
        Detection(label="按钮", prompt="button", category="button", score=0.8, box=(20, 20, 60, 36)),
    ]
    stages: list[str] = []

    outcome = run_pipeline(
        job_id="t1",
        image_bytes=_image(),
        filename="gameUI.png",
        params=_params(),
        models=_manager(settings, detections=detections),
        settings=settings,
        progress=lambda stage, fraction, message="": stages.append(stage),
    )

    assert outcome.image_info == {"name": "gameUI.png", "width": SIZE, "height": SIZE, "scale": 1.0}
    assert [item.category for item in outcome.layers] == ["panel", "button"]
    assert outcome.layers[0].parent_id is None
    assert outcome.layers[1].parent_id == outcome.layers[0].id
    assert all(item.alpha_bbox is not None for item in outcome.layers)
    assert outcome.background_rgba.shape == (SIZE, SIZE, 4)
    assert outcome.warnings == []
    assert {"detect", "segment", "refine", "zorder", "background"} <= set(stages)


def test_run_pipeline_warns_when_detector_returns_nothing(settings, ready_models):
    outcome = run_pipeline(
        job_id="t2",
        image_bytes=_image(),
        filename="a.png",
        params=_params(),
        models=_manager(settings, detections=[]),
        settings=settings,
    )
    assert outcome.layers == []
    assert outcome.background_rgba is None  # inpaint 且没有元素 → 不产出背景
    assert any("没有返回任何元素" in warning for warning in outcome.warnings)


def test_run_pipeline_scales_down_and_maps_box_back(settings, ready_models):
    detections = [Detection(label="图标", prompt="icon", category="icon", score=0.9, box=(8, 8, 24, 24))]
    outcome = run_pipeline(
        job_id="t3",
        image_bytes=_image(96),
        filename="a.png",
        params=_params(max_side=64, classes=[ClassSpec(label="图标", prompt="icon", category="icon")]),
        models=_manager(settings, detections=detections),
        settings=settings,
    )
    assert outcome.image_info["scale"] == pytest.approx(64 / 96, abs=1e-4)
    layer = outcome.layers[0]
    assert layer.box == (12, 12, 36, 36)
    assert layer.alpha.shape == (96, 96)


def test_run_pipeline_uses_text_alpha_for_ocr_regions(settings, ready_models):
    """文本层走四边形的紧致 alpha，而不是矩形掩膜。"""
    rgb = np.full((SIZE, SIZE, 3), 200, dtype=np.uint8)
    rgb[40:56, 40:70] = 0
    buffer = io.BytesIO()
    Image.fromarray(rgb, mode="RGB").save(buffer, "PNG")

    detections = [
        Detection(label="文本", prompt="text", category="text", score=0.9, box=(36, 36, 74, 60)),
    ]
    quad = [(38, 38), (72, 38), (72, 58), (38, 58)]
    manager = _manager(
        settings,
        detections=detections,
        regions=[TextRegion(text="开始", quad=quad, score=0.95)],
    )
    outcome = run_pipeline(
        job_id="t4",
        image_bytes=buffer.getvalue(),
        filename="a.png",
        params=_params(ocr=True, classes=[ClassSpec(label="文本", prompt="text", category="text")]),
        models=manager,
        settings=settings,
    )

    assert len(outcome.layers) == 1
    layer = outcome.layers[0]
    assert layer.text == "开始"
    assert layer.alpha[46, 50] == 255          # 笔画上
    assert layer.alpha[38, 38] == 0            # 框内底色：被紧致 alpha 排除
    assert layer.alpha[0, 0] == 0
    # 结果比检测框更紧：矩形框 (36,36,74,60)，笔画只有 (40,40,70,56)
    assert layer.alpha_bbox[0] > layer.box[0] + 1
    assert layer.alpha_bbox[3] < layer.box[3] - 1


def test_run_pipeline_warns_when_ocr_weights_missing(settings):
    """未装 OCR 权重时退化成矩形范围，并明确写进 warnings（不静默降级）。"""
    install_fake_weights(settings.models_dir, roles=("detect", "segment"))
    detections = [Detection(label="文本", prompt="text", category="text", score=0.9, box=(36, 36, 74, 60))]
    outcome = run_pipeline(
        job_id="t5",
        image_bytes=_image(),
        filename="a.png",
        params=_params(ocr=True, classes=[ClassSpec(label="文本", prompt="text", category="text")]),
        models=_manager(settings, detections=detections),
        settings=settings,
    )
    assert len(outcome.layers) == 1
    assert any("OCR" in warning for warning in outcome.warnings)


def test_run_pipeline_auto_falls_back_to_florence2(settings):
    """只装了 Florence-2 时 auto 回退，并留下可追溯的 warning。"""
    install_fake_weights(settings.models_dir, roles=("segment", "ocr"))
    outcome = run_pipeline(
        job_id="t6",
        image_bytes=_image(),
        filename="a.png",
        params=_params(detector="auto"),
        models=_manager(settings, detections=[]),
        settings=settings,
    )
    assert any("回退到 Florence-2" in warning for warning in outcome.warnings)


def test_run_pipeline_honours_cancellation(settings, ready_models):
    with pytest.raises(JobCancelled):
        run_pipeline(
            job_id="t7",
            image_bytes=_image(),
            filename="a.png",
            params=_params(),
            models=_manager(settings, detections=[]),
            settings=settings,
            check_cancel=lambda: True,
        )


def test_decode_image_rejects_garbage():
    with pytest.raises(ApiError) as excinfo:
        decode_image(b"not an image")
    assert excinfo.value.code == "BAD_IMAGE"


def test_run_pipeline_rejects_oversized_image(settings, ready_models):
    with pytest.raises(ApiError) as excinfo:
        run_pipeline(
            job_id="t8",
            image_bytes=_image(128),
            filename="a.png",
            params=_params(),
            models=_manager(settings, detections=[]),
            settings=Settings(
                models_dir=settings.models_dir,
                tmp_dir=settings.tmp_dir,
                max_side_hard=64,
            ),
        )
    assert excinfo.value.code == "BAD_IMAGE"
    assert excinfo.value.detail["max_side"] == 64


def test_run_pipeline_truncates_to_max_layers(settings, ready_models):
    detections = [
        Detection(
            label="图标",
            prompt="icon",
            category="icon",
            score=0.5 + index * 0.05,
            box=(2 + index * 16, 2, 14 + index * 16, 14),
        )
        for index in range(5)
    ]
    outcome = run_pipeline(
        job_id="t9",
        image_bytes=_image(),
        filename="a.png",
        params=_params(max_layers=3),
        models=_manager(settings, detections=detections),
        settings=settings,
    )
    assert len(outcome.layers) == 3
    assert any("上限" in warning for warning in outcome.warnings)


# ---------------------------------------------------------------- 真实权重（默认跳过）


def _ui_image(size: int = 256) -> bytes:
    """一张最简 UI：面板 + 按钮 + 图标。"""
    rgb = np.full((size, size, 3), 236, dtype=np.uint8)
    rgb[40:216, 40:216] = (72, 88, 120)
    rgb[120:160, 80:176] = (150, 170, 205)
    rgb[124:156, 88:120] = (240, 240, 240)
    buffer = io.BytesIO()
    Image.fromarray(rgb, mode="RGB").save(buffer, "PNG")
    return buffer.getvalue()


@pytest.mark.slow
@pytest.mark.skipif(
    os.environ.get("LAYER_SPLIT_TEST_MODELS") != "1",
    reason="需要真实权重，设置 LAYER_SPLIT_TEST_MODELS=1 才会执行",
)
def test_run_pipeline_with_real_models():
    """真权重冒烟：本地权重就位时跑通 detect → segment → refine → zorder → background。"""
    settings = Settings()  # models_dir 仍可被 LAYER_SPLIT_MODELS_DIR 覆盖
    manager = ModelManager(settings)
    if not manager.models_ready():
        pytest.skip("detect / segment 权重未就位，先跑 scripts/download_models.py")

    outcome = run_pipeline(
        job_id="slow1",
        image_bytes=_ui_image(),
        filename="gameUI.png",
        params=_params(
            classes=[
                ClassSpec(label="面板", prompt="panel", category="panel"),
                ClassSpec(label="按钮", prompt="button", category="button"),
                ClassSpec(label="图标", prompt="icon", category="icon"),
            ],
            max_side=512,
        ),
        models=manager,
        settings=settings,
    )

    assert outcome.image_info["width"] == 256
    for layer in outcome.layers:
        assert layer.alpha_bbox is not None
        x1, y1, x2, y2 = layer.alpha_bbox
        assert 0 <= x1 < x2 <= 256
        assert 0 <= y1 < y2 <= 256
    if outcome.layers:
        assert outcome.background_rgba is not None
        assert outcome.background_rgba.shape == (256, 256, 4)