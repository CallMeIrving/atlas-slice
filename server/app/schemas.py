"""API 请求 / 响应模型。

前端 ``src/core/layer-split.ts`` 与 ``.trae/documents/游戏资源UI图层拆分方案.md`` 的契约以此为准。
"""

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from . import APP_VERSION, SCHEMA_ID

LayerCategory = Literal[
    "button",
    "icon",
    "text",
    "panel",
    "border",
    "decoration",
    "progress",
    "background",
    "other",
]

DetectorName = Literal["grounding-dino", "florence2", "auto"]
SegmenterName = Literal["sam", "none"]
BackgroundMode = Literal["none", "erase", "inpaint"]
DeviceName = Literal["auto", "cuda", "mps", "cpu"]
ModelRole = Literal["detect", "segment", "ocr"]

DEFAULT_CLASSES: list[dict[str, str]] = [
    {"label": "按钮", "prompt": "button", "category": "button"},
    {"label": "图标", "prompt": "icon", "category": "icon"},
    {"label": "文本", "prompt": "text", "category": "text"},
    {"label": "面板", "prompt": "panel", "category": "panel"},
    {"label": "边框", "prompt": "border", "category": "border"},
    {"label": "装饰", "prompt": "decoration", "category": "decoration"},
    {"label": "进度条", "prompt": "progress bar", "category": "progress"},
]


class ClassSpec(BaseModel):
    """一类要拆的 UI 元素。

    ``prompt`` 必须是英文——GroundingDINO / Florence-2 的词表与训练语料决定；
    ``label`` 是给界面看的中文。
    """

    label: str = Field(min_length=1, max_length=48)
    prompt: str = Field(min_length=1, max_length=96)
    category: LayerCategory = "other"


class SplitParams(BaseModel):
    classes: list[ClassSpec] = Field(default_factory=lambda: [ClassSpec(**c) for c in DEFAULT_CLASSES])
    detector: DetectorName = "grounding-dino"
    segmenter: SegmenterName = "sam"
    ocr: bool = True
    box_threshold: float = Field(default=0.30, ge=0.0, le=1.0)
    text_threshold: float = Field(default=0.25, ge=0.0, le=1.0)
    nms_iou: float = Field(default=0.55, ge=0.0, le=1.0)
    min_area: int = Field(default=64, ge=1)
    max_layers: int = Field(default=80, ge=1)
    max_side: int = Field(default=1536, ge=64)
    background: BackgroundMode = "inpaint"
    exclusive_layers: bool = False
    feather: int = Field(default=1, ge=0, le=8)

    @field_validator("classes")
    @classmethod
    def _non_empty(cls, value: list[ClassSpec]) -> list[ClassSpec]:
        if not value:
            raise ValueError("classes 不能为空")
        return value


class SplitAccepted(BaseModel):
    job_id: str
    status: str
    created_at: str
    position: int = 0


class StageStat(BaseModel):
    stage: str
    progress: float
    elapsed_ms: int


class ImageInfo(BaseModel):
    name: str
    width: int
    height: int
    scale: float = 1.0


class Rect(BaseModel):
    x: int
    y: int
    w: int
    h: int


class LayerOut(BaseModel):
    id: str
    name: str
    label: str
    category: str
    score: float
    bbox: Rect
    alpha_bbox: Rect
    area: int
    z: int
    parent_id: str | None = None
    source: str = "detect+sam"
    text: str | None = None
    rotation: int = 0
    png_url: str
    png_cropped_url: str


class BackgroundOut(BaseModel):
    id: str
    method: str
    z: int
    png_url: str


class LayerListOut(BaseModel):
    schema_id: str = Field(default=SCHEMA_ID, alias="schema")
    job_id: str
    source: ImageInfo
    layers: list[LayerOut]
    background: BackgroundOut | None = None
    counts: dict[str, int] = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    manifest_url: str
    zip_url: str

    model_config = {"populate_by_name": True}


class JobStatusOut(BaseModel):
    job_id: str
    status: Literal["queued", "running", "succeeded", "failed", "cancelled"]
    stage: str
    stage_progress: float = 0.0
    progress: float = 0.0
    message: str = ""
    stages: list[StageStat] = Field(default_factory=list)
    image: ImageInfo | None = None
    error: str | None = None
    elapsed_ms: int = 0
    position: int = 0
    layers: list[LayerOut] | None = None
    background: BackgroundOut | None = None
    counts: dict[str, int] | None = None
    warnings: list[str] = Field(default_factory=list)
    manifest_url: str | None = None
    zip_url: str | None = None


class ModelFileOut(BaseModel):
    file: str
    size: int = 0
    present: bool = False
    actual_size: int = 0


class ModelOut(BaseModel):
    id: str
    role: str
    label: str
    repo_id: str
    dir: str
    installed: bool
    loaded: bool = False
    load_error: str | None = None
    optional: bool = False
    approx_bytes: int = 0
    files: list[ModelFileOut] = Field(default_factory=list)
    missing: list[str] = Field(default_factory=list)


class ModelListOut(BaseModel):
    models_dir: str
    models: list[ModelOut]
    download_command: str


class ModelDownloadRequest(BaseModel):
    repo: str | None = None
    host: str = "hf-mirror.com"


class ModelLoadRequest(BaseModel):
    role: ModelRole


class ModelLoadOut(BaseModel):
    role: str
    loaded: bool
    load_ms: int = 0


class DeviceOut(BaseModel):
    selected: str
    available: list[str]
    override: str
    dtype: str
    mps_fallback_env: bool


class LimitsOut(BaseModel):
    max_upload_bytes: int
    max_side: int
    max_layers: int
    max_queue: int


class SystemOut(BaseModel):
    python: str
    torch: str
    transformers: str
    platform: str
    device: DeviceOut
    limits: LimitsOut


class HealthOut(BaseModel):
    status: str = "ok"
    version: str = APP_VERSION
    schema_id: str = Field(default=SCHEMA_ID, alias="schema")
    uptime_s: float
    device: str
    models_ready: bool
    queue_depth: int

    model_config = {"populate_by_name": True}


def error_payload(code: str, message: str, detail: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "detail": detail or {}}}