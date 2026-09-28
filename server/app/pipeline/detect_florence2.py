"""Florence-2 作为开放词表检测器（``<OPEN_VOCABULARY_DETECTION>``）。

当 GroundingDINO 未安装、或用户想换一套词表行为时使用。
按类别逐个生成——比一次多类更可预测；单次生成很轻，代价可以接受。
"""

from __future__ import annotations

from typing import Sequence

from PIL import Image

from .backends import Box, Detection, clamp_box
from .florence2_common import TASK_OD, Florence2Base, extract_boxes
from .detect_grounding_dino import normalize_prompt


class Florence2Detector(Florence2Base):
    def detect(
        self,
        image: Image.Image,
        classes: Sequence[dict[str, str]],
        box_threshold: float,
        text_threshold: float,
    ) -> list[Detection]:
        detections: list[Detection] = []
        for spec in classes:
            prompt = normalize_prompt(str(spec.get("prompt") or spec.get("label") or ""))
            if not prompt:
                continue
            generated = self._generate(image, f"{TASK_OD}{prompt}", max_new_tokens=1024)
            parsed = self._parse(generated, TASK_OD, image)
            boxes, _labels = extract_boxes(parsed)
            for raw in boxes:
                box: Box = clamp_box(
                    (int(round(raw[0])), int(round(raw[1])), int(round(raw[2])), int(round(raw[3]))),
                    image.width,
                    image.height,
                )
                if box[2] - box[0] < 1 or box[3] - box[1] < 1:
                    continue
                detections.append(
                    Detection(
                        label=str(spec.get("label") or prompt),
                        prompt=str(spec.get("prompt") or prompt),
                        category=str(spec.get("category") or "other"),
                        # Florence-2 不返回置信度，用框阈值语义下的固定值占位
                        score=float(max(0.0, min(1.0, box_threshold))),
                        box=box,
                    )
                )
        return detections