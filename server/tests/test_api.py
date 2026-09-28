"""接口契约：健康 / 系统 / 模型 / 拆分 / 产物 / 错误码 / 路径与上限。"""

from __future__ import annotations

import io
import json
import zipfile

from PIL import Image

from conftest import (
    DEFAULT_DETECTIONS,
    EmptySegmenter,
    gradient_image,
    poll_job,
    png_bytes,
    split_and_wait,
    split_request,
)
from app.pipeline.backends import Detection


def test_health_and_system(client):
    health = client.get("/api/health")
    assert health.status_code == 200
    body = health.json()
    assert body["status"] == "ok"
    assert body["schema"] == "atlas-slice.layers/1"
    assert body["models_ready"] is False  # 未装权重
    assert body["queue_depth"] == 0

    system = client.get("/api/system")
    assert system.status_code == 200
    limits = system.json()["limits"]
    assert limits["max_upload_bytes"] > 0
    assert limits["max_queue"] >= 1
    assert system.json()["device"]["dtype"] == "float32"


def test_health_reports_ready_after_weights_present(client, ready_models):
    assert client.get("/api/health").json()["models_ready"] is True


def test_models_list(client, ready_models):
    listing = client.get("/api/models").json()
    assert listing["download_command"].endswith("scripts/download_models.py --host=https://hf-mirror.com")
    roles = {item["role"] for item in listing["models"]}
    assert {"detect", "segment", "ocr"} <= roles
    detect = next(item for item in listing["models"] if item["role"] == "detect")
    assert detect["installed"] is True
    assert detect["missing"] == []
    assert all(file["present"] for file in detect["files"])


def test_model_load_and_unload(client, ready_models):
    loaded = client.post("/api/models/load", json={"role": "detect"})
    assert loaded.status_code == 200, loaded.text
    assert loaded.json()["loaded"] is True

    unloaded = client.post("/api/models/unload", json={"role": "detect"})
    assert unloaded.json()["loaded"] is False


