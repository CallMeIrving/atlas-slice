"""作业调度：单 worker 串行执行 + 协作式取消 + TTL 清理。

为什么不并行：GroundingDINO + SAM 的峰值内存已经把 Apple Silicon 的统一内存吃得很紧，
并行只会同时触发 swap。队列上限默认 4，超出返回 429。

作业只存在内存里，进程重启即失效——前端拿到 ``JOB_NOT_FOUND`` 时应回到「待处理」态并提示重新拆分。
"""

from __future__ import annotations

import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from ..config import Settings
from ..errors import job_not_found, queue_full
from .storage import cleanup_expired, create_job_dir, remove_job_dir

"""阶段权重：加起来等于 1，用于把「阶段内进度」折算成整体百分比"""
STAGE_WEIGHTS: tuple[tuple[str, float], ...] = (
    ("detect", 0.35),
    ("ocr", 0.10),
    ("segment", 0.30),
    ("refine", 0.10),
    ("zorder", 0.05),
    ("background", 0.07),
    ("export", 0.03),
)
STAGE_ORDER: tuple[str, ...] = tuple(name for name, _ in STAGE_WEIGHTS)
_STAGE_WEIGHT_MAP = dict(STAGE_WEIGHTS)
_STAGE_INDEX = {name: index for index, name in enumerate(STAGE_ORDER)}


class JobCancelled(Exception):
    """协作式取消：管线在阶段边界与元素循环里检查取消标志后抛出。"""


def overall_progress(stage: str, fraction: float) -> float:
    """把阶段内进度折算成整体百分比。

    不在 ``STAGE_WEIGHTS`` 里的阶段（例如模型下载作业）直接用自身比例当作整体进度。
    """
    clamped = max(0.0, min(1.0, float(fraction)))
    index = _STAGE_INDEX.get(stage)
    if index is None:
        return round(clamped, 4)
    before = sum(weight for _, weight in STAGE_WEIGHTS[:index])
    return round(before + _STAGE_WEIGHT_MAP[stage] * clamped, 4)


def new_job_id() -> str:
    return f"{time.strftime('%Y%m%dT%H%M%S', time.localtime())}-{uuid.uuid4().hex[:6]}"


@dataclass
class JobRecord:
    job_id: str
    kind: str
    runner: Callable[[JobHandle], None] | None = None
    status: str = "queued"
    stage: str = "queued"
    stage_progress: float = 0.0
    progress: float = 0.0
    message: str = ""
    stages: list[dict[str, Any]] = field(default_factory=list)
    image: dict[str, Any] | None = None
    error: str | None = None
    warnings: list[str] = field(default_factory=list)
    counts: dict[str, int] | None = None
    layers: list[dict[str, Any]] | None = None
    background: dict[str, Any] | None = None
    manifest_url: str | None = None
    zip_url: str | None = None
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    cancel: threading.Event = field(default_factory=threading.Event)
    dir: Path | None = None
    cancel_requested: bool = False
    position: int = 0

    def elapsed_ms(self) -> int:
        if self.started_at is None:
            return 0
        end = self.finished_at if self.finished_at is not None else time.time()
        return int((end - self.started_at) * 1000)

    def accepted(self) -> dict[str, Any]:
        """``POST`` 提交后的即时回执（与 ``SplitAccepted`` 字段一致）。"""
        return {
            "job_id": self.job_id,
            "status": self.status,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(self.created_at)),
            "position": self.position,
        }

    def to_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "job_id": self.job_id,
            "status": self.status,
            "stage": self.stage,
            "stage_progress": round(self.stage_progress, 4),
            "progress": self.progress,
            "message": self.message,
            "stages": list(self.stages),
            "image": self.image,
            "error": self.error,
            "elapsed_ms": self.elapsed_ms(),
            "position": self.position,
            "warnings": list(self.warnings),
        }
        # 图层只在成功时内联，避免每次轮询搬运几十 KB
        if self.status == "succeeded":
            payload.update(
                {
                    "layers": self.layers or [],
                    "background": self.background,
                    "counts": self.counts or {},
                    "manifest_url": self.manifest_url,
                    "zip_url": self.zip_url,
                }
            )
        return payload


class JobHandle:
    """交给 runner 的句柄：上报进度、检查取消、写回结果。"""

    def __init__(self, record: JobRecord) -> None:
        self.record = record

    @property
    def job_id(self) -> str:
        return self.record.job_id

    @property
    def dir(self) -> Path:
        if self.record.dir is None:  # pragma: no cover - submit 时必定创建
            raise RuntimeError("作业目录未初始化")
        return self.record.dir

    def progress(self, stage: str, fraction: float, message: str = "") -> None:
        record = self.record
        record.stage = stage
        record.stage_progress = max(0.0, min(1.0, float(fraction)))
        if message:
            record.message = message
        record.progress = overall_progress(stage, record.stage_progress)
        record.stages = [item for item in record.stages if item["stage"] != stage]
        record.stages.append(
            {
                "stage": stage,
                "progress": record.stage_progress,
                "elapsed_ms": record.elapsed_ms(),
            }
        )

    def raise_if_cancelled(self) -> None:
        if self.record.cancel.is_set():
            raise JobCancelled()

    def note(self, message: str) -> None:
        self.record.message = message

    def warn(self, message: str) -> None:
        self.record.warnings.append(message)

    def set_image(self, info: dict[str, Any]) -> None:
        self.record.image = info

    def set_layers(self, layers: list[dict[str, Any]], counts: dict[str, int]) -> None:
        self.record.layers = layers
        self.record.counts = counts

    def set_background(self, background: dict[str, Any] | None) -> None:
        self.record.background = background

    def set_urls(self, manifest: str | None, bundle: str | None) -> None:
        self.record.manifest_url = manifest
        self.record.zip_url = bundle


