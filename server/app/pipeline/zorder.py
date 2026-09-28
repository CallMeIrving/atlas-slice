"""图层排序：包含森林 + z 序 + 去重 + 可选的「独占」裁切。

UI 里一个按钮往往同时命中 panel / button / icon / text 四层，如果全部原样叠回去，
半透明边缘（描边、外发光）会被叠加两次而变脏。这里的处理是：

1. 同类别高 IoU 去重（保留高分）；
2. 用包含关系建「父子森林」，记下 ``parent_id``；
3. ``z_key = (depth, category_rank, -area, y)``，depth 小的排后面（更靠底层）；
4. 可选 ``exclusive``：把子孙层的 alpha 从父层里减掉，使「叠加全部 ≈ 还原原图」，
   代价是父层出现空洞、单独看不好用——因此默认关闭。
"""

from __future__ import annotations

import numpy as np

from .backends import Candidate, box_area, box_intersection, box_iou

"""同深度时的类别打断顺序：底板类靠后，内容类靠前"""
CATEGORY_RANK: dict[str, int] = {
    "background": 0,
    "panel": 0,
    "border": 1,
    "decoration": 2,
    "progress": 3,
    "button": 4,
    "other": 4,
    "icon": 5,
    "text": 6,
}

"""判定「B 被 A 包含」的阈值"""
CONTAIN_RATIO = 0.9
"""A 的面积至少要大于 B 的这个倍数才算父层"""
CONTAIN_AREA_FACTOR = 1.15
"""同类别去重的 IoU 阈值"""
DEDUPE_IOU = 0.85


def dedupe(candidates: list[Candidate]) -> list[Candidate]:
    ordered = sorted(candidates, key=lambda item: (-item.score, -box_area(item.box)))
    kept: list[Candidate] = []
    for candidate in ordered:
        duplicated = any(
            candidate.category == other.category and box_iou(candidate.box, other.box) > DEDUPE_IOU
            for other in kept
        )
        if not duplicated:
            kept.append(candidate)
    return kept


def assign_parents(candidates: list[Candidate]) -> None:
    """就地写入 parent_id。父层要求面积明显更大且几乎完全覆盖子层，因此不会成环。"""
    for candidate in candidates:
        area = box_area(candidate.box)
        parent: Candidate | None = None
        for other in candidates:
            if other is candidate:
                continue
            other_area = box_area(other.box)
            if other_area <= area * CONTAIN_AREA_FACTOR:
                continue
            covered = box_intersection(other.box, candidate.box) / max(1, area)
            if covered <= CONTAIN_RATIO:
                continue
            # 取「最小的大于自己的框」作为直接父层，避免 dz 跨级
            if parent is None or box_area(parent.box) > other_area:
                parent = other
        candidate.parent_id = parent.id if parent else None


def _depth(candidate: Candidate, by_id: dict[str, Candidate], limit: int) -> int:
    depth = 0
    current = candidate
    seen = {candidate.id}
    while current.parent_id and depth < limit:
        parent = by_id.get(current.parent_id)
        if parent is None or parent.id in seen:
            break
        seen.add(parent.id)
        current = parent
        depth += 1
    return depth


def _descendant_alpha(candidate: Candidate, by_id: dict[str, Candidate]) -> np.ndarray | None:
    result: np.ndarray | None = None
    for other in by_id.values():
        if other.id == candidate.id or other.alpha is None:
            continue
        node = other
        seen = {other.id}
        while node.parent_id:
            if node.parent_id == candidate.id:
                result = other.alpha if result is None else np.maximum(result, other.alpha)
                break
            parent = by_id.get(node.parent_id)
            if parent is None or parent.id in seen:
                break
            seen.add(parent.id)
            node = parent
    return result


def apply_exclusive(candidates: list[Candidate]) -> None:
    """把子孙层的 alpha 从父层减掉，使叠加结果接近原图。"""
    by_id = {item.id: item for item in candidates}
    for candidate in candidates:
        if candidate.alpha is None:
            continue
        descendants = _descendant_alpha(candidate, by_id)
        if descendants is None:
            continue
        candidate.alpha = np.clip(
            candidate.alpha.astype(np.int16) - descendants.astype(np.int16), 0, 255
        ).astype(np.uint8)


def order_layers(candidates: list[Candidate], exclusive: bool = False) -> list[Candidate]:
    """去重 → 建森林 → 排序 → 写 z（1 为最底层）。返回按 z 升序（从后到前）的列表。"""
    kept = dedupe(candidates)
    assign_parents(kept)
    by_id = {item.id: item for item in kept}
    limit = len(kept) + 1

    def sort_key(item: Candidate) -> tuple[int, int, int, int]:
        return (
            _depth(item, by_id, limit),
            CATEGORY_RANK.get(item.category, 4),
            -box_area(item.box),
            item.box[1],
        )

    kept.sort(key=sort_key)
    for index, item in enumerate(kept, start=1):
        item.z = index

    if exclusive:
        apply_exclusive(kept)
    return kept