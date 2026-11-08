# SPDX-License-Identifier: GPL-3.0-or-later
"""Layer composition and the dense-channel writer.

build(ctx, plan, camera): runs the actions in the order the layers need (locomotion and posture first, then looks, gestures and reactions, then the
automatic acting: lip-sync, blinks, talking accents, idle, and last the springs) and leaves the channels in `ctx.actors[id].mix` and `ctx.camera`.
write(ctx, scene): bakes them to keys on the Blender objects, one dense curve per animated channel, through api5.

plan = { actor_id: { "actions": [ {"action": "walk", "t0": 0.0, "t1": 3.2, "params": {...}} ],
                     "speaking": [[t0, t1]], "accents": [t], "blinks": [t], "mouth": [[t, "A"]], "listen": speaker_id | [speaker_ids] } }
camera = [ {"action": "cut", "t0": 0, "t1": 0, "params": {"shot": "wide"}}, ... ]   (cut, pan, push, follow, shake_small)
"""
import numpy as np

from . import ACTIONS, library
from .camera import CameraTrack, computed_shot, vec7
from .core import FPS, Clip
from .gestures import SLOT, auto_blink_times, blink_amounts, idle_clip, listening_actions, talking_clip
from .springs import bake_secondary

BASE_ACTIONS = ("walk", "hop", "run", "turn", "sit", "stand_up")
FIRST_FRAME = 1  # frame f of the timeline is Blender frame f + 1


def _run(ctx, actor, a):
    fn = ACTIONS.get(a["action"])
    if fn is None:
        raise KeyError(f"unknown action {a['action']!r}")
    clip = fn(ctx, actor, float(a["t0"]), float(a["t1"]), dict(a.get("params") or {}))
    clip.apply(actor.mix)
    actor.clips.append((a, clip))
    return clip


def build(ctx, plan, camera=None):
    ctx.camera = CameraTrack(ctx.n)
    init = ctx.shots.get("wide") or (computed_shot(ctx, "wide", 0) if ctx.actors else None)
    if init is not None:
        ctx.camera.state[:] = vec7(init)
    for actor in ctx.actors.values():
        actor.clips = []
    acts = {aid: sorted(p.get("actions") or [], key=lambda a: (a["t0"], a["t1"])) for aid, p in plan.items()}
    # 1. locomotion and posture (a state that holds): actors in plan order, actions in time order
    for aid, lst in acts.items():
        for a in lst:
            if a["action"] in BASE_ACTIONS:
                _run(ctx, ctx.actors[aid], a)
    # 2. listening: looks at the speaker and nods, for actors nobody gave a beat
    for aid, p in plan.items():
        sps = p.get("listen")  # one speaker id, or a list of them
        for sp in [sps] if isinstance(sps, str) else (sps or []):
            if sp in plan and sp != aid:
                listener = ctx.actors[aid]
                extra = listening_actions(ctx, listener, sp, plan[sp].get("speaking") or [], plan[sp].get("accents") or [], [a for a in acts[aid] if a["action"] == "look_at"])
                acts[aid] = sorted(acts[aid] + extra, key=lambda a: (a["t0"], a["t1"]))
    # 3. lip-sync first, so a laugh can open the mouth over it
    for aid, p in plan.items():
        if p.get("mouth"):
            _lipsync(ctx, ctx.actors[aid], p["mouth"])
    # 4. looks (each holds until the next), then gestures and reactions
    big = []
    for aid, lst in acts.items():
        actor = ctx.actors[aid]
        looks = [a for a in lst if a["action"] == "look_at"]
        for i, a in enumerate(looks):
            nxt = ctx.f(looks[i + 1]["t0"]) - 1 if i + 1 < len(looks) else ctx.n - 1
            a = dict(a, params=dict(a.get("params") or {}, _hold_to=nxt))
            clip = _run(ctx, actor, a)
            if clip.meta.get("bigTurn"):
                big.append((aid, clip.meta["f0"] + 2))
        for a in lst:
            if a["action"] not in BASE_ACTIONS and a["action"] != "look_at" and a["action"] not in ("idle", "blink"):
                _run(ctx, actor, a)
            elif a["action"] == "blink":
                _run(ctx, actor, a)
    # 5. automatic: talking accents, blinks (seeded, plus on a big head turn), idle
    for aid, p in plan.items():
        actor = ctx.actors[aid]
        if p.get("accents") and p.get("speaking") is not None:
            ins = [t for t in p["accents"] if any(a <= t <= b for a, b in p["speaking"])]
            talking_clip(ctx, actor, ins).apply(actor.mix)
        c = Clip(0, ctx.n - 1)
        for t in auto_blink_times(ctx, actor, ctx.n / FPS, p.get("blinks")):
            c.lid(ctx.f(t), blink_amounts())
        for who, f in big:
            if who == aid:
                c.lid(f, blink_amounts())
        c.apply(actor.mix)
        idle_clip(ctx, actor).apply(actor.mix)
    # 6. secondary motion, baked last from everything above
    for actor in ctx.actors.values():
        bake_secondary(ctx, actor)
    # 7. the camera
    for a in sorted(camera or [], key=lambda a: (a["t0"], a["t1"])):
        clip = ACTIONS[a["action"]](ctx, None, float(a["t0"]), float(a["t1"]), dict(a.get("params") or {}))
        ctx.camera.apply(clip)
    return ctx


