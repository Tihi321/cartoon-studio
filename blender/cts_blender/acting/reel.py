# SPDX-License-Identifier: GPL-3.0-or-later
"""`reel`: a scene that exercises the acting library, and `build_reel_scene` for the tests.

Two actors in a park: the first walks to the bench, sits, waves, points, nods and stands up; the second hops, nods, reacts, shakes its head, shrugs
and laughs. A fake speech (seeded visemes and word accents) drives the talking and listening automation. The camera cuts, follows, pushes and shakes.
This is not the scene assembler (that is CTS-25, which builds the same structure from a timeline); it is the library's own proof.

job: {outDir, cast?: "mini3d" | "examples", render?: bool, quality?: "preview" | "final", seconds?: number, fps?: 24}
"""
import json
import math
import os
import re
import subprocess
import time

import bpy
import numpy as np
from mathutils import Vector

from .. import command, io, materials as M
from ..build_character import build_character, find_rig, read_spec, reset_scene
from ..io import CtsError, progress
from . import compose
from .core import FPS, Ctx, nominal_walk_speed

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
FIXTURE = os.path.join(ROOT, "tests", "fixtures", "mini3d")


def specs_from_markdown(path, ids):
    """The character specs of the example blocks in seed/style/toon-3d.md."""
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    found = {}
    for block in re.findall(r"```json\n(.*?)```", text, flags=re.S):
        try:
            d = json.loads(block)
        except ValueError:
            continue
        if isinstance(d, dict) and d.get("schema") == "cts.character3d/1" and d.get("id") in ids:
            found[d["id"]] = d
    missing = [i for i in ids if i not in found]
    if missing:
        raise CtsError("E_SPEC_INVALID", f"no example spec for {', '.join(missing)} in {path}")
    return [found[i] for i in ids]


def _seat_info(obj):
    m = obj.matrix_world
    fwd = m.to_3x3() @ Vector((0, -1, 0))
    return {"xy": [m.translation.x, m.translation.y], "z": m.translation.z, "yaw": math.atan2(fwd.x, -fwd.y)}


def build_reel_scene(cast="mini3d", quality="preview", bench_faces_camera=True):
    """Builds the park and two characters; returns {ctx_inputs, rigs, set, camera}. Nothing is animated yet."""
    reset_scene()
    sc = bpy.context.scene
    style = M.load_style(os.path.join(FIXTURE, "style3d.json"))
    set_spec = json.load(open(os.path.join(FIXTURE, "sets", "park", "set3d.json"), encoding="utf-8"))
    if bench_faces_camera:
        for p in set_spec["props"]:
            if p["kind"] == "bench":
                p["rot"] = 0
    from .. import build_set as bs

    bs.build_set(set_spec, style)
    if cast == "examples":
        specs = specs_from_markdown(os.path.join(ROOT, "seed", "style", "toon-3d.md"), ["pip", "bruno"])
    else:
        specs = [read_spec(os.path.join(FIXTURE, "cast", c, "character.json")) for c in ("tilly", "blobby")]
    rigs, shadows = {}, {}
    for spec in specs:
        built = build_character(spec, style)
        rigs[spec["id"]] = built["rig"]
        shadows[spec["id"]] = next((o for o in built["rig"]["objects"] if "cts_shadow" in o), None)
    M.apply_look(sc, style, quality, sky=set_spec["sky"])
    cd = bpy.data.cameras.new("reel_cam")
    cam = bpy.data.objects.new("reel_cam", cd)
    sc.collection.objects.link(cam)
    sc.camera = cam
    sid = set_spec["id"]
    points = {}
    seats = {}
    objs = list(bpy.data.collections[f"set_{sid}"].objects)
    for ob in objs:
        if "cts_mark" in ob:
            points[ob["cts_mark"]] = (ob.location.x, ob.location.y, 0.0)
    for ob in objs:  # a mark wins over a prop of the same name
        if "cts_prop" in ob:
            points.setdefault(ob["cts_prop"], (ob.location.x, ob.location.y, 1.6 * ob.scale.x))
        if "cts_seat" in ob:
            seats[ob["cts_seat"]] = _seat_info(ob)
    for k, v in seats.items():
        points[k + "_seat"] = (v["xy"][0], v["xy"][1], v["z"])
    return {"specs": specs, "rigs": rigs, "shadows": shadows, "camera": cam, "points": points, "seats": seats, "sets": set_spec, "style": style}


