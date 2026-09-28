"""服务配置。

全部字段都可用 ``LAYER_SPLIT_`` 前缀的环境变量覆盖（例如 ``LAYER_SPLIT_DEVICE=mps``），
也可以在 ``server/.env`` 里写。默认只绑回环地址，素材不出本机。
"""

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

SERVER_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MODELS_DIR = SERVER_ROOT / "models"
DEFAULT_TMP_DIR = SERVER_ROOT / "tmp"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="LAYER_SPLIT_",
        env_file=str(SERVER_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    host: str = "127.0.0.1"
    port: int = 8000
    log_level: str = "info"

    """auto | cuda | mps | cpu，auto 按 cuda > mps > cpu 探测"""
    device: str = "auto"

    models_dir: Path = DEFAULT_MODELS_DIR
    tmp_dir: Path = DEFAULT_TMP_DIR

    """上传上限（字节）"""
    max_upload_bytes: int = Field(default=20 * 1024 * 1024)
    """解码后的硬上限边长，超过直接拒绝"""
    max_side_hard: int = 4096
    """图层数量硬上限"""
    max_layers_hard: int = 200
    """排队上限，超出返回 429"""
    max_queue: int = 4
    """作业产物保留时长（秒）"""
    job_ttl_seconds: int = 3600
    """最多保留的作业数量，超出按创建时间淘汰"""
    max_jobs_kept: int = 20


@lru_cache
def get_settings() -> Settings:
    return Settings()