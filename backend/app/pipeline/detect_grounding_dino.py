"""GroundingDINO 开放词表检测。

最容易被忽略、也最常导致「跑通但一个框都没有」的一点：**提示词必须小写，且每类以句点分隔**。
漏掉句点时模型不会报错，只是静默返回 0 个框，所以这里统一做归一化，并在空结果时补一条 warning。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Sequence

from PIL import Image

from .backends import Box, Detection

PROMPT_SEPARATOR = " . "


def normalize_prompt(text: str) -> str:
    return " ".join((text or "").strip().lower().split())


def build_prompt(classes: Sequence[dict[str, str]]) -> tuple[str, dict[str, dict[str, str]]]:
    """把类别列表拼成 GroundingDINO 的提示词，并返回「归一化 prompt → 类别」的映射。"""
    mapping: dict[str, dict[str, str]] = {}
    phrases: list[str] = []
    for spec in classes:
        raw = spec.get("prompt") or spec.get("label") or ""
        normalized = normalize_prompt(raw)
        if not normalized:
            continue
        mapping[normalized] = spec
        phrases.append(normalized)
    # 形如 "button . icon . text ." —— 结尾那句点同样是必需的
    prompt = PROMPT_SEPARATOR.join(phrases) + " ." if phrases else ""
    return prompt, mapping


def match_class(label: str, mapping: dict[str, dict[str, str]]) -> dict[str, str] | None:
    """把模型返回的文本片段映射回用户配置的类别；匹配不上时按包含关系兜底。"""
    normalized = normalize_prompt(label)
    if not normalized:
        return None
    if normalized in mapping:
        return mapping[normalized]
    for key, spec in mapping.items():
        if key and (key in normalized or normalized in key):
            return spec
    return None


class GroundingDinoDetector:
    def __init__(self, model_dir: Path, device: Any, dtype: Any) -> None:
        import torch  # noqa: PLC0415
        from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor  # noqa: PLC0415

        self._torch = torch
        self._device = device
        self._dtype = dtype
        self._processor = AutoProcessor.from_pretrained(str(model_dir), local_files_only=True)
        self._model = AutoModelForZeroShotObjectDetection.from_pretrained(
            str(model_dir),
            local_files_only=True,
            torch_dtype=dtype,
        )
        self._model.to(device)
        self._model.eval()

    def detect(
        self,
        image: Image.Image,
        classes: Sequence[dict[str, str]],
        box_threshold: float,
        text_threshold: float,
    ) -> list[Detection]:
        """逐类检测再合并。

        GroundingDINO 的文本编码器在一次塞入 4+ 个差异较大的概念时会注意力溃散，
        典型表现是「不报错但返回 0 个框」。逐类跑能让每个 prompt 独占模型的文本通道，
        代价是推理次数 ×类别数（MPS 上单类约 1-2 秒，可接受）。
        """
        detections: list[Detection] = []
        for spec in classes:
            prompt, mapping = build_prompt([spec])
            if not prompt:
                continue
            inputs = self._processor(images=image, text=prompt, return_tensors="pt").to(self._device)
            with self._torch.no_grad():
                outputs = self._model(**inputs)
            results = self._processor.post_process_grounded_object_detection(
                outputs,
                inputs["input_ids"],
                box_threshold=box_threshold,
                text_threshold=text_threshold,
                target_sizes=[image.size[::-1]],
            )
            if not results:
                continue
            result = results[0]
            scores = result.get("scores")
            boxes = result.get("boxes")
            labels = result.get("labels")
            if labels is None:
                # 4.46 起 labels 取代了旧的 text_labels，这里兼容两种键名
                labels = result.get("text_labels")
            if scores is None or boxes is None or labels is None:
                continue

            for score, box, label in zip(scores.tolist(), boxes.tolist(), list(labels)):
                matched = match_class(str(label), mapping)
                if matched is None:
                    continue
                x1, y1, x2, y2 = (int(round(v)) for v in box)
                if x2 - x1 < 1 or y2 - y1 < 1:
                    continue
                detections.append(
                    Detection(
                        label=str(matched.get("label") or label),
                        prompt=str(matched.get("prompt") or label),
                        category=str(matched.get("category") or "other"),
                        score=float(score),
                        box=Box((x1, y1, x2, y2)),
                    )
                )
        return detections