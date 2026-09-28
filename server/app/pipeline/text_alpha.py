"""文本层的紧致 alpha。

OCR 给的是矩形（Florence-2 给的是四边形）文本框，直接按框给矩形 alpha 会把底色一起抠走。
这里的做法：用框外圈环带估计底色 → 按灰度差取出笔画 → **软 alpha**（而不是二值），
让抗锯齿边缘自然过渡；底色有渐变时退回自适应阈值。
"""

from __future__ import annotations

import cv2
import numpy as np

Quad = list[tuple[int, int]]

"""笔画与底色的灰度差（0-255）。由 UI 的 text_threshold 映射而来，0.25 → 40"""
DEFAULT_THRESHOLD = 40
"""环带灰度分布超过该跨度时认为底色不纯（有渐变/纹理），改用自适应阈值"""
FLAT_BG_SPREAD = 30
"""软边的模糊半径，用于抹掉阈值造成的硬边"""
SOFT_SIGMA = 0.6


def threshold_from_text_threshold(text_threshold: float) -> int:
    return int(max(8, min(120, round(float(text_threshold) * 160))))


def quad_mask(shape: tuple[int, int], quad: Quad) -> np.ndarray:
    """四边形（或矩形）填充掩膜。"""
    mask = np.zeros(shape, dtype=np.uint8)
    if not quad:
        return mask
    if len(quad) >= 3:
        cv2.fillPoly(mask, [np.asarray(quad, dtype=np.int32)], 1)
    else:
        x1, y1 = quad[0]
        x2, y2 = quad[-1]
        cv2.rectangle(mask, (min(x1, x2), min(y1, y2)), (max(x1, x2), max(y1, y2)), 1, thickness=-1)
    return mask


def _ring_mask(mask: np.ndarray, width: int = 5) -> np.ndarray:
    """框外侧一圈环带：用来估计底色，不包含笔画本身。"""
    kernel = np.ones((width, width), np.uint8)
    dilated = cv2.dilate(mask, kernel, iterations=1)
    return cv2.subtract(dilated, mask)


def _drop_small(alpha: np.ndarray, min_area: int) -> np.ndarray:
    binary = np.asarray(alpha > 0, dtype=np.uint8)
    if not binary.any():
        return alpha
    count, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    keep = np.zeros_like(binary)
    for index in range(1, count):
        if stats[index, cv2.CC_STAT_AREA] >= min_area:
            keep[labels == index] = 1
    return np.where(keep > 0, alpha, 0).astype(np.uint8)


def text_alpha(
    rgb: np.ndarray,
    quad: Quad,
    min_area: int,
    threshold: int = DEFAULT_THRESHOLD,
    feather: int = 1,
) -> np.ndarray:
    """返回与原图同尺寸的 uint8 alpha；没有可用笔画时返回全 0。"""
    height, width = rgb.shape[:2]
    mask = quad_mask((height, width), quad)
    if not mask.any():
        return np.zeros((height, width), dtype=np.uint8)

    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    ring = _ring_mask(mask)
    alpha = np.zeros((height, width), dtype=np.uint8)

    if ring.any():
        samples = gray[ring > 0].astype(np.float32)
        base = float(np.median(samples))
        spread = float(np.percentile(samples, 90) - np.percentile(samples, 10))
    else:
        base, spread = None, 0.0

    if base is None or spread > FLAT_BG_SPREAD:
        # 底色不纯：自适应阈值比单一基准色稳，代价是需要足够的局部窗口
        binary = cv2.adaptiveThreshold(
            gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 15, -8
        )
        alpha = np.where(mask > 0, binary, 0).astype(np.uint8)
    else:
        diff = np.abs(gray.astype(np.float32) - base)
        ratio = np.clip(diff / max(1.0, float(threshold)), 0.0, 1.0)
        alpha = np.where(mask > 0, (ratio * 255.0), 0.0).astype(np.uint8)

    alpha = _drop_small(alpha, min_area)
    if feather > 0 and alpha.any():
        alpha = cv2.GaussianBlur(alpha, (0, 0), sigmaX=SOFT_SIGMA)
    return alpha