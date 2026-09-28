"""掩膜后处理：去碎块、补孔洞、羽化，以及 alpha ↔ 图像 的常用转换。"""

from __future__ import annotations

import cv2
import numpy as np

from .backends import Box

"""alpha 大于该值才算「可见像素」，用于计算 alpha_bbox 与背景掩膜"""
ALPHA_VISIBLE = 8


def refine_mask(mask: np.ndarray, min_area: int, feather: int) -> np.ndarray | None:
    """把布尔掩膜收敛成 uint8 alpha（0-255）。

    连通域小于 ``min_area`` 的碎点会被丢掉；整体没有达标区域时返回 None（该候选被丢弃）。
    """
    binary = np.asarray(mask > 0, dtype=np.uint8)
    if binary.size == 0 or not binary.any():
        return None

    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    keep = np.zeros_like(binary)
    for index in range(1, count):
        if stats[index, cv2.CC_STAT_AREA] >= min_area:
            keep[labels == index] = 1
    if not keep.any():
        return None

    # 闭运算补掉 SAM 偶尔留下的针孔，避免元素内部出现透光的小点
    keep = cv2.morphologyEx(keep, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    alpha = (keep * 255).astype(np.uint8)
    if feather > 0:
        alpha = cv2.GaussianBlur(alpha, (0, 0), sigmaX=float(feather))
    return alpha


def alpha_bbox(alpha: np.ndarray, threshold: int = ALPHA_VISIBLE) -> Box | None:
    """取 alpha 的紧致包围盒（含羽化边缘），无可见像素时返回 None。"""
    visible = alpha > threshold
    if not visible.any():
        return None
    rows = np.where(visible.any(axis=1))[0]
    cols = np.where(visible.any(axis=0))[0]
    y1, y2 = int(rows[0]), int(rows[-1]) + 1
    x1, x2 = int(cols[0]), int(cols[-1]) + 1
    return x1, y1, x2, y2


def crop_to_bbox(array: np.ndarray, box: Box) -> np.ndarray:
    x1, y1, x2, y2 = box
    return array[y1:y2, x1:x2]


def union_alpha(alphas: list[np.ndarray], shape: tuple[int, int]) -> np.ndarray:
    """所有元素的 alpha 并集，用于生成背景层。"""
    result = np.zeros(shape, dtype=np.uint8)
    for alpha in alphas:
        np.maximum(result, alpha, out=result)
    return result


def to_rgba(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    height, width = alpha.shape
    rgba = np.empty((height, width, 4), dtype=np.uint8)
    rgba[..., :3] = rgb
    rgba[..., 3] = alpha
    return rgba