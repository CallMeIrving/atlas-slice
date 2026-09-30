"""Florence-2 OCR：``<OCR_WITH_REGION>`` 输出四边形文本框 + 文本内容。

四边形比矩形准得多——UI 里相邻的文本格子常常紧挨着，矩形框会把邻格的字带进来。
"""

from __future__ import annotations

from typing import Any

from PIL import Image

from .backends import TextRegion
from .florence2_common import TASK_OCR, Florence2Base


class Florence2Ocr(Florence2Base):
    def read(self, image: Image.Image) -> list[TextRegion]:
        text = self._generate(image, TASK_OCR, max_new_tokens=2048)
        parsed = self._parse(text, TASK_OCR, image)
        quads = parsed.get("quad_boxes") or parsed.get("polygons") or []
        labels: list[Any] = parsed.get("labels") or []
        regions: list[TextRegion] = []
        for index, quad in enumerate(quads):
            points = self._to_points(quad)
            if len(points) < 3:
                continue
            content = str(labels[index]).strip() if index < len(labels) else ""
            regions.append(TextRegion(text=content, quad=points))
        return regions

    @staticmethod
    def _to_points(quad: Any) -> list[tuple[int, int]]:
        values = [float(item) for item in quad]
        if len(values) >= 8:
            return [
                (int(round(values[index])), int(round(values[index + 1])))
                for index in range(0, 8, 2)
            ]
        if len(values) == 4:
            x1, y1, x2, y2 = values
            return [
                (int(round(x1)), int(round(y1))),
                (int(round(x2)), int(round(y1))),
                (int(round(x2)), int(round(y2))),
                (int(round(x1)), int(round(y2))),
            ]
        return []