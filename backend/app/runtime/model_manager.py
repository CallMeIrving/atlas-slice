"""模型权重的就位检测与懒加载。

两条硬规则：
1. 加载一律 ``local_files_only=True``——权重缺失时明确报 ``MODEL_MISSING``，**不静默回退到远程**，
   也不允许把 segmenter 悄悄降级成 none 后返回半成品。
2. **阶段间互斥驻留**——GroundingDINO + SAM 同时驻留 + 1024² 激活在 Apple Silicon 统一内存下
   峰值可达 3-4GB，容易触发 swap，因此加载某个角色时先卸载其它角色（由 ``load`` 自动完成）。
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable

from ..config import Settings
from ..errors import ApiError, invalid_params, model_load_failed, model_missing
from .device import empty_cache, resolve_device, resolve_dtype
from ..models.registry import (
    MODEL_FOR_KEY,
    ROLE_LABELS,
    SERVER_MODELS,
    ServerModel,
    model_by_id,
    model_by_role,
)

BackendFactory = Callable[[str, Path, Any, Any], Any]


class ModelManager:
    def __init__(self, settings: Settings, factory: BackendFactory | None = None) -> None:
        self._settings = settings
        self._factory = factory or _default_factory
        self._loaded: dict[str, Any] = {}
        self._errors: dict[str, str] = {}
        self._device: Any | None = None

    # ---------- 路径与状态 ----------

    @property
    def models_dir(self) -> Path:
        return Path(self._settings.models_dir)

    def dir_for(self, model: ServerModel) -> Path:
        return self.models_dir / model.repo_id

    def inspect_file(self, model: ServerModel, spec: Any) -> dict[str, Any]:
        path = self.dir_for(model) / spec.file
        try:
            actual = path.stat().st_size
            present = True
        except OSError:
            actual = 0
            present = False
        return {
            "file": spec.file,
            "size": spec.size,
            "present": present,
            "actual_size": actual,
            "required": spec.required,
        }

    def missing(self, model: ServerModel) -> list[str]:
        """硬性缺失（required 且不存在）。体积不符只影响展示，不阻断可用性。"""
        result = []
        for spec in model.files:
            if not spec.required:
                continue
            if not (self.dir_for(model) / spec.file).exists():
                result.append(spec.file)
        return result

    def is_installed(self, model: ServerModel) -> bool:
        return not self.missing(model)

    def status(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for model in SERVER_MODELS:
            files = [self.inspect_file(model, spec) for spec in model.files]
            out.append(
                {
                    "id": model.id,
                    "role": model.role,
                    "label": model.label,
                    "repo_id": model.repo_id,
                    "dir": str(self.dir_for(model)),
                    "installed": self.is_installed(model),
                    "loaded": self.is_loaded(model.role),
                    "load_error": self._errors.get(model.role),
                    "optional": model.optional,
                    "approx_bytes": model.approx_bytes,
                    "files": files,
                    "missing": self.missing(model),
                    "note": model.note,
                }
            )
        return out

    def models_ready(self) -> bool:
        """检测与分割都就位才算可跑主流程。"""
        ready = True
        for role in ("detect", "segment"):
            model = model_by_role(role)
            ready = ready and model is not None and self.is_installed(model)
        return ready

    # ---------- 设备 ----------

    def device(self) -> Any:
        if self._device is None:
            self._device = resolve_device(self._settings.device)
        return self._device

    def dtype(self) -> Any:
        return resolve_dtype(self.device())

    # ---------- 加载 / 卸载 ----------

    def is_loaded(self, role: str) -> bool:
        return role in self._loaded

    def loaded_backend(self, role: str) -> Any | None:
        return self._loaded.get(role)

    def require(self, role: str) -> Any:
        """取已加载的后端；未加载则加载。权重缺失时抛 MODEL_MISSING。"""
        if role in self._loaded:
            return self._loaded[role]
        return self.load(role)[0]

    def load(self, role: str) -> tuple[Any, int]:
        key = (role or "").strip().lower()
        model_id = MODEL_FOR_KEY.get(key)
        if model_id is None:
            raise invalid_params(f"未知模型角色：{role}", {"valid": list(MODEL_FOR_KEY)})
        if key in self._loaded:
            return self._loaded[key], 0

        model = model_by_id(model_id)
        if model is None:  # pragma: no cover - MODEL_FOR_KEY 已保证存在
            raise invalid_params(f"角色 {key} 没有登记模型")
        missing = self.missing(model)
        if missing:
            raise model_missing(model.repo_id, ROLE_LABELS.get(key, key), missing)

        # 互斥驻留：先腾出内存再加载，避免两个大模型同时占着统一内存
        self.unload_others(key)

        started = time.perf_counter()
        try:
            backend = self._factory(key, self.dir_for(model), self.device(), self.dtype())
        except ApiError:
            raise
        except Exception as exc:
            self._errors[key] = str(exc)
            raise model_load_failed(model.repo_id, str(exc)) from exc
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        self._loaded[key] = backend
        self._errors.pop(key, None)
        return backend, elapsed_ms

    def unload(self, role: str) -> bool:
        key = (role or "").strip().lower()
        existed = self._loaded.pop(key, None) is not None
        if existed:
            empty_cache(self._device)
        return existed

    def unload_others(self, keep: str) -> None:
        for role in list(self._loaded):
            if role != keep:
                self.unload(role)

    def unload_all(self) -> None:
        for role in list(self._loaded):
            self.unload(role)


def _default_factory(role: str, model_dir: Path, device: Any, dtype: Any) -> Any:
    """按角色构造真实后端。重依赖延迟到这一刻才 import。"""
    if role == "detect":
        from ..pipeline.detect_grounding_dino import GroundingDinoDetector

        return GroundingDinoDetector(model_dir, device, dtype)
    if role == "detect:florence2":
        from ..pipeline.detect_florence2 import Florence2Detector

        return Florence2Detector(model_dir, device, dtype)
    if role == "segment":
        from ..pipeline.segment_sam import SamSegmenter

        return SamSegmenter(model_dir, device, dtype)
    if role == "ocr":
        from ..pipeline.ocr_florence2 import Florence2Ocr

        return Florence2Ocr(model_dir, device, dtype)
    raise invalid_params(f"未知模型角色：{role}")