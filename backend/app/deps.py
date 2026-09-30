"""FastAPI 依赖项：单例都挂在 ``app.state`` 上，避免模块级全局。"""

from fastapi import Request

from .config import Settings
from .runtime.jobs import JobManager
from .runtime.model_manager import ModelManager


def get_settings_dep(request: Request) -> Settings:
    return request.app.state.settings


def get_model_manager(request: Request) -> ModelManager:
    return request.app.state.model_manager


def get_job_manager(request: Request) -> JobManager:
    return request.app.state.job_manager