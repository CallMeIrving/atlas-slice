"""Florence-2 后端共用的加载与解析逻辑。

Florence-2 依赖 remote code（``configuration_/modeling_/processing_florence2.py``），
因此 ``trust_remote_code=True`` 且必须整仓落地权重；沿用项目既有策略，
``local_files_only=True`` 拒绝任何远程回退。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from PIL import Image

TASK_OCR = "<OCR_WITH_REGION>"
TASK_OD = "<OPEN_VOCABULARY_DETECTION>"


class Florence2Base:
    def __init__(self, model_dir: Path, device: Any, dtype: Any) -> None:
        import torch  # noqa: PLC0415
        from transformers import AutoModelForCausalLM, AutoProcessor  # noqa: PLC0415

        self._torch = torch
        self._device = device
        self._dtype = dtype
        self._processor = AutoProcessor.from_pretrained(
            str(model_dir), trust_remote_code=True, local_files_only=True
        )
        self._model = AutoModelForCausalLM.from_pretrained(
            str(model_dir),
            trust_remote_code=True,
            local_files_only=True,
            torch_dtype=dtype,
        )
        self._model.to(device)
        self._model.eval()

    def _generate(self, image: Image.Image, prompt: str, max_new_tokens: int = 1024) -> str:
        inputs = self._processor(text=prompt, images=image, return_tensors="pt").to(self._device)
        with self._torch.no_grad():
            generated = self._model.generate(
                input_ids=inputs["input_ids"],
                pixel_values=inputs["pixel_values"],
                max_new_tokens=max_new_tokens,
                num_beams=3,
                do_sample=False,
            )
        return self._processor.batch_decode(generated, skip_special_tokens=False)[0]

    def _parse(self, text: str, task: str, image: Image.Image) -> dict[str, Any]:
        parsed = self._processor.post_process_generation(
            text, task=task, image_size=(image.width, image.height)
        )
        if isinstance(parsed, dict) and task not in parsed and len(parsed) == 1:
            parsed = next(iter(parsed.values()))
        return parsed if isinstance(parsed, dict) else {}


def extract_boxes(parsed: dict[str, Any]) -> tuple[list[list[float]], list[str]]:
    """兼容不同 transformers 版本的键名（bboxes / polygons）。"""
    boxes = parsed.get("bboxes") or parsed.get("polygons") or []
    labels = parsed.get("bboxes_labels") or parsed.get("polygons_labels") or []
    normalized: list[list[float]] = []
    for box in boxes:
        if len(box) == 4:  # 已经是 xyxy
            normalized.append([float(value) for value in box])
        elif len(box) >= 8:  # 四边形：取包围盒
            xs = [float(box[index]) for index in range(0, 8, 2)]
            ys = [float(box[index]) for index in range(1, 8, 2)]
            normalized.append([min(xs), min(ys), max(xs), max(ys)])
    return normalized, [str(item) for item in labels]