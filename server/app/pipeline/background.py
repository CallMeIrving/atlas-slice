"""背景层合成。

元素被抠走后原图会留洞，三种策略各有取舍：
- ``none``：保留原始像素——诚实，但「背景」里仍带着被抠元素的残影；
- ``erase``：这些位置 alpha 置 0——干净，但会露底；
- ``inpaint``（默认）：掩膜膨胀后做 Telea 修补——大面板被抠走时会涂抹丢纹理，UI 需要提示局限。
"""

from __future__ import annotations

import cv2
import numpy as np

from .mask_refine import ALPHA_VISIBLE, union_alpha

"""修补掩膜的膨胀量，用来盖住元素边缘的抗锯齿晕边"""
INPAINT_DILATE = 3
"""Telea 的邻域半径"""
INPAINT_RADIUS = 3


def build_background(
    rgb: np.ndarray,
    alphas: list[np.ndarray],
    mode: str,
    dilate: int = INPAINT_DILATE,
) -> np.ndarray:
    """返回与原图同尺寸的 RGBA 背景层。"""
    height, width = rgb.shape[:2]
    rgba = np.empty((height, width, 4), dtype=np.uint8)
    rgba[..., :3] = rgb

    if mode == "none" or not alphas:
        rgba[..., 3] = 255
        return rgba

    union = union_alpha(alphas, (height, width))
    mask = np.asarray(union > ALPHA_VISIBLE, dtype=np.uint8)

    if mode == "erase":
        rgba[..., 3] = np.where(mask > 0, 0, 255).astype(np.uint8)
        return rgba

    if dilate > 0:
        mask = cv2.dilate(mask, np.ones((dilate, dilate), np.uint8), iterations=1)
    if not mask.any():
        rgba[..., 3] = 255
        return rgba

    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    repaired = cv2.inpaint(bgr, (mask * 255).astype(np.uint8), INPAINT_RADIUS, cv2.INPAINT_TELEA)
    rgba[..., :3] = cv2.cvtColor(repaired, cv2.COLOR_BGR2RGB)
    rgba[..., 3] = 255
    return rgba