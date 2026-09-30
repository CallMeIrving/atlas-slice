"""FastAPI 应用装配。

重依赖（torch / transformers）不在导入路径上：``uvicorn app.main:app`` 秒起，
接口测试也不必先备好权重。
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import APP_VERSION
from .config import Settings, get_settings
from .errors import ApiError
from .routers import health, layers, models
from .runtime.device import enable_mps_fallback
from .runtime.jobs import JobManager
from .runtime.model_manager import ModelManager
from .runtime.storage import cleanup_all

LOG = logging.getLogger("layer-split")

"""dev 下前端走 Vite 代理（同源），这里只兜底放行本机来源，绝不写 ``allow_origins=["*"]``"""
ORIGIN_REGEX = r"^http://(localhost|127\.0\.0\.1)(:\d+)?$"


def create_app(settings: Settings | None = None) -> FastAPI:
    config = settings or get_settings()
    # MPS 缺失算子时回落 CPU，必须在任何 torch 调用之前设好
    enable_mps_fallback()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        config.models_dir.mkdir(parents=True, exist_ok=True)
        config.tmp_dir.mkdir(parents=True, exist_ok=True)
        # 作业只存在内存里，进程重启后旧产物全是孤儿，直接全量清扫
        cleanup_all(config.tmp_dir)
        app.state.started_at = time.time()
        LOG.info(
            "图层拆分服务启动：device=%s models_dir=%s",
            config.device,
            config.models_dir,
        )
        try:
            yield
        finally:
            app.state.job_manager.shutdown()
            app.state.model_manager.unload_all()

    app = FastAPI(title="AtlasSlice 图层拆分服务", version=APP_VERSION, lifespan=lifespan)
    app.state.settings = config
    app.state.model_manager = ModelManager(config)
    app.state.job_manager = JobManager(config)

    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=ORIGIN_REGEX,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content=exc.payload())

    @app.exception_handler(RequestValidationError)
    async def _validation_error(
        _request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        # 只带回可序列化的定位信息，保持与业务错误同一套信封
        errors = [
            {"loc": list(item.get("loc", ())), "msg": item.get("msg", ""), "type": item.get("type", "")}
            for item in exc.errors()[:5]
        ]
        error = ApiError("INVALID_PARAMS", "请求参数不合法", 422, {"errors": errors})
        return JSONResponse(status_code=error.status_code, content=error.payload())

    @app.exception_handler(Exception)
    async def _unhandled(_request: Request, exc: Exception) -> JSONResponse:
        LOG.exception("未处理异常")
        error = ApiError("INTERNAL", f"服务内部错误：{exc}", 500)
        return JSONResponse(status_code=error.status_code, content=error.payload())

    app.include_router(health.router, prefix="/api")
    app.include_router(models.router, prefix="/api")
    app.include_router(layers.router, prefix="/api")
    return app


app = create_app()