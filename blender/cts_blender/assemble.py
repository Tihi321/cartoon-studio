# SPDX-License-Identifier: GPL-3.0-or-later
"""The scene assembler (HUB-30 CTS-25): `timeline.<lang>.json` (cts.timeline3d/1) + the built assets -> `scene.blend` and `assembly.json`.

    job: {timeline, outDir, style?, set: {id, spec, blend}, characters: {<id>: {spec, blend, build?}}, quality?: "final" | "preview"}

Steps: append the set and the characters from their `.blend` files (the same file in every shot and in both languages), put each actor on its start mark,
run the acting library on the timeline's actions (`acting.compose`), key the mouths, lids and pupils, frame the computed shots over the frames they are on
screen (`acting.framing`), add the title cards as 3D text over a plate, save `scene.blend`, write `assembly.json` (actions per actor, shots, spec and asset
hashes, warnings). The camera is one object with dense keys (a cut is a one-frame change, a pan or push an eased move); timeline markers name the shots.
"""
import hashlib
import json
import math
import os
import re
import time

import bpy
import numpy as np
from mathutils import Vector

from . import command, materials as M
from .acting import ACTIONS, compose
from .acting import framing
from .acting.core import FPS, Ctx
from .acting.gait import facing_yaw  # noqa: F401  (kept for the docs: the turn action reads 'left' | 'right' | 'front' | 'back')
from .acting.gestures import _brows
from .acting.core import Clip
from .build_character import find_rig, reset_scene
from .io import CtsError, progress

FACING = {"left": -90.0, "right": 90.0, "front": 0.0, "back": 180.0}
LOCOMOTION = ("walk", "hop", "run")
TAIL_FRAMES = 12
LOOK_SECONDS = 0.45
CONVERSATION_STOP = 0.9  # metres: walking to a cast member stops this far short
PROP_STOP_EXTRA = 0.35
TITLE_AT = (0.0, 400.0, 0.0)
TITLE_PLATE = (12.0, 6.75)


def sha1_file(path):
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------- assets


def append_collection(blend, name):
    """Appends one collection (with its objects, meshes and materials) from a .blend file and links it to the scene."""
    if not os.path.exists(blend):
        raise CtsError("E_ASSEMBLE_FAILED", f"{blend} does not exist: build the asset first")
    with bpy.data.libraries.load(blend, link=False) as (src, dst):
        if name not in src.collections:
            raise CtsError("E_ASSEMBLE_FAILED", f"{blend} has no collection {name!r}")
        dst.collections = [name]
    coll = dst.collections[0]
    bpy.context.scene.collection.children.link(coll)
    return coll


def merge_duplicate_materials():
    """Two appended files bring their own copy of `toon_f6e7cf_0.74_0.36` (`.001`, ...): one copy is enough."""
    for mat in list(bpy.data.materials):
        m = re.match(r"^(.*)\.\d{3}$", mat.name)
        if m and m.group(1) in bpy.data.materials and bpy.data.materials[m.group(1)] is not mat:
            mat.user_remap(bpy.data.materials[m.group(1)])


def seat_info(obj):
    """Where an actor sits and which way it looks: the seat empty's -y axis is the front of the prop (a bench's backrest is at +y), so a seated actor
    faces away from the backrest."""
    m = obj.matrix_world
    fwd = m.to_3x3() @ Vector((0, -1, 0))
    return {"xy": [m.translation.x, m.translation.y], "z": m.translation.z, "yaw": math.atan2(fwd.x, -fwd.y)}


def scene_points(set_coll, set_spec):
    """marks, prop aim points, seats (from the empties of the set) and the named cameras of the set spec."""
    points, seats = {}, {}
    objs = list(set_coll.objects)
    for ob in objs:
        if "cts_mark" in ob:
            points[ob["cts_mark"]] = (ob.matrix_world.translation.x, ob.matrix_world.translation.y, 0.0)
    marks = set(points)
    for ob in objs:  # a mark wins over a prop of the same name
        if "cts_prop" in ob and ob["cts_prop"] not in marks:
            points[ob["cts_prop"]] = (ob.location.x, ob.location.y, 1.6 * ob.scale.x)
        if "cts_seat" in ob:
            seats[ob["cts_seat"]] = seat_info(ob)
    cameras = {n: {"loc": list(c["loc"]), "target": list(c["target"]), "lens": float(c["lens"])} for n, c in (set_spec.get("cameras") or {}).items()}
    return points, seats, cameras