def reel_plan(ctx, specs, points):
    """The actions of the reel, timed from the characters' own pace. Returns (plan, camera actions, end time)."""
    a, b = specs[0]["id"], specs[1]["id"]
    ra, rb = ctx.actors[a].rig, ctx.actors[b].rig
    bench = np.array(points["bench"][:2])
    x0 = np.array(ctx.actors[a].root(0)[:2])
    dist = float(np.linalg.norm(bench - x0))
    t = 0.3
    walk = max(1.5, dist / (1.25 * nominal_walk_speed(ra)))
    seq = []

    def step(name, dur, **params):
        nonlocal t
        seq.append({"action": name, "t0": round(t, 3), "t1": round(t + dur, 3), "params": params})
        t += dur + 0.1
        return seq[-1]

    w = step("walk", walk, target="bench")
    s = step("sit", 1.3, target="bench")
    wv = step("wave", 1.6)
    pt = step("point", 1.5, target="oak")
    nd = step("nod", 0.9, count=2)
    su = step("stand_up", 1.2)
    end = t + 0.6
    speak = [[round(wv["t0"] + 0.15, 2), round(pt["t1"], 2)]]
    rng = ctx.rng("reel-speech")
    accents = [round(float(x), 2) for x in np.arange(speak[0][0] + 0.3, speak[0][1] - 0.2, 0.46) + rng.uniform(-0.05, 0.05, size=len(np.arange(speak[0][0] + 0.3, speak[0][1] - 0.2, 0.46)))]
    mouth, tt = [], speak[0][0]
    vis = ["A", "E", "MBP", "O", "E", "U", "A", "rest", "E", "A"]
    while tt < speak[0][1]:
        mouth.append([round(tt, 3), vis[int(rng.integers(len(vis)))]])
        tt += float(rng.uniform(0.07, 0.17))
    mouth.append([speak[0][1], "rest"])
    hop_t = 0.4
    other = [
        {"action": "hop", "t0": hop_t, "t1": hop_t + 1.4, "params": {"target": [1.6, 2.6, 0.0]}},
        {"action": "turn", "t0": hop_t + 1.5, "t1": hop_t + 2.0, "params": {"facing": "front"}},
        {"action": "look_at", "t0": 2.0, "t1": 2.5, "params": {"target": a}},
        {"action": "nod", "t0": w["t1"] - 0.8, "t1": w["t1"] + 0.1, "params": {"count": 2}},
        {"action": "react_surprised", "t0": wv["t0"] + 0.35, "t1": wv["t0"] + 1.35, "params": {}},
        {"action": "shake_head", "t0": pt["t0"] + 0.3, "t1": pt["t0"] + 1.3, "params": {"count": 2}},
        {"action": "shrug", "t0": nd["t0"] + 0.1, "t1": nd["t0"] + 1.1, "params": {}},
        {"action": "laugh", "t0": su["t0"] - 0.1, "t1": su["t0"] + 1.6, "params": {}},
    ]
    plan = {a: {"actions": seq, "speaking": speak, "accents": accents, "mouth": mouth}, b: {"actions": other, "listen": a}}
    cam = [
        {"action": "cut", "t0": 0.0, "t1": 0.0, "params": {"shot": "wide"}},
        {"action": "follow", "t0": w["t0"], "t1": w["t1"], "params": {"target": a}},
        {"action": "cut", "t0": s["t0"] - 0.1, "t1": s["t0"] - 0.1, "params": {"shot": "two"}},
        {"action": "shake_small", "t0": wv["t0"] + 0.35, "t1": wv["t0"] + 0.8, "params": {}},
        {"action": "push", "t0": s["t0"] + 0.4, "t1": end - 0.2, "params": {"amount": 0.2}},
    ]
    return plan, cam, end


