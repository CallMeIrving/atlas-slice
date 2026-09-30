"""产物落盘：图层 PNG、layers.json、atlas.json、bundle.zip。

``atlas.json`` 刻意对齐浏览器侧既有的 TexturePacker 哈希格式（见 ``src/core/parsers/json.ts``
与 ``src/core/export.ts`` 的 FrameMeta），使「精灵图」页可以直接导入并按 frame 从 ``source.png``
把每个元素裁出来——拿到的是「坐标 + 命名 + 顺序」，透明通道请用 ``layers/*.png``。
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from .. import SCHEMA_ID
from ..models.registry import ROLE_LABELS
from ..runtime.storage import atomic_write_bytes, atomic_write_json
from .backends import Candidate
from .mask_refine import crop_to_bbox

BACKGROUND_ID = "L0000"
SAFE_NAME_RE = re.compile(r"[^\w\-.]+", re.UNICODE)


def sanitize_name(text: str) -> str:
    cleaned = SAFE_NAME_RE.sub("_", (text or "").strip())
    return cleaned.strip("_") or "layer"


def layer_base_url(job_id: str) -> str:
    return f"/api/layers/jobs/{job_id}"


def layer_png_url(job_id: str, layer_id: str, full_canvas: bool = False) -> str:
    suffix = "?canvas=full" if full_canvas else ""
    return f"{layer_base_url(job_id)}/layers/{layer_id}.png{suffix}"


def manifest_url(job_id: str) -> str:
    return f"{layer_base_url(job_id)}/manifest.json"


def zip_url(job_id: str) -> str:
    return f"{layer_base_url(job_id)}/bundle.zip"


def layer_id_for(z: int) -> str:
    return f"L{z:04d}"


def pretty_file_name(index: int, name: str, label: str) -> str:
    return f"{index:04d}_{sanitize_name(name)}_{sanitize_name(label)}.png"


def _save_png(path: Path, array_rgba: Any) -> None:
    buffer = io.BytesIO()
    Image.fromarray(array_rgba, mode="RGBA").save(buffer, format="PNG", optimize=True)
    atomic_write_bytes(path, buffer.getvalue())


def render_layer_png(job_dir: Path, layer_id: str, source_size: tuple[int, int], full_canvas: bool) -> bytes:
    """图层 PNG：默认返回按 alpha_bbox 裁好的小图；``full_canvas`` 时补成原图尺寸。"""
    path = job_dir / "layers" / f"{layer_id}.png"
    if not path.exists():
        raise FileNotFoundError(layer_id)
    data = path.read_bytes()
    if not full_canvas:
        return data

    manifest = read_manifest(job_dir)
    entry = next((item for item in manifest.get("layers", []) if item["id"] == layer_id), None)
    box = (entry or {}).get("alpha_bbox") or {"x": 0, "y": 0, "w": 0, "h": 0}
    width, height = source_size
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    with Image.open(io.BytesIO(data)) as crop:
        canvas.paste(crop.convert("RGBA"), (int(box["x"]), int(box["y"])))
    buffer = io.BytesIO()
    canvas.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def read_manifest(job_dir: Path) -> dict[str, Any]:
    path = job_dir / "manifest.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text("utf-8"))


def _atlas_payload(
    job_id: str,
    image_info: dict[str, Any],
    layers: list[Candidate],
    file_names: dict[str, str],
) -> dict[str, Any]:
    frames: dict[str, Any] = {}
    width, height = int(image_info["width"]), int(image_info["height"])
    for candidate in layers:
        if candidate.alpha_bbox is None:
            continue
        x1, y1, x2, y2 = candidate.alpha_bbox
        frames[file_names[candidate.id]] = {
            "frame": {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1},
            "rotated": False,
            "trimmed": True,
            "spriteSourceSize": {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1},
            "sourceSize": {"w": width, "h": height},
            "manual": False,
        }
    return {
        "frames": frames,
        "meta": {
            "app": "atlas-slice",
            "format": "RGBA8888",
            "image": "source.png",
            "size": {"w": width, "h": height},
            "layerSchema": SCHEMA_ID,
            "jobId": job_id,
        },
    }


def _readme_payload(layers: list[Candidate], image_info: dict[str, Any], background_mode: str) -> str:
    lines = [
        "AtlasSlice 图层拆分产物",
        "",
        f"原图：{image_info['name']} {image_info['width']}×{image_info['height']}"
        + ("（推理时已缩放）" if image_info.get("scale", 1.0) != 1.0 else ""),
        f"背景层策略：{background_mode}",
        "",
        "图层顺序（列表从上到下 = 从前景到背景）：",
    ]
    for candidate in sorted(layers, key=lambda item: -item.z):
        lines.append(f"  z={candidate.z:<3} {candidate.name}  [{candidate.label}/{candidate.category}]")
    lines += [
        "",
        "layers/*.png 是带透明通道的独立图层，按 alpha_bbox 裁切，坐标见 layers.json；",
        "atlas.json 记录的是同一批元素在原图上的矩形（TexturePacker 哈希格式），",
        "可在「精灵图」页用「导入图片 + 导入元数据」还原，但那条路径只含坐标不含透明通道。",
        "",
        "各角色模型：" + "、".join(f"{key}={value}" for key, value in ROLE_LABELS.items()),
    ]
    return "\n".join(lines) + "\n"


def write_outputs(
    *,
    job_dir: Path,
    job_id: str,
    source_rgb: Any,
    image_info: dict[str, Any],
    layers: list[Candidate],
    background_rgba: Any | None,
    background_mode: str,
    warnings: list[str],
) -> dict[str, Any]:
    """写全部产物并返回 ``/layers`` 的响应体（manifest.json 的内容）。"""
    layers_dir = job_dir / "layers"
    layers_dir.mkdir(parents=True, exist_ok=True)

    # 每个类别一个递增序号，生成 button_01 / icon_01 这样的可读名字
    counters: Counter[str] = Counter()
    file_names: dict[str, str] = {}
    layer_entries: list[dict[str, Any]] = []

    for candidate in layers:
        counters[candidate.category] += 1
        candidate.name = f"{candidate.category}_{counters[candidate.category]:02d}"
        file_names[candidate.id] = pretty_file_name(candidate.z, candidate.name, candidate.label)

        if candidate.alpha is None or candidate.alpha_bbox is None:
            continue
        rgba = crop_to_bbox(source_rgb, candidate.alpha_bbox)
        alpha = crop_to_bbox(candidate.alpha, candidate.alpha_bbox)
        stacked = Image.fromarray(rgba, mode="RGB").convert("RGBA")
        stacked.putalpha(Image.fromarray(alpha, mode="L"))
        _save_png(layers_dir / f"{candidate.id}.png", np.asarray(stacked))

        x1, y1, x2, y2 = candidate.alpha_bbox
        layer_entries.append(
            {
                "id": candidate.id,
                "name": candidate.name,
                "label": candidate.label,
                "category": candidate.category,
                "score": round(float(candidate.score), 4),
                "bbox": {"x": candidate.box[0], "y": candidate.box[1], "w": candidate.box[2] - candidate.box[0], "h": candidate.box[3] - candidate.box[1]},
                "alpha_bbox": {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1},
                "area": int((candidate.alpha > 0).sum()),
                "z": candidate.z,
                "parent_id": candidate.parent_id,
                "source": candidate.source,
                "text": candidate.text,
                "rotation": 0,
                "png_url": layer_png_url(job_id, candidate.id),
                "png_cropped_url": layer_png_url(job_id, candidate.id),
            }
        )

    background_entry = None
    if background_rgba is not None:
        _save_png(job_dir / "background.png", background_rgba)
        background_entry = {
            "id": BACKGROUND_ID,
            "method": background_mode,
            "z": 0,
            "png_url": layer_png_url(job_id, BACKGROUND_ID, full_canvas=True),
        }

    buffer = io.BytesIO()
    Image.fromarray(source_rgb, mode="RGB").save(buffer, format="PNG", optimize=True)
    atomic_write_bytes(job_dir / "source.png", buffer.getvalue())

    manifest = {
        "schema": SCHEMA_ID,
        "job_id": job_id,
        "source": image_info,
        "layers": layer_entries,
        "background": background_entry,
        "counts": dict(Counter(entry["category"] for entry in layer_entries)),
        "warnings": warnings,
        "manifest_url": manifest_url(job_id),
        "zip_url": zip_url(job_id),
    }
    atomic_write_json(job_dir / "manifest.json", manifest)
    atomic_write_json(
        job_dir / "atlas.json",
        _atlas_payload(job_id, image_info, layers, file_names),
    )
    (job_dir / "README.txt").write_text(
        _readme_payload(layers, image_info, background_mode), encoding="utf-8"
    )
    build_bundle(job_dir, layers, file_names)
    return manifest


def build_bundle(job_dir: Path, layers: list[Candidate], file_names: dict[str, str]) -> Path:
    """把产物打包成 bundle.zip（源图、背景、图层、清单、atlas.json、说明）。"""
    path = job_dir / "bundle.zip"
    part = path.with_name(path.name + ".part")
    with zipfile.ZipFile(part, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.write(job_dir / "source.png", "source.png")
        if (job_dir / "background.png").exists():
            bundle.write(job_dir / "background.png", "background.png")
        for candidate in layers:
            source = job_dir / "layers" / f"{candidate.id}.png"
            if source.exists():
                bundle.write(source, f"layers/{file_names[candidate.id]}")
        for name in ("layers.json", "atlas.json", "README.txt"):
            source = job_dir / ("manifest.json" if name == "layers.json" else name)
            if source.exists():
                bundle.write(source, name)
    part.replace(path)
    return path