"""权重清单：本服务所有「需要哪几个仓库、各自要落地哪些文件」的唯一数据源。

两个概念不要混：
- ``role``：管线里的角色（detect / segment / ocr），一个角色只能有登记项，供 ``model_by_role`` 查；
- ``id``：登记项本身。Florence-2 同时顶 ``ocr`` 与 ``detect:florence2`` 两个**键**，
  所以 ``MODEL_FOR_KEY`` 是「键 → id」的映射，与 ``SERVER_MODELS`` 并非一一对应。

``files`` 只登记加载真正会用到的文件（safetensors + 配置 + 分词器），不含同仓库里重复的
``pytorch_model.bin`` / ``tf_model.h5``：那类冗余权重由 ``download`` 的 ``IGNORED_PATTERNS`` 过滤掉，
否则三件套会从 ~1.5GB 涨到 ~3.3GB。Florence-2 的 remote code（三个 .py）必须一起落地，已列进 files。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ModelFile:
    """登记一个文件及其期望体积。"""

    file: str
    size: int
    """权重缺失时的提示语里会用到；False 的文件不参与「是否就位」判定"""
    required: bool = True


@dataclass
class ServerModel:
    """一个可独立加载的权重仓库。"""

    id: str
    role: str
    label: str
    repo_id: str
    files: tuple[ModelFile, ...] = ()
    optional: bool = False
    note: str = ""

    @property
    def approx_bytes(self) -> int:
        """仓库体积按登记文件求和，避免手写常量与 files 漂移。"""
        return sum(spec.size for spec in self.files)


GROUNDING_DINO = ServerModel(
    id="grounding-dino-tiny",
    role="detect",
    label="GroundingDINO 开放词表检测",
    repo_id="IDEA-Research/grounding-dino-tiny",
    files=(
        ModelFile("config.json", 1644),
        ModelFile("model.safetensors", 689359096),
        ModelFile("preprocessor_config.json", 457),
        ModelFile("tokenizer.json", 711396),
        ModelFile("tokenizer_config.json", 1237),
        ModelFile("vocab.txt", 231508),
        ModelFile("special_tokens_map.json", 125),
        ModelFile("added_tokens.json", 82),
    ),
)

SAM = ServerModel(
    id="sam-vit-base",
    role="segment",
    label="SAM 框驱动精细分割",
    repo_id="facebook/sam-vit-base",
    files=(
        ModelFile("config.json", 6566),
        ModelFile("model.safetensors", 374979480),
        ModelFile("preprocessor_config.json", 466),
    ),
    note="权重缺失时仍可拆分，但边缘是检测框的矩形，不会贴合元素。",
)

FLORENCE2 = ServerModel(
    id="florence-2-base-ft",
    role="ocr",
    label="Florence-2 文本识别（兼作备选检测）",
    repo_id="microsoft/Florence-2-base-ft",
    optional=True,
    files=(
        ModelFile("config.json", 2430),
        ModelFile("model.safetensors", 463221266),
        ModelFile("preprocessor_config.json", 806),
        ModelFile("tokenizer.json", 1355863),
        ModelFile("tokenizer_config.json", 34),
        ModelFile("vocab.json", 1099884),
        # remote code：transformers 必须能在本地目录里读到这三个文件
        ModelFile("configuration_florence2.py", 15125),
        ModelFile("modeling_florence2.py", 127415),
        ModelFile("processing_florence2.py", 46372),
    ),
    note="不装也能跑，但文本层会退化成矩形范围，缺少笔画级紧致 alpha。",
)

SERVER_MODELS: tuple[ServerModel, ...] = (GROUNDING_DINO, SAM, FLORENCE2)

"""角色键 → 登记项 id。``detect:florence2`` 与 ``ocr`` 指向同一个仓库。"""
MODEL_FOR_KEY: dict[str, str] = {
    "detect": GROUNDING_DINO.id,
    "detect:florence2": FLORENCE2.id,
    "segment": SAM.id,
    "ocr": FLORENCE2.id,
}

"""角色键 → 实际承载它的模型 id。

``errors.model_missing`` 会把它当成 ``--repo=`` 的值拼进 hint，而下载脚本既认角色键也认模型 id，
所以这里放模型 id 才能保证 hint 可以直接复制执行；README.txt 也用它列出「各角色模型」。
"""
ROLE_LABELS: dict[str, str] = {
    "detect": GROUNDING_DINO.id,
    "detect:florence2": FLORENCE2.id,
    "segment": SAM.id,
    "ocr": FLORENCE2.id,
}

_BY_ID: dict[str, ServerModel] = {model.id: model for model in SERVER_MODELS}


def model_by_id(model_id: str) -> ServerModel | None:
    """按登记项 id 取模型，未登记返回 None。"""
    return _BY_ID.get((model_id or "").strip())


def model_by_role(role: str) -> ServerModel | None:
    """按角色取模型；同一角色有多个登记项时取第一个。

    注意这里只比对 ``ServerModel.role``，``detect:florence2`` 这类**键**请先过 ``MODEL_FOR_KEY``。
    """
    key = (role or "").strip().lower()
    for model in SERVER_MODELS:
        if model.role == key:
            return model
    return None


def model_by_repo(repo_id: str) -> ServerModel | None:
    """按 HF 仓库名取模型，供 ``--repo=IDEA-Research/grounding-dino-tiny`` 这类用法。"""
    key = (repo_id or "").strip()
    for model in SERVER_MODELS:
        if model.repo_id == key:
            return model
    return None


__all__ = [
    "MODEL_FOR_KEY",
    "ROLE_LABELS",
    "SERVER_MODELS",
    "ModelFile",
    "ServerModel",
    "model_by_id",
    "model_by_repo",
    "model_by_role",
]