def make_ctx(info, seconds=None, seed=7):
    specs = info["specs"]
    n = int(math.ceil((seconds or 20.0) * FPS))
    ctx = Ctx(n, seed=seed, points=info["points"], shots={"wide": {"loc": [1.4, -5.2, 1.2], "target": [1.4, 1.0, 0.5], "lens": 38.0}})
    ctx.seats = info["seats"]
    a, b = specs
    marks = info["points"]
    ctx.add_actor(a["id"], a, {"xy": marks["center"][:2], "yaw": 90.0})
    ctx.add_actor(b["id"], b, {"xy": marks["right"][:2], "yaw": -90.0})
    return ctx


@command("reel")
def reel_command(job):
    t_all = time.perf_counter()
    out = job["outDir"]
    os.makedirs(out, exist_ok=True)
    quality = job.get("quality", "preview")
    info = build_reel_scene(job.get("cast", "mini3d"), quality)
    ctx = make_ctx(info, job.get("seconds"))
    progress(0, 4, "plan")
    plan, cam, end = reel_plan(ctx, info["specs"], info["points"])
    ctx.n = ctx.n  # the length is fixed by make_ctx; the plan ends before it
    compose.build(ctx, plan, cam)
    scene = {"actors": {aid: {"controls": r["controls"], "slots": r["slots"], "shadow": info["shadows"][aid]} for aid, r in info["rigs"].items()}, "camera": info["camera"]}
    progress(1, 4, "write")
    t_w = time.perf_counter()
    stats = compose.write(ctx, scene)
    stats["writeSeconds"] = round(time.perf_counter() - t_w, 3)
    sc = bpy.context.scene
    sc.frame_start, sc.frame_end = compose.FIRST_FRAME, compose.FIRST_FRAME + min(ctx.n, int(math.ceil(end * FPS)) + 6) - 1
    sc.render.fps = FPS
    scale = 1.0 if quality == "final" else 0.5
    sc.render.resolution_x, sc.render.resolution_y = 1920, 1080
    sc.render.resolution_percentage = int(100 * scale)
    res = {"stats": stats, "end": end, "frames": sc.frame_end, "plan": plan, "camera": cam}
    with open(os.path.join(out, "reel-plan.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(res, f, indent=1, default=lambda o: o.tolist() if hasattr(o, "tolist") else str(o))
        f.write("\n")
    if job.get("save"):
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, "reel.blend"), compress=True)
    if job.get("render", True):
        progress(2, 4, "render")
        res.update(render_reel(out, sc, job))
    if job.get("stills"):
        res["stills"] = render_stills(out, sc, ctx, job["stills"])
    res["seconds"] = round(time.perf_counter() - t_all, 2)
    return {"out": out, "frames": res["frames"], "end": end, "stats": stats, "render": res.get("render"), "seconds": res["seconds"]}


def render_stills(out, sc, ctx, stills):
    """Close looks for review: [{"frame": f, "view": "main" | "side:<id>" | "front:<id>", "size": 960}] -> out/stills/<view>_<frame>.png (full resolution of the view)."""
    d = os.path.join(out, "stills")
    os.makedirs(d, exist_ok=True)
    main = sc.camera
    cd = bpy.data.cameras.new("still_cam")
    cd.lens = 55
    cam = bpy.data.objects.new("still_cam", cd)
    sc.collection.objects.link(cam)
    files = []
    old = (sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage)
    for s in stills:
        f = int(s["frame"])
        sc.frame_set(f + compose.FIRST_FRAME)
        view = s.get("view", "main")
        if view == "main":
            sc.camera = main
        else:
            kind, who = view.split(":")
            a = ctx.actors[who]
            x, y, rz, yaw = a.root(f)
            h = a.rig.height
            fwd, right = Vector((math.sin(yaw), -math.cos(yaw), 0)), Vector((math.cos(yaw), math.sin(yaw), 0))
            if kind == "side":  # the actor's right side
                cam.location = Vector((x, y, rz + 0.5 * h)) + right * 2.6 * h
            else:  # the front
                cam.location = Vector((x, y, rz + 0.5 * h)) + fwd * 2.6 * h
            cam.rotation_euler = (Vector((x, y, rz + 0.5 * h)) - cam.location).to_track_quat("-Z", "Y").to_euler()
            sc.camera = cam
        sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = int(s.get("size", 960)), int(s.get("size", 960) * 9 / 16), 100
        p = os.path.join(d, f"{view.replace(':', '_')}_{f:04d}.png")
        sc.render.filepath = p
        bpy.ops.render.render(write_still=True)
        files.append(p)
    sc.camera = main
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = old
    return files


