"""产物落盘：图层 PNG 裁切、manifest、atlas.json、bundle.zip。"""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from app.pipeline.backends import Candidate
from app.pipeline.exporter import (
    BACKGROUND_ID,
    layer_id_for,
    pretty_file_name,
    read_manifest,
    render_layer_png,
    sanitize_name,
    write_outputs,
)


def _candidate(cid: str, category: str, label: str, bbox, z: int, size: int = 64) -> Candidate:
    alpha = np.zeros((size, size), dtype=np.uint8)
    x1, y1, x2, y2 = bbox
    alpha[y1:y2, x1:x2] = 220
    return Candidate(
        id=cid,
        label=label,
        prompt=category,
        category=category,
        score=0.8,
        source="detect+sam",
        box=bbox,
        alpha=alpha,
        alpha_bbox=bbox,
        z=z,
        name=f"{category}_01",
    )


def test_sanitize_name_keeps_cjk_and_strips_separators():
    assert sanitize_name("按钮 01") == "按钮_01"
    assert sanitize_name("a/b\\c") == "a_b_c"
    assert sanitize_name("  ") == "layer"
    assert sanitize_name("icon-1.png") == "icon-1.png"


def test_layer_id_and_file_name_format():
    assert layer_id_for(7) == "L0007"
    assert layer_id_for(1234) == "L1234"
    assert pretty_file_name(7, "button_01", "按钮") == "0007_button_01_按钮.png"


def test_write_outputs_produces_full_artifact_set(tmp_path: Path):
    job_dir = tmp_path / "jobs" / "manual"
    (job_dir / "layers").mkdir(parents=True)
    source = np.dstack([np.full((64, 64), 120, dtype=np.uint8)] * 3)
    layers = [
        _candidate("c0001", "panel", "面板", (2, 2, 60, 60), z=1),
        _candidate("c0002", "icon", "图标", (10, 10, 24, 24), z=2),
    ]

    manifest = write_outputs(
        job_dir=job_dir,
        job_id="manual",
        source_rgb=source,
        image_info={"name": "gameUI.png", "width": 64, "height": 64, "scale": 1.0},
        layers=layers,
        background_rgba=None,
        background_mode="none",
        warnings=[],
    )

    assert manifest["schema"] == "atlas-slice.layers/1"
    assert manifest["job_id"] == "manual"
    assert manifest["counts"] == {"panel": 1, "icon": 1}
    assert manifest["background"] is None  # none 模式不产出背景层
    assert (job_dir / "source.png").exists()
    assert (job_dir / "layers" / "c0001.png").exists()
    assert read_manifest(job_dir)["layers"][0]["alpha_bbox"] == {"x": 2, "y": 2, "w": 58, "h": 58}

    atlas = json.loads((job_dir / "atlas.json").read_text("utf-8"))
    assert atlas["meta"]["size"] == {"w": 64, "h": 64}
    assert len(atlas["frames"]) == 2

    with zipfile.ZipFile(job_dir / "bundle.zip") as bundle:
        names = set(bundle.namelist())
    assert {"source.png", "layers.json", "atlas.json", "README.txt"} <= names
    assert "layers/0001_panel_01_面板.png" in names
    assert "layers/0002_icon_01_图标.png" in names
    assert "background.png" not in names


def test_write_outputs_with_background_and_warnings(tmp_path: Path):
    job_dir = tmp_path / "job"
    (job_dir / "layers").mkdir(parents=True)
    source = np.zeros((32, 32, 3), dtype=np.uint8)
    background = np.dstack([np.full((32, 32), 7, dtype=np.uint8)] * 3 + [np.full((32, 32), 255, dtype=np.uint8)])

    manifest = write_outputs(
        job_dir=job_dir,
        job_id="j1",
        source_rgb=source,
        image_info={"name": "a.png", "width": 32, "height": 32, "scale": 1.0},
        layers=[_candidate("c0001", "button", "按钮", (4, 4, 20, 16), z=1, size=32)],
        background_rgba=background,
        background_mode="inpaint",
        warnings=["提示一"],
    )

    assert manifest["warnings"] == ["提示一"]
    assert manifest["background"]["id"] == BACKGROUND_ID
    assert manifest["background"]["method"] == "inpaint"
    assert manifest["background"]["png_url"].endswith(f"/layers/{BACKGROUND_ID}.png?canvas=full")
    with zipfile.ZipFile(job_dir / "bundle.zip") as bundle:
        assert "background.png" in bundle.namelist()


def test_render_layer_png_crop_and_full(tmp_path: Path):
    job_dir = tmp_path / "job"
    (job_dir / "layers").mkdir(parents=True)
    source = np.dstack([np.full((32, 32), 90, dtype=np.uint8)] * 3)
    write_outputs(
        job_dir=job_dir,
        job_id="j1",
        source_rgb=source,
        image_info={"name": "a.png", "width": 32, "height": 32, "scale": 1.0},
        layers=[_candidate("c0001", "icon", "图标", (5, 6, 15, 20), z=1, size=32)],
        background_rgba=None,
        background_mode="none",
        warnings=[],
    )

    crop = Image.open(io.BytesIO(render_layer_png(job_dir, "c0001", (32, 32), False)))
    assert crop.size == (10, 14)
    assert crop.mode == "RGBA"

    full = Image.open(io.BytesIO(render_layer_png(job_dir, "c0001", (32, 32), True)))
    assert full.size == (32, 32)
    # 裁切块应当被放回 alpha_bbox 的位置
    assert full.getpixel((5, 6))[3] > 0
    assert full.getpixel((0, 0))[3] == 0


def test_render_layer_png_missing_file(tmp_path: Path):
    job_dir = tmp_path / "job"
    (job_dir / "layers").mkdir(parents=True)
    with pytest.raises(FileNotFoundError):
        render_layer_png(job_dir, "L0001", (8, 8), False)


def test_read_manifest_of_empty_dir(tmp_path: Path):
    assert read_manifest(tmp_path) == {}