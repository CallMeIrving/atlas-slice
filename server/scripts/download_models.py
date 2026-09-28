#!/usr/bin/env python3
"""下载 / 校验推理权重。

用法：
    python scripts/download_models.py                          # 全部，镜像 hf-mirror.com
    python scripts/download_models.py --repo=detect            # 只下检测器
    python scripts/download_models.py --host=https://hf-mirror.com --force
    python scripts/download_models.py --list                   # 只看清单与就位情况
    python scripts/download_models.py --check                  # 只校验体积/存在性，失败退出码 1

权重落在 ``server/models/<repo_id>/``，与浏览器侧 ``public/models/`` 完全是两套。
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import Settings  # noqa: E402
from app.models.download import (  # noqa: E402
    DEFAULT_HOST,
    download_repo,
    resolve_targets,
    verify_model,
)
from app.models.registry import ServerModel  # noqa: E402
from app.runtime.model_manager import ModelManager  # noqa: E402


def format_bytes(value: int) -> str:
    if value >= 1024**3:
        return f"{value / 1024**3:.2f}GB"
    if value >= 1024**2:
        return f"{value / 1024**2:.1f}MB"
    return f"{value}B"


def make_reporter(model: ServerModel):
    last = -1

    def report(fraction: float, message: str) -> None:
        nonlocal last
        percent = int(fraction * 100)
        if percent != last:
            last = percent
            print(f"\r  {model.role:<8} {message} {percent:3d}%", end="", flush=True)

    return report


def describe(models: ModelManager, model: ServerModel) -> tuple[list[str], list[str]]:
    return models.missing(model), verify_model(model, models.models_dir)


def print_table(models: ModelManager, targets: list[ServerModel]) -> bool:
    """打印清单与就位情况；返回是否全部就绪。"""
    ok = True
    print(f"权重目录：{models.models_dir}")
    for model in targets:
        missing, size_issues = describe(models, model)
        marker = "就位" if not missing else "缺失"
        print(f"  [{marker}] {model.role:<8} {model.id:<20} {model.repo_id}  约 {format_bytes(model.approx_bytes)}")
        if model.optional:
            print("            （可选：不装也能跑，文本层会退化成矩形范围）")
        for name in missing:
            print(f"            - 缺少 {name}")
            ok = False
        for issue in size_issues:
            # 体积只用来提示「可能是中断留下的残缺文件」，不作为可用性判定：
            # 上游改版或估算值有偏差时不应该让脚本失败
            print(f"            - 体积不符（仅提示）{issue}")
    return ok


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="下载 / 校验图层拆分所需的推理权重")
    parser.add_argument("--repo", default="all", help="all | detect | segment | ocr | 模型 id")
    parser.add_argument("--host", default=os.environ.get("MODEL_HOST") or DEFAULT_HOST)
    parser.add_argument("--force", action="store_true", help="忽略本地已有文件，强制重新下载")
    parser.add_argument("--models-dir", default="", help="覆盖权重目录（默认 server/models）")
    parser.add_argument("--list", action="store_true", help="只打印清单与就位情况")
    parser.add_argument("--check", action="store_true", help="只校验，不做下载")
    args = parser.parse_args(argv)

    settings = Settings(models_dir=args.models_dir) if args.models_dir else Settings()
    targets = resolve_targets(args.repo)
    models = ModelManager(settings)

    if args.list or args.check:
        return 0 if print_table(models, targets) else 1

    print(f"镜像源：{args.host}    权重目录：{settings.models_dir}")
    for model in targets:
        try:
            local_dir, warning = download_repo(
                model,
                models_dir=settings.models_dir,
                host=args.host,
                force=args.force,
                progress=make_reporter(model),
            )
        except Exception as exc:  # 网络/鉴权/磁盘：报错即停，避免"看起来成功"
            print(f"\n  {model.id} 下载失败：{exc}")
            return 1
        print()
        if warning:
            print(f"  注意：{warning}")
        print(f"  完成 → {local_dir}")

    print()
    return 0 if print_table(models, targets) else 1


if __name__ == "__main__":
    raise SystemExit(main())