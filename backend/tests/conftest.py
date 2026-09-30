"""公共夹具。

默认用例**不需要权重、也不需要 torch**：检测 / 分割 / OCR 三个角色都由 Fake 后端顶上，
只有 `@pytest.mark.slow` 的用例才会去碰真实模型。
"""

from __future__ import annotations

import io
import json
import time
from pathlib import Path
from typing import Any, Sequence

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.main import create_app
from app.models.registry import SERVER_MODELS
from app.pipeline.backends import Detection, TextRegion
from app.runtime.model_manager import ModelManager

# 一个「面板里套按钮、按钮里套图标」的典型嵌套结构
DEFAULT_DETECTIONS = [
    Detection(label="面板", prompt="panel", category="panel", score=0.90, box=(2, 2, 94, 94)),
    Detection(label="按钮", prompt="button", category="button", score=0.80, box=(20, 20, 60, 36)),
    Detection(label="图标", prompt="icon", category="icon", score=0.70, box=(24, 24, 36, 36)),
]

CLASSES = [
    {"label": "面板", "prompt": "panel", "category": "panel"},
    {"label": "按钮", "prompt": "button", "category": "button"},
    {"label": "图标", "prompt": "icon", "category": "icon"},
    {"label": "文本", "prompt": "text", "category": "text"},
]


class FakeDetector:
    def __init__(self, detections: Sequence[Detection]) -> None:
        self.detections = list(detections)

    def detect(self, image, classes, box_threshold, text_threshold):  # noqa: ANN001
        return list(self.detections)


class RectSegmenter:
    """按检测框填矩形，模拟 SAM 的输出（保证 refine_mask 能留下连通域）。"""

    def segment(self, image, boxes):  # noqa: ANN001
        height, width = image.height, image.width
        masks: list[np.ndarray] = []
        for x1, y1, x2, y2 in boxes:
            mask = np.zeros((height, width), dtype=bool)
            mask[y1:y2, x1:x2] = True
            masks.append(mask)
        return masks


class EmptySegmenter:
    def segment(self, image, boxes):  # noqa: ANN001
        return [np.zeros((image.height, image.width), dtype=bool) for _ in boxes]


class FakeOcr:
    def __init__(self, regions: Sequence[TextRegion]) -> None:
        self.regions = list(regions)

    def read(self, image):  # noqa: ANN001
        return list(self.regions)


def install_fake_weights(models_dir: Path, roles: Sequence[str] | None = None) -> Path:
    """把 registry 里 required 的文件都写成占位内容，使 ``is_installed`` 为真。

    ``roles`` 只装指定角色，用于验证「缺 OCR 权重退化」这类分支。
    """
    for model in SERVER_MODELS:
        if roles is not None and model.role not in roles:
            continue
        root = models_dir / model.repo_id
        root.mkdir(parents=True, exist_ok=True)
        for spec in model.files:
            if spec.required:
                (root / spec.file).write_bytes(b"placeholder")
    return models_dir


def build_app(
    settings: Settings,
    *,
    detections: Sequence[Detection] | None = None,
    regions: Sequence[TextRegion] | None = None,
    segmenter: Any | None = None,
):
    """用 Fake 后端装配 app（不落 torch）。"""
    fixed = list(DEFAULT_DETECTIONS if detections is None else detections)

    def factory(role: str, model_dir: Path, device: Any, dtype: Any) -> Any:
        if role in ("detect", "detect:florence2"):
            return FakeDetector(fixed)
        if role == "segment":
            return segmenter if segmenter is not None else RectSegmenter()
        if role == "ocr":
            return FakeOcr(regions or [])
        raise AssertionError(f"未预期的角色：{role}")

    app = create_app(settings)
    app.state.model_manager = ModelManager(settings, factory=factory)
    return app


def png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def gradient_image(width: int = 96, height: int = 96) -> Image.Image:
    """带纹理的底色：用于验证 alpha 与裁切，不依赖任何模型。"""
    ramp = np.linspace(30, 220, width, dtype=np.uint8)
    rgb = np.dstack([np.tile(ramp, (height, 1))] * 3)
    return Image.fromarray(rgb, mode="RGB")


@pytest.fixture
def settings_factory(tmp_path: Path):
    def build(**overrides: Any) -> Settings:
        values: dict[str, Any] = {"models_dir": tmp_path / "models", "tmp_dir": tmp_path / "tmp"}
        values.update(overrides)
        return Settings(**values)

    return build


@pytest.fixture
def settings(settings_factory) -> Settings:
    return settings_factory()


@pytest.fixture
def ready_models(settings: Settings) -> Path:
    return install_fake_weights(settings.models_dir)


@pytest.fixture
def client_factory(settings: Settings):
    """``build(**kwargs)`` 返回一个已进入 lifespan 的 TestClient，退出时统一关闭。"""
    stack: list[TestClient] = []

    def build(*, app_settings: Settings | None = None, **kwargs: Any) -> TestClient:
        app = build_app(app_settings or settings, **kwargs)
        client = TestClient(app)
        client.__enter__()
        stack.append(client)
        return client

    yield build
    for client in stack:
        client.__exit__(None, None, None)


@pytest.fixture
def client(client_factory):
    return client_factory()


def poll_job(client: TestClient, job_id: str, timeout: float = 30.0) -> dict[str, Any]:
    """轮询到终态；超时直接失败，避免测试挂死。"""
    deadline = time.time() + timeout
    payload: dict[str, Any] = {}
    while time.time() < deadline:
        response = client.get(f"/api/layers/jobs/{job_id}")
        assert response.status_code == 200, response.text
        payload = response.json()
        if payload["status"] in ("succeeded", "failed", "cancelled"):
            return payload
        time.sleep(0.05)
    raise AssertionError(f"作业超时未结束：{payload}")


def split_request(
    client: TestClient,
    *,
    image: Image.Image | None = None,
    params: dict[str, Any] | None = None,
    content_type: str = "image/png",
    raw: bytes | None = None,
):
    payload = {
        "classes": CLASSES,
        "detector": "grounding-dino",
        "segmenter": "sam",
        "ocr": False,
        "background": "inpaint",
        "max_side": 256,
        "max_layers": 20,
    }
    payload.update(params or {})
    body = raw if raw is not None else png_bytes(image or gradient_image())
    return client.post(
        "/api/layers/split",
        files={"file": ("gameUI.png", body, content_type)},
        data={"params": json.dumps(payload, ensure_ascii=False)},
    )


def split_and_wait(client: TestClient, **kwargs: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    response = split_request(client, **kwargs)
    assert response.status_code == 202, response.text
    job_id = response.json()["job_id"]
    return response.json(), poll_job(client, job_id)