def render_reel(out, sc, job):
    frames_dir = os.path.join(out, "frames")
    os.makedirs(frames_dir, exist_ok=True)
    sc.render.image_settings.file_format = "PNG"
    sc.render.filepath = os.path.join(frames_dir, "f_")
    times, mark = {}, {}

    def pre(scene, *_):
        mark["t"] = time.perf_counter()

    def post(scene, *_):
        times[scene.frame_current] = time.perf_counter() - mark["t"]

    bpy.app.handlers.render_pre.append(pre)
    bpy.app.handlers.render_post.append(post)
    try:
        bpy.ops.render.render(animation=True)
    finally:
        bpy.app.handlers.render_pre.remove(pre)
        bpy.app.handlers.render_post.remove(post)
    vals = np.array([times[k] for k in sorted(times)])
    warm = vals[1:] if len(vals) > 1 else vals
    stats = {"frames": len(vals), "first": round(float(vals[0]), 3), "warmMean": round(float(warm.mean()), 3), "p95": round(float(np.percentile(warm, 95)), 3), "total": round(float(vals.sum()), 2)}
    with open(os.path.join(out, "blender-times.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump({**stats, "perFrame": {str(k): round(v, 4) for k, v in sorted(times.items())}}, f)
    encoded = _encode(out, frames_dir, sc.frame_start)
    sheet = contact_sheet(out, frames_dir, sc.frame_start, sc.frame_end, job.get("sheetFrames", 12))
    return {"render": {"times": stats, "mp4": encoded, "sheet": sheet}}


def _encode(out, frames_dir, first):
    ff = os.environ.get("CTS_FFMPEG", "ffmpeg")
    mp4 = os.path.join(out, "reel.mp4")
    try:
        subprocess.run([ff, "-y", "-loglevel", "error", "-framerate", str(FPS), "-start_number", str(first), "-i", os.path.join(frames_dir, "f_%04d.png"), "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", mp4], check=True)
        return mp4
    except (OSError, subprocess.CalledProcessError) as e:
        return f"ffmpeg failed: {e}"


def contact_sheet(out, frames_dir, first, last, count):
    from ..sheets import draw_label, load_pixels, save_pixels, shrink

    picks = np.linspace(first, last, count).round().astype(int)
    tiles = []
    for f in picks:
        px = load_pixels(os.path.join(frames_dir, f"f_{f:04d}.png"))
        h, w = px.shape[:2]
        k = max(1, w // 480)
        px = shrink(px[: h - h % k, : w - w % k], k) if k > 1 else px
        px = np.array(px)
        draw_label(px, f"{(f - first) / FPS:.2f}S", 6, 6, scale=2)
        tiles.append(px)
    th, tw = tiles[0].shape[:2]
    cols = 4
    rows = math.ceil(len(tiles) / cols)
    sheet = np.ones((rows * th, cols * tw, 4), dtype=np.float32)
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        sheet[r * th : (r + 1) * th, c * tw : (c + 1) * tw] = t
    path = os.path.join(out, "contact.png")
    save_pixels(path, sheet)
    return {"file": path, "frames": [int(f - first) for f in picks]}
