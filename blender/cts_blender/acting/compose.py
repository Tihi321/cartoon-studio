# SPDX-License-Identifier: GPL-3.0-or-later
"""Layer composition and the dense-channel writer.

build(ctx, plan, camera): runs the actions in the order the layers need (locomotion and posture first, then looks, gestures and reactions, then the
automatic acting: lip-sync, blinks, talking accents, idle, and last the springs) and leaves the channels in `ctx.actors[id].mix` and `ctx.camera`.
write(ctx, scene): bakes them to keys on the Blender objects, one dense curve per animated channel, through api5.

plan = { actor_id: { "actions": [ {"action": "walk", "t0": 0.0, "t1": 3.2, "params": {...}} ],
                     "speaking": [[t0, t1]], "accents": [t], "blinks": [t], "mouth": [[t, "A"]], "listen": speaker_id | [speaker_ids] } }
camera = [ {"action": "cut", "t0": 0, "t1": 0, "params": {"shot": "wide"}}, ... ]   (cut, pan, push, follow, shake_small)

Vehicles (HUB-31): `drive zoom reverse chug` are base actions like `walk`; `idle_engine` is the automatic idle; the writer also keys the lamp glow
(`Mix.glow` on the `lamp_glow` property of the head control, or of `info["lamp"]`) and plays `Mix.puffs` on the puff pools (`info["puffs"]`, else
the objects with `cts_puff` in the character's collection).
"""
import numpy as np

from . import ACTIONS, library
from .camera import CameraTrack, computed_shot, vec7
from .core import FPS, TAU, Clip, knots
from .gestures import SLOT, auto_blink_times, blink_amounts, idle_clip, listening_actions, talking_clip
from .springs import bake_secondary

BASE_ACTIONS = ("walk", "hop", "run", "turn", "sit", "stand_up", "drive", "zoom", "reverse", "chug")
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
    for actor in ctx.actors.values():  # CTS-41: every per-actor state (channels, clips, moving, seated, park) starts again
        actor.reset()
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
            if a["action"] not in BASE_ACTIONS and a["action"] != "look_at" and a["action"] not in ("idle", "idle_engine", "blink"):
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
    extra = {}  # object -> curves that are not transforms of a control (the lamp glow, the puffs), merged into that object's one action

    def put(idb, name, curves):
        k = api5.write_dense(idb, name, curves)
        if k:
            stats["keys"] += k
            stats["curves"] += len(curves)
            stats["objects"] += 1

    for aid, info in scene["actors"].items():
        actor = ctx.actors[aid]
        mix, rig = actor.mix, actor.rig
        _vehicle_extras(ctx, actor, info, frames, extra)
        for ctl in sorted(mix.touched()):
            obj = info["controls"].get(ctl)
            if obj is None:
                continue
            curves = dict(extra.pop(obj, {}))
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
        floor = info.get("floor")  # a vehicle (HUB-31): fn(xy) -> the ground under it (road top, sleepers, crossing boards), so the shadow lies on it
        if sh is not None and floor is not None:
            fl = np.asarray(floor(mix.value("root", "location")[:, :2]), dtype=float)
            k = 1.0 - 0.35 * np.clip((z - fl) / max(rig.height, 1e-6), 0, 1)
            curves = {("location", 2): (frames, sh.location.z + fl - z, "LINEAR")}
            for axis in (0, 1):
                curves[("scale", axis)] = (frames, sh.scale[axis] * k, "LINEAR")
            put(sh, f"{aid}_shadow", curves)
        elif sh is not None and np.ptp(z) > 1e-6:
            k = 1.0 - 0.35 * np.clip(z / max(rig.height, 1e-6), 0, 1)
            curves = {("location", 2): (frames, sh.location.z - z, "LINEAR")}
            for axis in (0, 1):
                curves[("scale", axis)] = (frames, sh.scale[axis] * k, "LINEAR")
            put(sh, f"{aid}_shadow", curves)
    for obj, curves in list(extra.items()):
        put(obj, f"{obj.name}_fx", curves)
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


PUFF_LIFE_S = 1.3


def _actor_objects(info):
    objs = info.get("objects")
    if objs:
        return list(objs)
    seen, out = set(), []
    for ob in info["controls"].values():
        for coll in ob.users_collection:
            for o in coll.objects:
                if o.name not in seen:
                    seen.add(o.name)
                    out.append(o)
    return out


