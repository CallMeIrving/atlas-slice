"""作业产物的落盘与路径校验。

外部输入（job_id / layer_id）必须先过正则才能拼路径，避免目录穿越。
PNG / JSON 一律「先写 .part 再改名」，中断不会留下半截文件。
"""

from __future__ import annotations

import json
import re
import shutil
import time
from pathlib import Path
from typing import Any

from ..errors import ApiError

JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
LAYER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


def safe_name(value: str, pattern: re.Pattern[str], kind: str) -> str:
    if not pattern.match(value or ""):
        raise ApiError("INVALID_PARAMS", f"非法{kind}：{value}", 400, {"value": value})
    return value


def safe_job_id(job_id: str) -> str:
    return safe_name(job_id, JOB_ID_RE, "job_id")


def safe_layer_id(layer_id: str) -> str:
    return safe_name(layer_id, LAYER_ID_RE, "layer_id")


def jobs_root(tmp_dir: Path) -> Path:
    root = tmp_dir / "jobs"
    root.mkdir(parents=True, exist_ok=True)
    return root


def job_dir(tmp_dir: Path, job_id: str) -> Path:
    return jobs_root(tmp_dir) / safe_job_id(job_id)


def create_job_dir(tmp_dir: Path, job_id: str) -> Path:
    path = job_dir(tmp_dir, job_id)
    (path / "layers").mkdir(parents=True, exist_ok=True)
    return path


def remove_job_dir(tmp_dir: Path, job_id: str) -> None:
    shutil.rmtree(job_dir(tmp_dir, job_id), ignore_errors=True)


def atomic_write_bytes(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    part.write_bytes(data)
    part.replace(path)


def atomic_write_json(path: Path, payload: Any) -> None:
    atomic_write_bytes(path, json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"))


def cleanup_expired(tmp_dir: Path, ttl_seconds: int) -> int:
    """删除超过 TTL 的作业目录，返回删除数量。"""
    root = jobs_root(tmp_dir)
    deadline = time.time() - ttl_seconds
    removed = 0
    for entry in root.iterdir():
        if not entry.is_dir():
            continue
        try:
            if entry.stat().st_mtime < deadline:
                shutil.rmtree(entry, ignore_errors=True)
                removed += 1
        except OSError:
            continue
    return removed


def cleanup_all(tmp_dir: Path) -> None:
    shutil.rmtree(tmp_dir / "jobs", ignore_errors=True)