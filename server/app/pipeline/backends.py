"""后端协议与管线数据结构。

三个角色各自的实现只依赖这里的 Protocol，便于测试注入 Fake 后端（不需要真实权重）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, Sequence

import numpy as np
from PIL import Image

Box = tuple[int, int, int, int]
"""x1, y1, x2, y2（原图坐标系，右下开区间）"""


@dataclass
class Detection:
    """检测器的输出：一个候选元素。"""

    label: str
    prompt: str
    category: str
    score: float
    box: Box


@dataclass
class TextRegion:
    """OCR 输出：文本内容 + 四边形（原图坐标）。"""

    text: str
    quad: list[tuple[int, int]]
    score: float = 1.0


@dataclass
class Candidate:
    """检测 + 分割后的候选图层（尚未排序、尚未生成 alpha 之外的产物）。"""

    id: str
    label: str
    prompt: str
    category: str
    score: float
    source: str
    box: Box
    """原图尺度的布尔掩膜"""
    mask: np.ndarray | None = None
    """产物文件名用的可读短名（如 button_01），由 exporter 生成"""
    name: str = ""
    text: str | None = None
    parent_id: str | None = None
    """原图尺度的 uint8 alpha（0-255）"""
    alpha: np.ndarray | None = None
    alpha_bbox: Box | None = None
    z: int = 0
    warnings: list[str] = field(default_factory=list)


class DetectorBackend(Protocol):
    def detect(
        self,
        image: Image.Image,
        classes: Sequence[dict[str, str]],
        box_threshold: float,
        text_threshold: float,
    ) -> list[Detection]:
        """按类别提示词出框；没有命中时返回空列表（不要抛异常）。"""


class SegmenterBackend(Protocol):
    def segment(self, image: Image.Image, boxes: Sequence[Box]) -> list[np.ndarray]:
        """按检测框逐个出掩膜，返回顺序与 boxes 一致，掩膜为原图尺度的布尔数组。"""


class OcrBackend(Protocol):
    def read(self, image: Image.Image) -> list[TextRegion]:
        """识别文本区域，返回四边形框。"""


def box_area(box: Box) -> int:
    x1, y1, x2, y2 = box
    return max(0, x2 - x1) * max(0, y2 - y1)


def box_intersection(a: Box, b: Box) -> int:
    x1 = max(a[0], b[0])
    y1 = max(a[1], b[1])
    x2 = min(a[2], b[2])
    y2 = min(a[3], b[3])
    return max(0, x2 - x1) * max(0, y2 - y1)


def box_iou(a: Box, b: Box) -> float:
    inter = box_intersection(a, b)
    union = box_area(a) + box_area(b) - inter
    return inter / union if union else 0.0


def clamp_box(box: Box, width: int, height: int) -> Box:
    x1 = max(0, min(int(round(box[0])), width))
    y1 = max(0, min(int(round(box[1])), height))
    x2 = max(x1, min(int(round(box[2])), width))
    y2 = max(y1, min(int(round(box[3])), height))
    return x1, y1, x2, y2


def scale_box(box: Box, scale: float) -> Box:
    return tuple(int(round(v * scale)) for v in box)  # type: ignore[return-value]