def _vehicle_extras(ctx, actor, info, frames, extra):
    """The lamp glow and the puffs of a vehicle, as curves in `extra` (nothing for a creature: its Mix has no glow and no puffs)."""
    mix = actor.mix
    glow = getattr(mix, "glow", None)
    puffs = getattr(mix, "puffs", None) or []
    if (glow is None or not np.any(np.abs(glow) > 1e-6)) and not puffs:
        return
    if glow is not None and np.any(np.abs(glow) > 1e-6):
        lamps = [info["lamp"]] if info.get("lamp") is not None else [o for o in _actor_objects(info) if "lamp_glow" in o.keys()]
        if not lamps and info["controls"].get("head") is not None:
            lamps = [info["controls"]["head"]]
        for ob in lamps:
            if "lamp_glow" not in ob.keys():
                ob["lamp_glow"] = 0.0
            rest = float(ob["lamp_glow"])
            extra.setdefault(ob, {})[('["lamp_glow"]', 0)] = (frames, np.clip(rest + glow, 0.0, 1.0), "LINEAR")
    if puffs:
        pools = info.get("puffs")
        if not pools:
            pools = {}
            for o in sorted((o for o in _actor_objects(info) if "cts_puff" in o.keys()), key=lambda o: (str(o.get("cts_puff_source", "")), int(o["cts_puff"]))):
                pools.setdefault(o.get("cts_puff_source") or (o.parent.get("cts_control") if o.parent else None), []).append(o)
        for ob, curves in _puff_curves(ctx, puffs, pools, frames).items():
            extra.setdefault(ob, {}).update(curves)


def _puff_curves(ctx, events, pools, frames):
    """Plays puff events on the pools: each event takes the cloud of its source that has been free longest; the cloud pops out of the source,
    grows, rises and drifts back (by the vehicle's speed at the time, so it stays behind), then shrinks away. Hidden (its rest scale) otherwise."""
    n = ctx.n
    life = int(round(PUFF_LIFE_S * FPS))
    state = {}
    free_at = {}
    for ev in sorted(events, key=lambda e: e["f"]):
        pool = pools.get(ev["source"]) or []
        if not pool:
            continue
        ob = min(pool, key=lambda o: free_at.get(o.name, -1))
        if ob.name not in state:
            rest_l, rest_s = np.array(ob.location, dtype=float), np.array(ob.scale, dtype=float)
            state[ob.name] = (ob, np.tile(rest_l, (n, 1)), np.tile(rest_s, (n, 1)), rest_l)
        _, loc, sc, rest_l = state[ob.name]
        size = float(ev["size"])
        full = float(ob.get("cts_puff_scale", 1.0)) * size
        L = int(life * (0.8 + 0.3 * size))
        f = int(ev["f"])
        k = np.arange(min(L, n - f))
        u = k / max(L, 1)
        grow = knots([(0, 0.05), (0.12 * L, 0.85), (0.6 * L, 1.15), (L - 1, 0.0)], L)[: len(k)]
        sc[f : f + len(k)] = np.maximum(grow, 1e-4)[:, None] * full
        t = k / FPS
        rise = (0.25 + 0.9 * size) if ev["source"] != "exhaust" else (0.06 + 0.25 * size)  # chimney smoke climbs; exhaust smoke hangs low behind
        back = 0.12 * size if ev["source"] != "exhaust" else 0.45 * size
        loc[f : f + len(k)] = rest_l + np.stack([0.05 * size * np.sin(TAU * 0.6 * t), ev["drift"] * t + back * u, rise * (1 - (1 - u) ** 2)], axis=1)
        free_at[ob.name] = f + L
    out = {}
    for ob, loc, sc, _ in state.values():
        c = {}
        for a in range(3):
            c[("location", a)] = (frames, loc[:, a], "LINEAR")
            c[("scale", a)] = (frames, sc[:, a], "LINEAR")
        out[ob] = c
    return out


def check_registry():
    """Names in the Python registry vs library.json: (only in code, only in the manifest)."""
    names = {a["name"] for a in library()["actions"]}
    return sorted(set(ACTIONS) - names), sorted(names - set(ACTIONS))
