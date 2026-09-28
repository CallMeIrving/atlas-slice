"""权重下载与体积校验。

三件必须守住的事：
1. ``HF_ENDPOINT`` 必须在 ``import huggingface_hub`` **之前**设好——默认 endpoint 在导入期读取；
2. 只拉 safetensors 一系，过滤掉同仓库重复的 ``pytorch_model.bin`` / ``tf_model.h5``
   （三件套 1.5GB vs 全量 3.3GB）；
3. 体积不符只作提示，不作为失败判定——上游改版或估算偏差不该让下载「看起来失败」。
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Callable

DEFAULT_HOST = "https://hf-mirror.com"

"""快照里的冗余权重格式；safetensors 永远优先，其余一律不下。"""
IGNORED_PATTERNS = ("*.bin", "*.h5", "*.msgpack", "*.ot")

# 关键顺序：先落 HF_ENDPOINT，再导入 huggingface_hub
os.environ.setdefault("HF_ENDPOINT", os.environ.get("MODEL_HOST") or DEFAULT_HOST)

from huggingface_hub import snapshot_download  # noqa: E402
from tqdm.auto import tqdm  # noqa: E402

from ..errors import invalid_params  # noqa: E402
from .registry import (  # noqa: E402
    MODEL_FOR_KEY,
    SERVER_MODELS,
    ServerModel,
    model_by_id,
    model_by_repo,
)

ProgressFn = Callable[[float, str], None]


def normalize_host(host: str | None) -> str:
    """补全镜像地址的协议头。

    API 的 ``ModelDownloadRequest.host`` 默认值是 ``hf-mirror.com``（不带协议），
    直接丢给 ``snapshot_download`` 会被当成非法 URL。
    """
    value = (host or DEFAULT_HOST).strip().rstrip("/")
    if value and not value.startswith(("http://", "https://")):
        value = f"https://{value}"
    return value


def resolve_targets(repo: str | None) -> list[ServerModel]:
    """把 ``--repo`` / API 的 repo 参数解析成模型清单。

    接受 ``all``（或空）、角色键（``detect`` / ``detect:florence2`` / ``segment`` / ``ocr``）、
    登记项 id 与 HF 仓库名。必须认得 id 与仓库名——``MODEL_MISSING`` 的 hint 会把
    ``ROLE_LABELS`` 里的模型 id 拼进 ``--repo=``，那条命令要能直接跑。
    """
    key = (repo or "all").strip()
    if not key or key.lower() == "all":
        return list(SERVER_MODELS)
    if key in MODEL_FOR_KEY:
        model = model_by_id(MODEL_FOR_KEY[key])
        return [model] if model is not None else []
    model = model_by_id(key) or model_by_repo(key)
    if model is not None:
        return [model]
    raise invalid_params(
        f"未知的权重目标：{repo}",
        {"valid": ["all", *MODEL_FOR_KEY, *(item.id for item in SERVER_MODELS)]},
    )


def verify_model(model: ServerModel, models_dir: Path | str) -> list[str]:
    """逐文件比对体积，返回「体积不符」的描述列表。

    **文件缺失不在这里报**——那属于「是否就位」，由 ``ModelManager.missing`` 负责，
    两条信息混在一起会让调用方分不清「没下」和「下残了」。
    """
    root = Path(models_dir) / model.repo_id
    issues: list[str] = []
    for spec in model.files:
        try:
            actual = (root / spec.file).stat().st_size
        except OSError:
            continue
        if spec.size and actual != spec.size:
            issues.append(f"{spec.file} 期望 {spec.size} 字节，实际 {actual}")
    return issues


def download_repo(
    model: ServerModel,
    *,
    models_dir: Path | str,
    host: str | None = None,
    force: bool = False,
    progress: ProgressFn | None = None,
) -> tuple[Path, str | None]:
    """下载单个仓库到 ``models_dir/<repo_id>``。

    返回 ``(落地目录, 提示语)``；提示语为 None 表示既没缺文件也没体积异常。
    网络/鉴权/磁盘类异常不吞——由调用方决定是「作业失败」还是「脚本退出码 1」。
    """
    target = Path(models_dir) / model.repo_id
    target.mkdir(parents=True, exist_ok=True)

    # 进度换算：snapshot_download 会给「整个快照」和「每个文件」各建一根字节进度条。
    # 每根条各自记录已见最大 n 再求和，既避免文件级进度条把百分比来回拉，也兼容重试与乱序完成；
    # 总和用登记体积作分母，本地多出的 README/.gitattributes 会让结果略微超过 1，封顶即可。
    expected = sum(spec.size for spec in model.files) or 1
    seen: dict[int, int] = {}

    def on_bar_update(bar: object, value: int) -> None:
        if progress is None:
            return
        seen[id(bar)] = max(seen.get(id(bar), 0), value)
        progress(min(1.0, sum(seen.values()) / expected), f"正在下载 {model.label}…")

    class _ByteTqdm(tqdm):  # type: ignore[misc]
        def update(self, n: int = 1):  # noqa: ANN201
            result = super().update(n)
            on_bar_update(self, int(self.n))
            return result

    if progress is not None:
        progress(0.0, f"开始下载 {model.label}…")

    snapshot_download(
        repo_id=model.repo_id,
        local_dir=str(target),
        endpoint=normalize_host(host),
        force_download=force,
        ignore_patterns=list(IGNORED_PATTERNS),
        tqdm_class=_ByteTqdm,
    )

    if progress is not None:
        progress(1.0, f"{model.label} 下载完成")

    missing = [spec.file for spec in model.files if spec.required and not (target / spec.file).exists()]
    parts: list[str] = []
    if missing:
        parts.append("以下文件未落地：" + "、".join(missing))
    issues = verify_model(model, models_dir)
    if issues:
        # 体积只用来提示「可能是中断留下的残缺文件」，不阻断可用性
        parts.append("体积不符（仅提示）：" + "；".join(issues))
    return target, "；".join(parts) if parts else None