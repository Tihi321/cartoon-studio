# SPDX-License-Identifier: GPL-3.0-or-later
"""The render commands (HUB-30 CTS-26): `render` (an assembled scene to PNG frames, in chunks) and `contact` (a contact sheet from picture files).

    render  job: {blend, outDir, ranges: [[from, to)], chunkFrames?, width, height, samples, timesFile}
    contact job: {files: [png], labels: [text], out, cell?: 480}

`render` renders each range of video frames (0-based, `to` excluded; frame f is Blender frame f + 1) in chunks of `chunkFrames`. After each chunk it prints
`CTS {"type":"chunk","index","from","to","dir"}`: the engine encodes that chunk to a video segment and deletes its frames while Blender goes on with the next,
so a long episode never holds more than a chunk of PNGs. `render_pre` / `render_post` handlers time every frame; `timesFile` gets first, warm mean,
p95, total and the time of each frame.
"""
import json
import math
import os
import time

import bpy
import numpy as np

from . import command, io
from .io import CtsError

PROGRESS_EVERY = 6


def chunks(ranges, size):
    """[(index, from, to)] for the ranges split into chunks of at most `size` frames."""
    out, k = [], 0
    for a, b in ranges:
        f = int(a)
        while f < int(b):
            out.append((k, f, min(f + int(size), int(b))))
            k += 1
            f = out[-1][2]
    return out


def stats_of(times):
    """first, warm mean (without the first frame, which compiles shaders), p95 of the warm frames and the sum, in seconds."""
    vals = np.array(times, dtype=float)
    warm = vals[1:] if len(vals) > 1 else vals
    return {
        "frames": int(len(vals)),
        "first": round(float(vals[0]), 4),
        "warmMean": round(float(warm.mean()), 4),
        "p95": round(float(np.percentile(warm, 95)), 4),
        "total": round(float(vals.sum()), 3),
    }


@command("render")
def render_command(job):
    blend = job["blend"]
    if not os.path.exists(blend):
        raise CtsError("E_ASSEMBLE_FAILED", f"{blend} does not exist: assemble the episode first (cts_scene_assemble)")
    bpy.ops.wm.open_mainfile(filepath=blend)
    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = int(job["width"]), int(job["height"]), 100
    sc.eevee.taa_render_samples = int(job["samples"])
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGB"
    sc.render.fps = 24
    plan = chunks(job["ranges"], job.get("chunkFrames", 240))
    total = sum(b - a for _k, a, b in plan)
    if total <= 0:
        raise CtsError("E_BLENDER_FAILED", "nothing to render (no frame range)")
    last_frame = sc.frame_end
    if max(b for _k, _a, b in plan) > last_frame:
        raise CtsError("E_BLENDER_FAILED", f"the range goes to frame {max(b for _k, _a, b in plan)} but the assembled scene has {last_frame} frames")
    os.makedirs(job["outDir"], exist_ok=True)
    times, mark = {}, {}
    done = [0]

    def pre(scene, *_):
        mark["t"] = time.perf_counter()

    def post(scene, *_):
        times[scene.frame_current] = time.perf_counter() - mark["t"]
        done[0] += 1
        if done[0] % PROGRESS_EVERY == 0 or done[0] == total:
            io.progress(done[0], total, "render")

    bpy.app.handlers.render_pre.append(pre)
    bpy.app.handlers.render_post.append(post)
    t0 = time.perf_counter()
    try:
        for k, a, b in plan:
            d = os.path.join(job["outDir"], f"chunk-{k:04d}")
            os.makedirs(d, exist_ok=True)
            sc.frame_start, sc.frame_end = a + 1, b
            sc.render.filepath = os.path.join(d, "f_#####")
            bpy.ops.render.render(animation=True)
            io.chunk(k, a, b, d)
    finally:
        bpy.app.handlers.render_pre.remove(pre)
        bpy.app.handlers.render_post.remove(post)
    order = sorted(times)
    st = stats_of([times[f] for f in order])
    st.update({"width": int(job["width"]), "height": int(job["height"]), "samples": int(job["samples"]), "wall": round(time.perf_counter() - t0, 3), "perFrame": [round(times[f], 4) for f in order], "firstFrame": order[0] - 1})
    if job.get("timesFile"):
        os.makedirs(os.path.dirname(job["timesFile"]), exist_ok=True)
        with open(job["timesFile"], "w", encoding="utf-8", newline="\n") as f:
            json.dump(st, f)
            f.write("\n")
    return {"times": {k: v for k, v in st.items() if k != "perFrame"}, "chunks": len(plan), "timesFile": job.get("timesFile")}


@command("contact")
def contact_command(job):
    from .sheets import draw_label, load_pixels, save_pixels, shrink

    files, labels = job["files"], job.get("labels") or []
    if not files:
        raise CtsError("E_BLENDER_FAILED", "no pictures for the contact sheet")
    cell = int(job.get("cell", 480))
    tiles = []
    for i, f in enumerate(files):
        px = load_pixels(f)
        h, w = px.shape[:2]
        k = max(1, w // cell)
        px = np.array(shrink(px[: h - h % k, : w - w % k], k) if k > 1 else px)
        if i < len(labels):
            draw_label(px, labels[i], 6, 6, scale=2)
        tiles.append(px)
    th, tw = tiles[0].shape[:2]
    cols = min(len(tiles), 4 if len(tiles) > 6 else 3)
    rows = math.ceil(len(tiles) / cols)
    sheet = np.ones((rows * th, cols * tw, 4), dtype=np.float32)
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        sheet[r * th : (r + 1) * th, c * tw : (c + 1) * tw] = t
    os.makedirs(os.path.dirname(job["out"]), exist_ok=True)
    save_pixels(job["out"], sheet)
    return {"file": job["out"], "tiles": len(tiles), "width": int(cols * tw), "height": int(rows * th)}
