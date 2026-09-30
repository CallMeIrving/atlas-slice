"""文本层的紧致 alpha：环带估底色 → 软 alpha → 自适应阈值退化路径。"""

from __future__ import annotations

import numpy as np

from app.pipeline.text_alpha import (
    DEFAULT_THRESHOLD,
    FLAT_BG_SPREAD,
    quad_mask,
    text_alpha,
    threshold_from_text_threshold,
)

"""平坦底色上的一个黑色方块，模拟「白底黑字」"""
FLAT_QUAD = [(16, 16), (44, 16), (44, 44), (16, 44)]
BLOCK = (20, 20, 40, 40)


def flat_scene(value: int = 200, size: int = 64) -> np.ndarray:
    rgb = np.full((size, size, 3), value, dtype=np.uint8)
    x1, y1, x2, y2 = BLOCK
    rgb[y1:y2, x1:x2] = 0
    return rgb


def gradient_scene(size: int = 64) -> np.ndarray:
    """渐变底 + 一条窄亮笔画。

    自适应阈值取的是「亮于局部均值」的像素，且窗口是 15×15：笔画必须比窗口窄，
    中心点的窗口里才会同时包含笔画和底色，否则纯色块中心会被判成背景。
    """
    ramp = np.linspace(40, 220, size, dtype=np.uint8)
    rgb = np.dstack([np.tile(ramp, (size, 1))] * 3)
    rgb[22:42, 29:32] = 255
    return rgb


def test_threshold_from_text_threshold_is_clamped():
    assert threshold_from_text_threshold(0.25) == DEFAULT_THRESHOLD
    assert threshold_from_text_threshold(0.0) == 8
    assert threshold_from_text_threshold(1.0) == 120


def test_quad_mask_fills_polygon():
    mask = quad_mask((64, 64), FLAT_QUAD)
    assert mask.dtype == np.uint8
    assert mask[30, 30] == 1
    assert mask[0, 0] == 0
    # 四边形内部面积约等于矩形面积（fillPoly 连边界一起填，29×29 = 841）
    assert 800 <= int(mask.sum()) <= 880


def test_quad_mask_accepts_two_points_as_rectangle():
    mask = quad_mask((64, 64), [(4, 4), (10, 10)])
    assert mask[5, 5] == 1
    assert mask[20, 20] == 0


def test_text_alpha_on_flat_background_keeps_strokes_only():
    rgb = flat_scene()
    alpha = text_alpha(rgb, FLAT_QUAD, min_area=8, threshold=DEFAULT_THRESHOLD, feather=1)

    assert alpha.dtype == np.uint8
    assert alpha[30, 30] == 255  # 笔画内部
    assert alpha[17, 17] == 0    # 框内底色：环带估计出的底色与它一致，差值为 0
    assert alpha[0, 0] == 0      # 框外一律为 0
    assert alpha[55, 55] == 0


def test_text_alpha_soft_edge_is_not_binary():
    """笔画与底色的差值小于阈值时应拿到中间值，而不是被二值化。"""
    rgb = np.full((64, 64, 3), 180, dtype=np.uint8)
    rgb[28:32, 22:38] = 160  # 差值 20，正好是阈值 40 的一半
    alpha = text_alpha(rgb, FLAT_QUAD, min_area=4, threshold=40, feather=0)
    assert alpha.dtype == np.uint8
    assert alpha[30, 30] == 127
    assert set(np.unique(alpha).tolist()) == {0, 127}


def test_text_alpha_falls_back_to_adaptive_on_textured_background():
    rgb = gradient_scene()
    ring_span = float(rgb[16, 14:48].max()) - float(rgb[16, 14:48].min())
    assert ring_span > FLAT_BG_SPREAD, "构造的底色必须是「不纯」的，才能触发退化路径"

    alpha = text_alpha(rgb, FLAT_QUAD, min_area=8, threshold=DEFAULT_THRESHOLD, feather=1)
    assert alpha[30, 30] > 0
    assert alpha[0, 0] == 0


def test_text_alpha_drops_small_components():
    rgb = np.full((64, 64, 3), 200, dtype=np.uint8)
    rgb[30:32, 30:32] = 0  # 2×2 的小点
    alpha = text_alpha(rgb, FLAT_QUAD, min_area=50, threshold=DEFAULT_THRESHOLD, feather=0)
    assert alpha.max() == 0


def test_text_alpha_without_quad_is_empty():
    alpha = text_alpha(flat_scene(), [], min_area=4)
    assert alpha.shape == (64, 64)
    assert alpha.max() == 0