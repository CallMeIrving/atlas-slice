"""统一错误模型。

所有失败都收敛成 ``{"error": {"code", "message", "detail"}}``，前端按 ``code`` 分支处理。
"""

from typing import Any


class ApiError(Exception):
    """可预期的业务错误，会被异常处理器转成统一 JSON。"""

    def __init__(
        self,
        code: str,
        message: str,
        status_code: int = 400,
        detail: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.detail = detail or {}

    def payload(self) -> dict[str, Any]:
        return {"error": {"code": self.code, "message": self.message, "detail": self.detail}}


def bad_image(message: str, detail: dict[str, Any] | None = None) -> ApiError:
    return ApiError("BAD_IMAGE", message, 400, detail)


def invalid_params(message: str, detail: dict[str, Any] | None = None) -> ApiError:
    return ApiError("INVALID_PARAMS", message, 400, detail)


def unsupported_media(message: str, detail: dict[str, Any] | None = None) -> ApiError:
    return ApiError("UNSUPPORTED_MEDIA", message, 415, detail)


def payload_too_large(limit: int, actual: int) -> ApiError:
    return ApiError(
        "PAYLOAD_TOO_LARGE",
        f"图片超过上传上限 {limit // (1024 * 1024)}MB",
        413,
        {"max_upload_bytes": limit, "actual_bytes": actual},
    )


def device_invalid(message: str, detail: dict[str, Any] | None = None) -> ApiError:
    return ApiError("DEVICE_INVALID", message, 400, detail)


def model_missing(repo_id: str, role: str, missing: list[str]) -> ApiError:
    return ApiError(
        "MODEL_MISSING",
        f"{role} 角色权重未安装：{repo_id}",
        409,
        {
            "repo_id": repo_id,
            "role": role,
            "missing": missing,
            "hint": f"cd server && .venv/bin/python scripts/download_models.py --repo={role}",
        },
    )


def model_load_failed(repo_id: str, reason: str) -> ApiError:
    return ApiError("MODEL_LOAD_FAILED", f"加载 {repo_id} 失败：{reason}", 500, {"repo_id": repo_id})


def out_of_memory(suggested_max_side: int | None = None) -> ApiError:
    detail: dict[str, Any] = {}
    if suggested_max_side:
        detail["suggested_max_side"] = suggested_max_side
    return ApiError(
        "OUT_OF_MEMORY",
        "显存/内存不足，请降低 max_side 或图层数量后重试",
        507,
        detail,
    )


def job_not_found(job_id: str) -> ApiError:
    return ApiError("JOB_NOT_FOUND", f"作业不存在或已过期：{job_id}", 404, {"job_id": job_id})


def queue_full(max_queue: int) -> ApiError:
    return ApiError("QUEUE_FULL", "服务排队已满，请稍后重试", 429, {"max_queue": max_queue})