# ---------------------------------------------------------------- the plan of the acting library


def facing_degrees(f):
    if isinstance(f, (int, float)):
        return float(f)
    if f in FACING:
        return FACING[f]
    raise CtsError("E_ASSEMBLE_FAILED", f"unknown facing {f!r}")


def prop_footprints(set_spec):
    from .build_set import KIT

    return {p["id"]: KIT[p["kind"]]["footprint"] * p.get("scale", 1.0) for p in set_spec["props"]}


def make_plan(ctx, tl, set_spec, warnings):
    """{actor: {actions, speaking, accents, blinks, mouth, listen}} for compose.build."""
    foot = prop_footprints(set_spec)
    marks = set(set_spec["marks"])
    plan = {}
    speakers = [aid for aid, a in tl["actors"].items() if a.get("speaking")]
    for aid, a in tl["actors"].items():
        acts = []
        for x in a["actions"]:
            if x["action"] not in ACTIONS:
                raise CtsError("E_ACTION_UNKNOWN", f"action {x['action']!r} (beat {x['beat']}) is not in the acting library")
            p = dict(x.get("params") or {})
            tgt = p.get("target")
            if isinstance(tgt, str):
                known = tgt in ctx.actors or tgt in ctx.points or tgt in ctx.seats
                if not known or (x["action"] == "sit" and tgt not in ctx.seats):
                    raise CtsError("E_MARK_UNKNOWN", f"beat {x['beat']}: {x['action']} target {tgt!r} is not a cast id, a mark, or (sit) a prop with a seat")
                if x["action"] in LOCOMOTION and tgt not in marks:
                    if tgt in ctx.actors:
                        p.setdefault("stop", CONVERSATION_STOP)
                    elif tgt in foot:
                        p.setdefault("stop", foot[tgt] + PROP_STOP_EXTRA)
            acts.append({"action": x["action"], "t0": float(x["t0"]), "t1": float(x["t1"]), "params": p, "beat": x["beat"]})
        for t, target in a.get("look") or []:
            if target is not None and target not in ctx.actors and target not in ctx.points:
                raise CtsError("E_MARK_UNKNOWN", f"look target {target!r} is not a cast id, a prop or a mark")
            acts.append({"action": "look_at", "t0": float(t), "t1": float(t) + LOOK_SECONDS, "params": {"target": target}, "beat": "look"})
        plan[aid] = {
            "actions": acts,
            "speaking": a.get("speaking") or [],
            "accents": a.get("accents") or [],
            "blinks": a.get("blinks") or [],
            "mouth": a.get("mouth") or [],
            "listen": [s for s in speakers if s != aid],
        }
    return plan


# ---------------------------------------------------------------- emotions (a face state that holds until the next one)

EMOTIONS = {
    #            brow lift, brow tilt (deg), lid (0 open ... 1 closed), frown
    "neutral": (0.0, 0.0, 0.0, False),
    "happy": (0.25, 0.0, 0.12, False),
    "excited": (0.45, 0.0, 0.0, False),
    "surprised": (0.9, 0.0, 0.0, False),
    "sad": (0.3, 14.0, 0.35, True),
    "worried": (0.3, 10.0, 0.15, False),
    "angry": (-0.35, -14.0, 0.2, True),
    "sleepy": (0.0, 0.0, 0.6, False),
    "proud": (0.2, 0.0, 0.2, False),
}


