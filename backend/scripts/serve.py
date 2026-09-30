#!/usr/bin/env python3
"""冻结版（PyInstaller）后端启动器。

打包后模块都在归档里，不能再靠 ``uvicorn app.main:app`` 的字符串导入，因此这里直接
拿到应用对象再交给 uvicorn 跑。host/port 优先取命令行（主进程会传动态端口），
其次回落到 ``LAYER_SPLIT_HOST`` / ``LAYER_SPLIT_PORT``（config.py 的 Settings 已支持）。

开发态仍可用 ``python scripts/serve.py --port 8000`` 直接起服务，行为与
``uvicorn app.main:app`` 一致。
"""

from __future__ import annotations

import argparse
import multiprocessing
import sys
from pathlib import Path

import uvicorn

# 开发态直接执行本脚本时（backend/scripts 在 sys.path 上）补上 backend/，冻结态无副作用
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import get_settings  # noqa: E402
from app.main import app  # noqa: E402


def main() -> None:
    settings = get_settings()
    parser = argparse.ArgumentParser(description="AtlasSlice 图层拆分服务")
    parser.add_argument("--host", default=settings.host)
    parser.add_argument("--port", type=int, default=settings.port)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level=settings.log_level)


if __name__ == "__main__":
    # 冻结后子进程会重新执行本入口，需先剥离 PyInstaller 的启动参数
    multiprocessing.freeze_support()
    main()