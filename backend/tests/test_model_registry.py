"""两份模型清单的防漂移校验。

浏览器清单（``src/core/model-registry.json``）与后端清单（``app.models.registry``）
描述的是**互不相交**的模型集合：「统一」落在同一个模型目录 + 同一个管理界面 +
同一个按需下载入口，而不是同一份数据。

两份并存本身没问题，前提是同一个 HF 仓库不能同时登记在两边 —— 否则体积与文件
登记会互相打架，权重还会被重复下载到同一目录。这个用例把那条约束固化下来。
"""

from __future__ import annotations

import json
from pathlib import Path

from app.config import SERVER_ROOT
from app.models.registry import SERVER_MODELS

BROWSER_REGISTRY: Path = SERVER_ROOT.parent / "src" / "core" / "model-registry.json"


def browser_repo_ids() -> set[str]:
    """浏览器清单里登记的 HF 仓库 id。"""
    data = json.loads(BROWSER_REGISTRY.read_text("utf-8"))
    return {repo["id"] for repo in data["repos"]}


def test_browser_and_server_manifests_are_disjoint():
    shared = browser_repo_ids() & {model.repo_id for model in SERVER_MODELS}
    assert not shared, (
        "同一个 HF 仓库不能同时登记在两份清单里（会重复下载、体积登记互相打架）："
        f"{sorted(shared)}；请只保留在其中一份。"
    )