class JobManager:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._jobs: dict[str, JobRecord] = {}
        self._queue: queue.Queue[str] = queue.Queue()
        self._lock = threading.Lock()
        self._worker = threading.Thread(target=self._loop, name="layer-split-worker", daemon=True)
        self._worker.start()

    # ---------- 对外 ----------

    def queue_depth(self) -> int:
        with self._lock:
            return sum(1 for record in self._jobs.values() if record.status == "queued")

    def submit(
        self,
        *,
        kind: str,
        runner: Callable[[JobHandle], None],
        message: str = "已排队",
    ) -> JobRecord:
        self._cleanup_expired()
        with self._lock:
            depth = sum(1 for item in self._jobs.values() if item.status == "queued")
            if depth >= self._settings.max_queue:
                raise queue_full(self._settings.max_queue)
            self._evict_locked()
            record = JobRecord(job_id=new_job_id(), kind=kind, runner=runner, message=message)
            record.dir = create_job_dir(self._settings.tmp_dir, record.job_id)
            record.position = depth
            self._jobs[record.job_id] = record
        self._queue.put(record.job_id)
        return record

    def get(self, job_id: str) -> JobRecord:
        with self._lock:
            record = self._jobs.get(job_id)
        if record is None:
            raise job_not_found(job_id)
        return record

    def cancel(self, job_id: str) -> JobRecord:
        record = self.get(job_id)
        if record.status in ("succeeded", "failed", "cancelled"):
            return record
        record.cancel_requested = True
        record.cancel.set()
        record.message = "已请求取消"
        return record

    def shutdown(self) -> None:
        self._queue.put("__stop__")
        self._worker.join(timeout=2)

    # ---------- 内部 ----------

    def _loop(self) -> None:
        while True:
            job_id = self._queue.get()
            if job_id == "__stop__":
                return
            with self._lock:
                record = self._jobs.get(job_id)
            if record is None:
                continue
            self._run(record)

    def _run(self, record: JobRecord) -> None:
        if record.cancel.is_set():
            record.status = "cancelled"
            record.finished_at = time.time()
            record.message = "已取消"
            return

        record.status = "running"
        record.started_at = time.time()
        record.position = 0
        handle = JobHandle(record)
        try:
            if record.runner is None:
                raise RuntimeError("作业缺少执行体")
            record.runner(handle)
            record.status = "succeeded"
        except JobCancelled:
            record.status = "cancelled"
            record.message = "已取消"
        except Exception as exc:  # 业务的 ApiError 与未知异常都在这里收敛
            from ..errors import ApiError, out_of_memory  # noqa: PLC0415
            from .device import is_out_of_memory  # noqa: PLC0415

            if isinstance(exc, ApiError):
                record.status = "failed"
                record.error = exc.message
                record.warnings.extend(
                    str(value) for value in [exc.detail.get("hint")] if exc.detail.get("hint")
                )
            elif is_out_of_memory(exc):
                mapped = out_of_memory(suggested_max_side=1024)
                record.status = "failed"
                record.error = mapped.message
            else:
                record.status = "failed"
                record.error = str(exc)
        finally:
            record.finished_at = time.time()
            record.runner = None
            if record.status == "succeeded":
                record.progress = 1.0
                record.stage = "done"
                record.stage_progress = 1.0
            self._cleanup_expired()

    def _cleanup_expired(self) -> None:
        deadline = time.time() - self._settings.job_ttl_seconds
        with self._lock:
            expired = [
                job_id
                for job_id, record in self._jobs.items()
                if record.finished_at is not None and record.finished_at < deadline
            ]
            for job_id in expired:
                self._jobs.pop(job_id, None)
        for job_id in expired:
            remove_job_dir(self._settings.tmp_dir, job_id)
        cleanup_expired(self._settings.tmp_dir, self._settings.job_ttl_seconds)

    def _evict_locked(self) -> None:
        """超出保留上限时按创建时间淘汰已结束的作业（调用方需持有锁）。"""
        if len(self._jobs) < self._settings.max_jobs_kept:
            return
        finished = sorted(
            (record for record in self._jobs.values() if record.finished_at is not None),
            key=lambda item: item.created_at,
        )
        while len(self._jobs) >= self._settings.max_jobs_kept and finished:
            victim = finished.pop(0)
            self._jobs.pop(victim.job_id, None)
            if victim.dir is not None:
                remove_job_dir(self._settings.tmp_dir, victim.job_id)