def emotion_clip(ctx, actor, track, warnings):
    """The brows, half lids and a frown for the emotion in force, eased over 6 frames between emotions."""
    n = ctx.n
    lift, tilt, lid, frown = np.zeros(n), np.zeros(n), np.zeros(n), np.zeros(n, dtype=bool)
    keys = sorted(track or [])
    for i, (t, name) in enumerate(keys):
        vals = EMOTIONS.get(name)
        if vals is None:
            warnings.append(f"emotion {name!r} of {actor.id} is not one the assembler knows ({', '.join(EMOTIONS)}); shown as neutral")
            vals = EMOTIONS["neutral"]
        f0 = ctx.f(t)
        f1 = ctx.f(keys[i + 1][0]) if i + 1 < len(keys) else n
        lift[f0:f1], tilt[f0:f1], lid[f0:f1], frown[f0:f1] = vals[0], math.radians(vals[1]), vals[2], vals[3]
    k = np.ones(6) / 6.0
    soft = lambda a: np.convolve(np.pad(a, (5, 0), mode="edge"), k, mode="valid")[:n]  # noqa: E731
    clip = Clip(0, n - 1)
    if np.any(lift) or np.any(tilt):
        _brows(clip, actor.rig, 0, soft(lift), soft(tilt))
    if np.any(lid):
        clip.lid(0, soft(lid))
    if np.any(frown):
        clip.items.append(("face", "mouth", "frown", 0, frown, "frown"))
    return clip


# ---------------------------------------------------------------- cameras and title cards


def add_title_cards(titles, style, horizon, set_name):
    """3D text over a plate for each title card, far from the set. Returns [{id, t0, t1, shot}] with the camera of each."""
    if not titles:
        return []
    from . import shapes as S

    coll = bpy.data.collections.new("cts_titles")
    bpy.context.scene.collection.children.link(coll)
    plate_mat = M.flat(horizon, "title_plate")
    ink_mat = M.flat(style["outline"]["colour"], "title_ink")
    out = []
    for k, t in enumerate(titles):
        x = TITLE_AT[0] + 40.0 * k
        bm = S.new_bm()
        S.add_box(bm, (TITLE_PLATE[0], 0.05, TITLE_PLATE[1]), (0, 0, 0))
        plate = S.make_object(f"title_plate_{k}", bm, plate_mat, None, (x, TITLE_AT[1], TITLE_AT[2]), (0, 0, 0), smooth=False, collection=coll)
        plate["cts_title"] = t["id"]
        words, lines, cur = str(t["text"]).split(), [], ""
        for w in words:
            if cur and len(cur) + 1 + len(w) > 22:
                lines.append(cur)
                cur = w
            else:
                cur = (cur + " " + w).strip()
        lines.append(cur)
        cu = bpy.data.curves.new(f"title_text_{k}", "FONT")
        cu.body = "\n".join(lines)
        cu.align_x, cu.align_y = "CENTER", "CENTER"
        cu.size = 0.9
        cu.extrude = 0.03
        cu.materials.append(ink_mat)
        text = bpy.data.objects.new(f"title_text_{k}", cu)
        coll.objects.link(text)
        text.location = (x, TITLE_AT[1] - 0.12, TITLE_AT[2])
        text.rotation_euler = (math.pi / 2, 0, 0)  # stands up, facing -y (the camera)
        bpy.context.view_layer.update()
        w_now = max(text.dimensions.x, 1e-6)
        h_now = max(text.dimensions.y, 1e-6)
        s = min(1.0, TITLE_PLATE[0] * 0.78 / w_now, TITLE_PLATE[1] * 0.6 / h_now)
        text.scale = (s, s, s)
        out.append({"id": t["id"], "t0": float(t["t0"]), "t1": float(t["t1"]), "shot": {"loc": [x, TITLE_AT[1] - 8.0, TITLE_AT[2]], "target": [x, TITLE_AT[1], TITLE_AT[2]], "lens": 35.0}})
    return out