def _lipsync(ctx, actor, mouth):
    idx = np.zeros(ctx.n, dtype=int)
    pts = sorted((ctx.f(t), SLOT[v]) for t, v in mouth)
    for i, (f, v) in enumerate(pts):
        end = pts[i + 1][0] if i + 1 < len(pts) else ctx.n
        idx[f:end] = v
    actor.mix.mouth[:] = idx


# ---------------------------------------------------------------- the writer


def _curves(mix_obj, rest, delta, frames, interp="LINEAR", props=None):
    out = {}
    for axis in range(3):
        v = rest[axis] + delta[:, axis]
        if np.ptp(v) > 1e-7 or abs(v[0] - rest[axis]) > 1e-7:
            out[axis] = (frames, v, interp)
    return out


def write(ctx, scene):
    """scene = {"actors": {id: {"controls": {name: obj}, "slots": {slot: obj}, "shadow": obj | None, "rig": Rig}}, "camera": obj | None}. Returns key counts."""
    import math

    from .. import api5
    from ..build_character import SLOTS, lid_pose

    frames = np.arange(ctx.n, dtype=float) + FIRST_FRAME
    stats = {"keys": 0, "curves": 0, "objects": 0}

    def put(idb, name, curves):
        k = api5.write_dense(idb, name, curves)
        if k:
            stats["keys"] += k
            stats["curves"] += len(curves)
            stats["objects"] += 1

    for aid, info in scene["actors"].items():
        actor = ctx.actors[aid]
        mix, rig = actor.mix, actor.rig
        for ctl in sorted(mix.touched()):
            obj = info["controls"].get(ctl)
            if obj is None:
                continue
            curves = {}
            for prop, rest in (("location", obj.location), ("rotation_euler", obj.rotation_euler), ("scale", obj.scale)):
                d = mix.delta(ctl, prop)
                if not np.any(np.abs(d) > 1e-9):
                    continue
                for axis, c in _curves(obj, list(rest), d, frames).items():
                    curves[(prop, axis)] = c
            put(obj, f"{aid}_{ctl}", curves)
        eye_r = rig.eye_r
        for side in "LR":
            obj = info["controls"].get(f"lid_{side}")
            amt = mix.lid[side]
            if obj is None or not np.any(amt > 0.02):
                continue
            z0 = obj.location.z
            loc = np.empty(ctx.n)
            sc = np.empty((ctx.n, 3))
            for i, a in enumerate(amt):
                dz, s = lid_pose(float(a), eye_r)
                loc[i], sc[i] = z0 + dz, s
            curves = {("location", 2): (frames, loc, "CONSTANT")}
            for axis in range(3):
                curves[("scale", axis)] = (frames, sc[:, axis], "CONSTANT")
            put(obj, f"{aid}_lid_{side}", curves)
        slots = info["slots"]
        if slots and (mix.mouth.any() or mix.frown.any() or mix.mouth_set.any()):
            names = list(SLOTS)
            for slot, obj in slots.items():
                shown = mix.mouth == names.index(slot)
                sc = np.where(shown[:, None], 1.0, 0.0001) * np.ones((ctx.n, 3))
                if slot == "rest":
                    sc[:, 2] = np.where(shown, np.where(mix.frown, -1.0, 1.0), 0.0001)
                put(obj, f"{aid}_mouth_{slot}", {("scale", a): (frames, sc[:, a], "CONSTANT") for a in range(3)})
        sh = info.get("shadow")
        z = mix.value("root", "location")[:, 2]
        if sh is not None and np.ptp(z) > 1e-6:
            k = 1.0 - 0.35 * np.clip(z / max(rig.height, 1e-6), 0, 1)
            curves = {("location", 2): (frames, sh.location.z - z, "LINEAR")}
            for axis in (0, 1):
                curves[("scale", axis)] = (frames, sh.scale[axis] * k, "LINEAR")
            put(sh, f"{aid}_shadow", curves)
    cam = scene.get("camera")
    if cam is not None and ctx.camera is not None and ctx.camera.used:
        from mathutils import Vector

        st = ctx.camera.total()
        eul = np.zeros((ctx.n, 3))
        prev = None
        for i in range(ctx.n):
            q = (Vector(st[i, 3:6]) - Vector(st[i, 0:3])).to_track_quat("-Z", "Y")
            e = q.to_euler("XYZ", prev) if prev is not None else q.to_euler("XYZ")
            eul[i] = (e.x, e.y, e.z)
            prev = e
        curves = {}
        for a in range(3):
            curves[("location", a)] = (frames, st[:, a], "LINEAR")
            curves[("rotation_euler", a)] = (frames, eul[:, a], "LINEAR")
        put(cam, "camera", curves)
        if np.ptp(st[:, 6]) > 1e-6:
            put(cam.data, "camera_lens", {("lens", 0): (frames, st[:, 6], "LINEAR")})
    return stats


def check_registry():
    """Names in the Python registry vs library.json: (only in code, only in the manifest)."""
    names = {a["name"] for a in library()["actions"]}
    return sorted(set(ACTIONS) - names), sorted(names - set(ACTIONS))