def test_model_load_rejects_unknown_role(client):
    response = client.post("/api/models/load", json={"role": "nonsense"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_PARAMS"


def test_model_load_missing_weights(client):
    response = client.post("/api/models/load", json={"role": "detect"})
    assert response.status_code == 409
    error = response.json()["error"]
    assert error["code"] == "MODEL_MISSING"
    assert error["detail"]["role"]
    assert "download_models.py" in error["detail"]["hint"]


def test_model_download_submits_job(client, ready_models, monkeypatch):
    calls: list[tuple[str, str]] = []

    def fake_download(model, *, models_dir, host=None, force=False, progress=None):
        calls.append((model.id, host))
        if progress is not None:
            progress(0.5, "下载中…")
            progress(1.0, "完成")
        return models_dir / model.repo_id, None

    monkeypatch.setattr("app.routers.models.download_repo", fake_download)

    response = client.post("/api/models/download", json={"repo": "detect", "host": "hf-mirror.com"})
    assert response.status_code == 202
    job = poll_job(client, response.json()["job_id"])
    assert job["status"] == "succeeded"
    assert job["progress"] == 1.0
    assert calls and calls[0][1] == "hf-mirror.com"


def test_model_download_rejects_unknown_repo(client):
    response = client.post("/api/models/download", json={"repo": "not-a-model"})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_PARAMS"


def test_split_requires_weights(client):
    response = split_request(client)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "MODEL_MISSING"


def test_split_rejects_unsupported_media(client, ready_models):
    response = split_request(client, content_type="application/pdf")
    assert response.status_code == 415
    assert response.json()["error"]["code"] == "UNSUPPORTED_MEDIA"


def test_split_rejects_oversized_upload(settings_factory, client_factory, ready_models):
    client = client_factory(app_settings=settings_factory(max_upload_bytes=16))
    response = split_request(client)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "PAYLOAD_TOO_LARGE"


def test_split_rejects_bad_params(client, ready_models):
    response = client.post(
        "/api/layers/split",
        files={"file": ("a.png", png_bytes(gradient_image()), "image/png")},
        data={"params": "{not json"},
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_PARAMS"


def test_split_rejects_empty_classes(client, ready_models):
    response = split_request(client, params={"classes": []})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_PARAMS"


def test_queue_full(settings_factory, client_factory, ready_models):
    client = client_factory(app_settings=settings_factory(max_queue=0))
    response = split_request(client)
    assert response.status_code == 429
    assert response.json()["error"]["code"] == "QUEUE_FULL"


def test_split_happy_path_manifest_and_artifacts(client, ready_models):
    accepted, job = split_and_wait(client)
    assert accepted["status"] == "queued"
    assert job["status"] == "succeeded", job
    assert job["progress"] == 1.0
    assert job["stage"] == "done"
    assert job["image"]["width"] == 96
    assert job["warnings"] == []

    layers = job["layers"]
    assert len(layers) == len(DEFAULT_DETECTIONS)
    assert [item["z"] for item in layers] == sorted(item["z"] for item in layers)

    icon = next(item for item in layers if item["category"] == "icon")
    assert icon["parent_id"] is not None  # 图标在按钮里，按钮在面板里

    body = client.get(f"/api/layers/jobs/{job['job_id']}/layers").json()
    assert body["schema"] == "atlas-slice.layers/1"
    assert body["source"]["name"] == "gameUI.png"
    assert body["counts"]["panel"] == 1
    assert body["background"]["method"] == "inpaint"
    assert body["manifest_url"].endswith("/manifest.json")
    assert body["zip_url"].endswith("/bundle.zip")


def test_layer_png_is_cropped_rgba(client, ready_models):
    _, job = split_and_wait(client)
    layer = job["layers"][0]
    response = client.get(f"/api/layers/jobs/{job['job_id']}/layers/{layer['id']}.png")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.headers["cache-control"] == "private, max-age=3600"

    with Image.open(io.BytesIO(response.content)) as image:
        assert image.mode == "RGBA"
        assert image.size == (layer["alpha_bbox"]["w"], layer["alpha_bbox"]["h"])
        assert image.getchannel("A").getextrema()[1] > 0


def test_layer_png_full_canvas(client, ready_models):
    _, job = split_and_wait(client)
    layer = job["layers"][0]
    response = client.get(f"/api/layers/jobs/{job['job_id']}/layers/{layer['id']}.png?canvas=full")
    with Image.open(io.BytesIO(response.content)) as image:
        assert image.size == (96, 96)


def test_background_png_is_full_canvas(client, ready_models):
    _, job = split_and_wait(client)
    response = client.get(f"/api/layers/jobs/{job['job_id']}/layers/L0000.png")
    assert response.status_code == 200
    with Image.open(io.BytesIO(response.content)) as image:
        assert image.size == (96, 96)
        assert image.mode == "RGBA"


def test_bundle_and_manifest_files(client, ready_models):
    _, job = split_and_wait(client)
    job_id = job["job_id"]

    manifest = client.get(f"/api/layers/jobs/{job_id}/manifest.json")
    assert manifest.status_code == 200
    assert manifest.json()["layers"]

    bundle = client.get(f"/api/layers/jobs/{job_id}/bundle.zip")
    assert bundle.status_code == 200
    with zipfile.ZipFile(io.BytesIO(bundle.content)) as archive:
        names = archive.namelist()
    assert "source.png" in names
    assert "background.png" in names
    assert "layers.json" in names
    assert "atlas.json" in names
    assert "README.txt" in names
    assert any(name.startswith("layers/") for name in names)

    with zipfile.ZipFile(io.BytesIO(bundle.content)) as archive:
        atlas = json.loads(archive.read("atlas.json"))
    assert atlas["meta"]["image"] == "source.png"
    assert atlas["meta"]["layerSchema"] == "atlas-slice.layers/1"
    assert len(atlas["frames"]) == len(job["layers"])
    # atlas 的 frame 必须与图层 alpha_bbox 完全一致，否则「精灵图」页回灌会错位
    frames = {
        (value["frame"]["x"], value["frame"]["y"], value["frame"]["w"], value["frame"]["h"])
        for value in atlas["frames"].values()
    }
    bboxes = {
        (layer["alpha_bbox"]["x"], layer["alpha_bbox"]["y"], layer["alpha_bbox"]["w"], layer["alpha_bbox"]["h"])
        for layer in job["layers"]
    }
    assert frames == bboxes


def test_max_layers_truncates_with_warning(client_factory, ready_models):
    spread = [
        Detection(
            label="图标",
            prompt="icon",
            category="icon",
            score=0.5 + index * 0.01,
            box=(2 + index * 18, 2, 14 + index * 18, 14),
        )
        for index in range(5)
    ]
    client = client_factory(detections=spread)
    _, job = split_and_wait(client, params={"max_layers": 2})
    assert len(job["layers"]) == 2
    assert any("上限" in warning for warning in job["warnings"])


def test_segmenter_none_keeps_detection_boxes(client_factory, ready_models):
    client = client_factory()
    _, job = split_and_wait(client, params={"segmenter": "none"})
    assert job["status"] == "succeeded"
    assert all(layer["source"] == "detect" for layer in job["layers"])
    assert len(job["layers"]) == len(DEFAULT_DETECTIONS)


def test_empty_detection_warns_and_succeeds(client_factory, ready_models):
    client = client_factory(detections=[])
    _, job = split_and_wait(client)
    assert job["status"] == "succeeded"
    assert job["layers"] == []
    assert any("没有返回任何元素" in warning for warning in job["warnings"])


def test_empty_masks_are_dropped(client_factory, ready_models):
    client = client_factory(segmenter=EmptySegmenter())
    _, job = split_and_wait(client)
    assert job["layers"] == []


def test_job_not_found(client):
    response = client.get("/api/layers/jobs/20260101T000000-abcdef")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "JOB_NOT_FOUND"


def test_invalid_job_id_is_rejected(client):
    response = client.get("/api/layers/jobs/bad!id")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_PARAMS"


def test_invalid_layer_id_is_rejected(client, ready_models):
    _, job = split_and_wait(client)
    response = client.get(f"/api/layers/jobs/{job['job_id']}/layers/bad%20id.png")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "INVALID_PARAMS"


def test_missing_layer_png(client, ready_models):
    _, job = split_and_wait(client)
    response = client.get(f"/api/layers/jobs/{job['job_id']}/layers/L9999.png")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "JOB_NOT_FOUND"


def test_layers_before_ready_is_404(client, ready_models, monkeypatch):
    """管线未产出 manifest 时按「产物不存在」处理，前端据此回到待处理态。"""
    accepted, _ = split_and_wait(client)
    job_id = accepted["job_id"]
    manifest = client.app.state.settings.tmp_dir / "jobs" / job_id / "manifest.json"
    manifest.unlink()
    response = client.get(f"/api/layers/jobs/{job_id}/layers")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "JOB_NOT_FOUND"


def test_cancel_finished_job_is_idempotent(client, ready_models):
    _, job = split_and_wait(client)
    response = client.delete(f"/api/layers/jobs/{job['job_id']}")
    assert response.status_code == 200
    assert response.json()["status"] == "succeeded"


def test_poll_shape_matches_contract(client, ready_models):
    accepted, _ = split_and_wait(client)
    payload = client.get(f"/api/layers/jobs/{accepted['job_id']}").json()
    for key in ("job_id", "status", "stage", "stage_progress", "progress", "message", "stages", "elapsed_ms"):
        assert key in payload
    assert {"detect", "segment"} <= {item["stage"] for item in payload["stages"]}