def plan_camera(ctx, shots, cards, aspect):
    """Applies the cuts, pans and pushes (and the title cards) to ctx.camera in time order. Returns the resolved shots for assembly.json."""
    events = []
    for i, s in enumerate(sorted(shots, key=lambda s: s["t"])):
        events.append((float(s["t"]), 1, "shot", s, i))
    for c in cards:  # at one time: the card ends, then a shot may start, then the next card begins
        events.append((c["t0"], 2, "title-in", c, 0))
        events.append((c["t1"], 0, "title-out", c, 0))
    events.sort(key=lambda e: (e[0], e[1]))
    ordered = sorted(shots, key=lambda s: s["t"])
    resolved, current, on_card = [], None, False
    for t, _o, kind, item, idx in events:
        if kind == "title-in":
            clip = ACTIONS["cut"](ctx, None, t, t, {"shot": item["shot"]})
            ctx.camera.apply(clip)
            on_card = True
            resolved.append({"t": t, "shot": f"title:{item['id']}", "transition": "cut", **item["shot"]})
        elif kind == "title-out":
            on_card = False
            if current is not None:
                ctx.camera.apply(ACTIONS["cut"](ctx, None, t, t, {"shot": current}))
        else:
            s = item
            secs = float(s.get("seconds") or 0.0) if s["transition"] != "cut" else 0.0
            f_on = ctx.f(float(s["t"]) + secs)
            nxt = ordered[idx + 1]["t"] if idx + 1 < len(ordered) else None
            f_off = ctx.f(float(nxt)) if nxt is not None else ctx.n - 1
            try:
                dct = framing.shot(ctx, s["shot"], f_on, max(f_off, f_on), aspect)
            except KeyError as e:
                raise CtsError("E_SHOT_UNKNOWN", str(e).strip("'\""))
            kinds = {"cut": "cut", "pan": "pan", "push": "push"}
            current = dct
            if on_card:  # a shot that starts under a title card shows when the card ends
                continue
            clip = ACTIONS[kinds[s["transition"]]](ctx, None, float(s["t"]), float(s["t"]) + secs, {"shot": dct})
            ctx.camera.apply(clip)
            resolved.append({"t": float(s["t"]), "shot": s["shot"], "transition": s["transition"], **({"seconds": secs} if secs else {}), **{k: [round(float(x), 3) for x in v] if isinstance(v, (list, tuple)) else v for k, v in dct.items()}})
    return resolved


# ---------------------------------------------------------------- the command


def hashes_of(spec_path, blend, build_path):
    info = {"specHash": sha1_file(spec_path), "assetHash": sha1_file(blend)}
    if build_path and os.path.exists(build_path):
        info["buildSpecHash"] = read_json(build_path).get("specHash")
    return info


