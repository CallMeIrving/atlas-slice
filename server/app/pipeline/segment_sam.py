"""SAM 精细分割（由检测框驱动）。

SAM 本身没有语义，只有 point / box 提示，所以管线必须是 detect → box → SAM。
一次前向可以传多个框，比逐框循环快数倍。

坐标注意：processor 内部会把图 resize 到 1024，但 ``input_boxes`` 用的是**原图尺度**，
返回的掩膜也由 ``post_process_masks`` 还原回原图尺寸。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Sequence

import numpy as np
from PIL import Image

from .backends import Box


class SamSegmenter:
    def __init__(self, model_dir: Path, device: Any, dtype: Any) -> None:
        import torch  # noqa: PLC0415
        from transformers import SamModel, SamProcessor  # noqa: PLC0415

        self._torch = torch
        self._device = device
        self._dtype = dtype
        self._processor = SamProcessor.from_pretrained(str(model_dir), local_files_only=True)
        self._model = SamModel.from_pretrained(
            str(model_dir),
            local_files_only=True,
            torch_dtype=dtype,
        )
        self._model.to(device)
        self._model.eval()

    def segment(self, image: Image.Image, boxes: Sequence[Box]) -> list[np.ndarray]:
        if not boxes:
            return []
        # SamProcessor 会把 input_boxes 建成 float64，而 MPS 不支持 float64；
        # 所以这里先过 processor，再把所有浮点输入强制转成 float32 才搬到设备
        float_boxes = [[[float(v) for v in box] for box in boxes]]
        inputs = self._processor(image, input_boxes=float_boxes, return_tensors="pt")
        for key, value in list(inputs.items()):
            if hasattr(value, "is_floating_point") and value.is_floating_point():
                inputs[key] = value.to(self._torch.float32)
        inputs = inputs.to(self._device)
        with self._torch.no_grad():
            outputs = self._model(**inputs, multimask_output=False).pred_masks
        masks = self._processor.image_processor.post_process_masks(
            outputs.detach().cpu(),
            inputs["original_sizes"].cpu(),
            inputs["reshaped_input_sizes"].cpu(),
        )
        tensor = masks[0]
        # 形状为 [num_boxes, num_masks, H, W]；multimask_output=False 时 num_masks = 1
        array = tensor.squeeze(1).numpy() if tensor.dim() == 4 else tensor.numpy()
        return [np.asarray(array[index] > 0, dtype=bool) for index in range(array.shape[0])]