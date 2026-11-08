# SPDX-License-Identifier: GPL-3.0-or-later
"""`still`: one frame of an assembled scene as a PNG.

    job: {blend, frame (video frame, 0-based), out (png path), width?, height?, samples?}

Used for quick looks and for the keyframes of the Flow clips (the clip's staging as the 3D scene shows it).
"""
import os

import bpy

from . import command
from .io import CtsError


@command("still")
def still_command(job):
    blend = job["blend"]
    if not os.path.exists(blend):
        raise CtsError("E_ASSEMBLE_FAILED", f"{blend} does not exist: assemble the episode first (cts_scene_assemble)")
    bpy.ops.wm.open_mainfile(filepath=blend)
    sc = bpy.context.scene
    frame = int(job.get("frame", 0))
    sc.frame_set(min(max(frame, 0), sc.frame_end - sc.frame_start) + sc.frame_start)
    if job.get("width"):
        sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = int(job["width"]), int(job["height"]), 100
    if job.get("samples"):
        sc.eevee.taa_render_samples = int(job["samples"])
    out = job["out"]
    os.makedirs(os.path.dirname(out), exist_ok=True)
    sc.render.filepath = out
    bpy.ops.render.render(write_still=True)
    return {"file": out, "frame": frame, "width": sc.render.resolution_x, "height": sc.render.resolution_y}