@command("assemble")
def assemble_command(job):
    t_all = time.perf_counter()
    tl = read_json(job["timeline"])
    if tl.get("schema") != "cts.timeline3d/1":
        raise CtsError("E_SCHEMA", f"{job['timeline']}: not a cts.timeline3d/1 file")
    out = job["outDir"]
    os.makedirs(out, exist_ok=True)
    style = M.load_style(job.get("style"))
    warnings = []
    progress(0, 6, "assets")
    reset_scene()
    sc = bpy.context.scene
    set_job = job["set"]
    set_spec = read_json(set_job["spec"])
    set_coll = append_collection(set_job["blend"], f"set_{set_job['id']}")
    rigs, shadows, specs = {}, {}, {}
    for cid, c in job["characters"].items():
        append_collection(c["blend"], f"char_{cid}")
        specs[cid] = read_json(c["spec"])
    merge_duplicate_materials()
    bpy.context.view_layer.update()
    for cid in job["characters"]:
        rigs[cid] = find_rig(cid)
        shadows[cid] = next((o for o in rigs[cid]["objects"] if "cts_shadow" in o), None)
    M.apply_look(sc, style, job.get("quality", "final"), sky=set_spec["sky"])
    cd = bpy.data.cameras.new("cts_cam")
    cd.clip_end = 800.0
    cam = bpy.data.objects.new("cts_cam", cd)
    sc.collection.objects.link(cam)
    sc.camera = cam

    points, seats, cameras = scene_points(set_coll, set_spec)
    frames = int(math.ceil(float(tl["duration"]) * FPS))
    ctx = Ctx(frames + TAIL_FRAMES, seed=int(tl["seed"]), points=points, shots=cameras)
    ctx.seats = seats
    for aid, a in tl["actors"].items():
        if aid not in specs:
            raise CtsError("E_ASSEMBLE_FAILED", f"the timeline has actor {aid!r} but the job has no character for it")
        st = a["start"]
        if st["mark"] not in points:
            raise CtsError("E_MARK_UNKNOWN", f"start mark {st['mark']!r} of {aid} is not a mark of the set")
        ctx.add_actor(aid, specs[aid], {"xy": points[st["mark"]][:2], "yaw": facing_degrees(st["facing"])})
    progress(1, 6, "plan")
    plan = make_plan(ctx, tl, set_spec, warnings)
    try:
        compose.build(ctx, plan, None)
    except KeyError as e:
        raise CtsError("E_ASSEMBLE_FAILED", f"the acting library could not run the plan: {e}")
    for aid, a in tl["actors"].items():
        emotion_clip(ctx, ctx.actors[aid], a.get("emotion"), warnings).apply(ctx.actors[aid].mix)
    progress(2, 6, "camera")
    aspect = tl["size"][0] / tl["size"][1]
    cards = add_title_cards(tl.get("titles") or [], style, set_spec["sky"]["horizon"], set_job["id"])
    shots = plan_camera(ctx, tl["shots"], cards, aspect)
    progress(3, 6, "keys")
    scene = {"actors": {aid: {"controls": r["controls"], "slots": r["slots"], "shadow": shadows[aid]} for aid, r in rigs.items()}, "camera": cam}
    stats = compose.write(ctx, scene)
    sc.frame_start, sc.frame_end = compose.FIRST_FRAME, compose.FIRST_FRAME + frames - 1
    sc.render.fps = FPS
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = int(tl["size"][0]), int(tl["size"][1]), 100
    for s in shots:
        sc.timeline_markers.new(s["shot"], frame=compose.FIRST_FRAME + ctx.f(s["t"]))
    blend = os.path.join(out, "scene.blend")
    progress(4, 6, "save")
    bpy.ops.wm.save_as_mainfile(filepath=blend, compress=True)

    chars = {}
    for cid, c in job["characters"].items():
        chars[cid] = hashes_of(c["spec"], c["blend"], c.get("build"))
        if chars[cid].get("buildSpecHash") not in (None, chars[cid]["specHash"]):
            warnings.append(f"character.blend of {cid} was built from another character.json (rebuild it: cts_character_build)")
    set_hash = hashes_of(set_job["spec"], set_job["blend"], set_job.get("build"))
    if set_hash.get("buildSpecHash") not in (None, set_hash["specHash"]):
        warnings.append(f"set.blend of {set_job['id']} was built from another set3d.json (rebuild it: cts_set3d_build)")
    names = sorted({x["action"] for a in tl["actors"].values() for x in a["actions"]})
    info = {
        "schema": "cts.assembly/1",
        "series": tl["series"],
        "episode": tl["episode"],
        "lang": tl["lang"],
        "scriptHash": tl["scriptHash"],
        "timelineHash": sha1_file(job["timeline"]),
        "blender": bpy.app.version_string,
        "fps": FPS,
        "frames": frames,
        "size": tl["size"],
        "set": {"id": set_job["id"], **set_hash},
        "actors": {
            aid: {**chars[aid], "start": a["start"], "actions": a["actions"], "blinks": len(a.get("blinks") or []), "accents": len(a.get("accents") or []), "speaking": a.get("speaking") or []}
            for aid, a in tl["actors"].items()
        },
        "actionNames": names,
        "shots": shots,
        "titles": [{"id": c["id"], "t0": c["t0"], "t1": c["t1"]} for c in cards],
        "keys": stats,
        "warnings": warnings,
        "assembleSeconds": round(time.perf_counter() - t_all, 2),
    }
    with open(os.path.join(out, "assembly.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(info, f, indent=2)
        f.write("\n")
    progress(6, 6, "done")
    return {"blend": blend, "assembly": os.path.join(out, "assembly.json"), "frames": frames, "actions": names, "shots": len(shots), "warnings": warnings, "assembleSeconds": info["assembleSeconds"], "keys": stats}
