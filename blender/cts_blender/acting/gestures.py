# SPDX-License-Identifier: GPL-3.0-or-later
"""Gestures, reactions, looking, blinking, idle, and the listening and talking automation.

Every gesture is a scalar envelope (`gesture_env`: anticipation, rise with overshoot, moving hold, return with overshoot, settle) times a pose, and the parts
follow it with offsets: the body leads, the head lags 2 frames, the arms 1-3 frames. Arms are directions about the shoulder, so a hand moves on an arc, and
every arm direction passes `clamp_arm` (outside the body). All deltas are additive to what the base layer holds and end at exactly zero by t1 + settle.
"""
import math

import numpy as np

from . import BOTH, action
from .core import FPS, TAU, Clip, gesture_env, knots, shift, smoothstep, sphere_dir, window, wrap_pi
from .limbs import arm_delta, clamp_arm

DEG = math.radians
SLOT = {"rest": 0, "A": 1, "E": 2, "O": 3, "U": 4, "MBP": 5}


def _vehicle(actor):
    """The vehicle family (HUB-31) when the actor is a vehicle, else None: a shared action branches to it before the creature code."""
    if actor is not None and actor.rig.spec.get("kind") == "vehicle":
        from . import vehicle

        return vehicle
    return None


def _frames(ctx, t0, t1):
    f0, f1 = ctx.f(t0), ctx.f(t1)
    return f0, f1, f1 - f0, (f1 - f0) + 1 + ctx.settle


def _rot(x=0.0, y=0.0, z=0.0, m=None):
    """A (m, 3) euler series from scalars or arrays."""
    arrs = [np.asarray(a, dtype=float) for a in (x, y, z)]
    m = max((len(a) for a in arrs if a.ndim), default=m or 1)
    out = np.zeros((m, 3))
    for i, a in enumerate(arrs):
        out[:, i] = a
    return out


def _vec(m, x=0.0, y=0.0, z=0.0):
    return _rot(x, y, z, m)


def _arm(clip, ctx, actor, side, f0, dirs, layer="gesture"):
    """A gesture on an arm: `dirs` (m, 3) are the wanted directions; the delta is relative to what the base layer holds."""
    rig, mix = actor.rig, actor.mix
    if not rig.has(f"arm_{side}"):
        return
    base = mix.delta_at(f"arm_{side}", "rotation_euler", f0)
    rest = rig.rest_rot[f"arm_{side}"]
    d = arm_delta(rig, mix, side, clamp_arm(rig, side, dirs), f0, ref=(base[0] + rest[0], base[1] + rest[1]))
    clip.put(layer, f"arm_{side}", "rotation_euler", f0, d - base[None, :], "blend")


def _brows(clip, rig, f0, lift, tilt=0.0):
    """Brows up by `lift` (a fraction of the eye radius) and tilted (radians; positive = the inner ends down, a frown)."""
    for side, sg in (("L", -1.0), ("R", 1.0)):
        lift_a, tilt_a = np.asarray(lift, dtype=float), np.asarray(tilt, dtype=float)
        m = max(lift_a.size, tilt_a.size)
        clip.put("face", f"brow_{side}", "location", f0, _vec(m, z=lift_a * rig.eye_r * 0.9), "add")
        clip.put("face", f"brow_{side}", "rotation_euler", f0, _rot(y=-sg * tilt_a, m=m), "add")


def _aim(ctx, actor, f, point):
    """(yaw, pitch) in radians from the actor's facing to a point, seen from its head. Yaw to the viewer's right is positive; pitch up is negative (x rotation)."""
    x, y, _, yaw = actor.root(f)
    head = np.array([x, y, actor.rig.head_z])
    v = np.asarray(point, dtype=float) - head
    c, s = math.cos(yaw), math.sin(yaw)
    lx, ly = c * v[0] + s * v[1], -s * v[0] + c * v[1]
    return math.atan2(lx, -ly), -math.atan2(v[2], max(math.hypot(lx, ly), 1e-6))


# ---------------------------------------------------------------- looking, blinking, idle


@action("look_at", bodies=BOTH)
def look_at(ctx, actor, t0, t1, params):
    """Pupils lead, the head follows 2-3 frames later, the body only past `bodyPastDeg` (60). Holds on the target until the next look_at (`_hold_to`)."""
    V = _vehicle(actor)
    if V:
        return V.look_at(ctx, actor, t0, t1, params)
    rig = actor.rig
    f0, f1 = ctx.f(t0), ctx.f(t1)
    clip = Clip(f0, f1)
    end = int(min(params.get("_hold_to", ctx.n - 1), ctx.n - 1))
    m = max(end - f0 + 1, f1 - f0 + 1)
    n = max(f1 - f0, 1)
    past = DEG(float(params.get("bodyPastDeg", 60)))
    prev_h = actor.mix.delta_at("head", "rotation_euler", f0, ("look",))
    prev_b = actor.mix.delta_at("body", "rotation_euler", f0, ("look",))
    ps = actor.mix.delta_at("pupil_L", "location", f0, ("face",)) if rig.has("pupil_L") else np.zeros(3)
    head = np.zeros((m, 3))
    body = np.zeros((m, 3))
    pup = np.zeros((m, 3))
    cur_y, cur_p, cur_b = prev_h[2], prev_h[0], prev_b[2]
    for i in range(m):
        f = f0 + i
        target = None if params.get("target") is None else ctx.point(params["target"], min(f, ctx.n - 1))
        if target is None:
            tgt_y = tgt_p = 0.0
        else:
            tgt_y, tgt_p = _aim(ctx, actor, f, target)
            tgt_y = wrap_pi(tgt_y - float(actor.mix.delta_at("body", "rotation_euler", f, ("base",))[2]))
        yaw_h = float(np.clip(tgt_y, -past, past))
        yaw_b = float(np.clip(tgt_y - yaw_h, -DEG(50), DEG(50)))
        pit_h = float(np.clip(tgt_p, -DEG(35), DEG(30)))
        p = float(smoothstep((i - 2) / n))  # the head starts 2 frames after the eyes
        goal_y = prev_h[2] * (1 - p) + yaw_h * p
        goal_p = prev_h[0] * (1 - p) + pit_h * p
        goal_b = prev_b[2] * (1 - p) + yaw_b * p
        a = 0.45
        cur_y, cur_p, cur_b = cur_y + (goal_y - cur_y) * a, cur_p + (goal_p - cur_p) * a, cur_b + (goal_b - cur_b) * a
        head[i] = (cur_p, 0.0, cur_y)
        body[i] = (0.0, 0.0, cur_b)
        # the eyes: they reach the target at once, so they lead the head by its lag
        res_y, res_p = tgt_y - (cur_y + cur_b if target is not None else 0.0), tgt_p - cur_p
        q = float(smoothstep((i + 1) / max(n * 0.45, 1)))
        px = np.clip(res_y / DEG(32), -1, 1) * 0.55 * rig.eye_r
        pz = np.clip(-res_p / DEG(28), -1, 1) * 0.45 * rig.eye_r
        pup[i] = (ps[0] * (1 - q) + px * q, 0.0, ps[2] * (1 - q) + pz * q)
    clip.put("look", "head", "rotation_euler", f0, head, "hold")
    clip.put("look", "body", "rotation_euler", f0, body, "hold")
    for side in "LR":
        clip.put("face", f"pupil_{side}", "location", f0, pup, "hold")
    swing = abs(wrap_pi(head[min(n, m - 1), 2] - prev_h[2])) + abs(body[min(n, m - 1), 2] - prev_b[2])
    clip.meta.update(bigTurn=swing > DEG(30), f0=f0)
    return clip


def blink_amounts():
    return np.array([0.0, 0.55, 1.0, 1.0, 0.5, 0.0])


@action("blink", bodies=BOTH)
def blink(ctx, actor, t0, t1, params):
    V = _vehicle(actor)
    if V:
        return V.blink(ctx, actor, t0, t1, params)
    f0, f1 = ctx.f(t0), ctx.f(t1)
    clip = Clip(f0, f1)
    clip.lid(f0, blink_amounts())
    return clip


def auto_blink_times(ctx, actor, duration_s, given=None):
    """Seeded blinks every 2.5-5 s (or the timeline's own list)."""
    if given:
        return sorted(given)
    rng = ctx.rng("blink", actor.id)
    t, out = float(rng.uniform(0.8, 2.5)), []
    while t < duration_s:
        out.append(round(t, 3))
        t += float(rng.uniform(2.5, 5.0))
    return out


def _idle(clip, ctl, prop, vals, f0, f1):
    w = window(len(vals), f0, f1, 6) if (f0 > 0 or f1 < len(vals) - 1) else np.ones(len(vals))
    clip.put("idle", ctl, prop, f0, (vals * w[:, None])[f0 : f1 + 1], "add")


def _noise(rng, n, sigma_s, fps=FPS):
    k = max(int(sigma_s * fps * 3), 3)
    x = np.arange(-k, k + 1)
    ker = np.exp(-0.5 * (x / (sigma_s * fps)) ** 2)
    a = np.convolve(rng.normal(size=n + 2 * k), ker, mode="same")[k : k + n]
    return a / max(float(a.std()), 1e-9)


@action("idle")
def idle(ctx, actor, t0, t1, params):
    """Breathing and micro-motion for [t0, t1] (the assembler runs it over the whole timeline: idle is always on)."""
    return idle_clip(ctx, actor, ctx.f(t0), ctx.f(t1))


def idle_clip(ctx, actor, f0=0, f1=None):
    """Breathing, a slow weight shift, head and arm micro-motion, seeded; fades out under walking so planted feet stay put. Computed over the whole
    timeline (so it is the same whatever the window), written for frames f0..f1. A vehicle gets `idle_engine` instead."""
    V = _vehicle(actor)
    if V:
        return V.idle_engine_clip(ctx, actor, f0, f1)
    rig, n = actor.rig, ctx.n
    f1 = n - 1 if f1 is None else min(f1, n - 1)
    clip = Clip(f0, f1)
    rng = ctx.rng("idle", actor.id)
    t = np.arange(n) / FPS
    e = rig.energy
    hz = 0.33 * math.sqrt(rig.tempo)
    ph = float(rng.uniform(0, TAU))
    breath = np.sin(TAU * hz * t + ph)
    free = 1.0 - np.clip(actor.moving, 0, 1)
    legs = free if not rig.legs else free * (~actor.leg_driven)
    amp = 0.014 * e
    sq = np.stack([-0.5 * amp * breath, -0.5 * amp * breath, amp * breath], axis=1) * legs[:, None]
    _idle(clip, "squash", "scale", sq, f0, f1)
    sway = _noise(rng, n, 0.9)
    shift_ = _noise(rng, n, 1.4)
    _idle(clip, "body", "rotation_euler", _rot(0.004 * e * breath, DEG(0.9 * e) * shift_, DEG(0.5 * e) * sway) * free[:, None], f0, f1)
    hx, hz_ = _noise(rng, n, 0.45), _noise(rng, n, 0.6)
    _idle(clip, "head", "rotation_euler", _rot(DEG(0.7 * e) * hx - 0.006 * e * breath, DEG(0.3) * hz_, DEG(0.8 * e) * hz_) * free[:, None], f0, f1)
    for i, side in enumerate("LR"):
        if rig.has(f"arm_{side}"):
            a = _noise(rng, n, 0.7)
            _idle(clip, f"arm_{side}", "rotation_euler", _rot(DEG(1.2 * e) * a + 0.01 * e * breath, 0, 0) * free[:, None], f0, f1)
    return clip


# ---------------------------------------------------------------- gestures


@action("nod", bodies=BOTH)
def nod(ctx, actor, t0, t1, params):
    V = _vehicle(actor)
    if V:
        return V.nod(ctx, actor, t0, t1, params)
    rig = actor.rig
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    count = int(params.get("count", 2))
    amp = DEG(13 * rig.energy) * float(params.get("amp", 1.0))
    d = min(0.34 / rig.tempo, 0.9 * (n / FPS) / max(count, 1)) * FPS
    pts = [(0, 0.0), (0.12 * d, -0.22)]
    for c in range(count):
        a = 0.12 * d + c * d
        pts += [(a + 0.28 * d, 1.0 - 0.1 * c), (a + 0.62 * d, -0.18), (a + 0.9 * d, 0.0 if c == count - 1 else 0.0)]
    pts += [(n + 0.4 * ctx.settle, 0.04), (n + ctx.settle - 3, 0.0), (n + ctx.settle, 0.0)]
    pts = [(min(f, m - 1), v) for f, v in pts]
    e = knots(sorted(pts, key=lambda p: p[0]), m)
    clip.put("gesture", "body", "rotation_euler", f0, _rot(0.25 * amp * e, 0, 0), "blend")
    clip.put("gesture", "head", "rotation_euler", f0, _rot(amp * shift(e, 2), 0, 0), "blend")
    return clip


@action("shake_head", bodies=BOTH)
def shake_head(ctx, actor, t0, t1, params):
    V = _vehicle(actor)
    if V:
        return V.shake_head(ctx, actor, t0, t1, params)
    rig = actor.rig
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    count = int(params.get("count", 2))
    amp = DEG(17 * rig.energy)
    d = min(0.36 / rig.tempo, 0.88 * (n / FPS) / max(count, 1)) * FPS
    pts = [(0, 0.0), (0.1 * d, 0.2)]
    for c in range(count):
        a = 0.1 * d + c * d
        k = 1.0 - 0.18 * c
        pts += [(a + 0.25 * d, -k), (a + 0.75 * d, k * 0.9)]
    pts += [(0.1 * d + count * d + 0.2 * d, -0.12), (n + 0.4 * ctx.settle, 0.03), (n + ctx.settle - 3, 0.0), (n + ctx.settle, 0.0)]
    pts = sorted([(min(f, m - 1), v) for f, v in pts], key=lambda p: p[0])
    e = knots(pts, m)
    clip.put("gesture", "body", "rotation_euler", f0, _rot(0, 0, -0.18 * amp * e), "blend")
    clip.put("gesture", "head", "rotation_euler", f0, _rot(0.03 * amp * np.abs(shift(e, 2)), 0, amp * shift(e, 2)), "blend")
    return clip


@action("wave")
def wave(ctx, actor, t0, t1, params):
    rig = actor.rig
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    side = params.get("arm", "R")
    sx = 1.0 if side == "R" else -1.0
    e = gesture_env(n, ctx.settle, rig.tempo, anti=0.1, hold_to=0.78)
    ea = shift(e, 1)
    t = np.arange(m) / FPS
    hold = window(m, 0.3 * n, 0.8 * n, 5)
    osc = np.sin(TAU * 2.7 * rig.tempo ** 0.5 * (t - 0.3 * n / FPS)) * hold
    el = DEG(148) * ea + DEG(13) * osc
    az = DEG(14) * np.ones(m) + DEG(11) * np.cos(TAU * 2.7 * rig.tempo ** 0.5 * (t - 0.3 * n / FPS)) * hold
    _arm(clip, ctx, actor, side, f0, sphere_dir(el, az, sx))
    if rig.has(f"hand_{side}"):
        clip.put("gesture", f"hand_{side}", "rotation_euler", f0, _rot(0, DEG(18) * osc * -sx, 0), "blend")
    clip.put("gesture", "head", "rotation_euler", f0, _rot(DEG(-3) * shift(e, 2), -sx * DEG(7) * shift(e, 2), DEG(4) * shift(e, 2) * sx * -1), "blend")
    clip.put("gesture", "body", "rotation_euler", f0, _rot(0, -sx * DEG(2.5) * e, 0), "blend")
    _brows(clip, rig, f0, 0.35 * shift(e, 2))
    return clip


@action("point")
def point(ctx, actor, t0, t1, params):
    rig = actor.rig
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    target = ctx.point(params["target"], f0)
    x, y, _, yaw = actor.root(f0)
    side = params.get("arm")
    c, s = math.cos(yaw), math.sin(yaw)
    sh_w = np.array([x, y, 0.0]) + np.array([c, s, 0.0]) * 0 + rig.world_rest("arm_R")[:3, 3] * 0
    ang_y, ang_p = _aim(ctx, actor, f0, target)
    side = side or ("R" if ang_y >= 0 else "L")
    sx = 1.0 if side == "R" else -1.0
    sh = rig.world_rest(f"arm_{side}")[:3, 3]
    sh_w = np.array([x + c * sh[0] - s * sh[1], y + s * sh[0] + c * sh[1], sh[2]])
    v = target - sh_w
    vl = np.array([c * v[0] + s * v[1], -s * v[0] + c * v[1], v[2]])
    vl /= max(np.linalg.norm(vl), 1e-9)
    el_p = math.acos(float(np.clip(-vl[2], -1, 1)))
    az_p = math.atan2(-vl[1], sx * vl[0])
    e = gesture_env(n, ctx.settle, rig.tempo, anti=0.14, over=0.07, hold_to=0.8)
    ea = shift(e, 1)
    t = np.arange(m) / FPS
    el = el_p * ea + DEG(2.5) * np.sin(TAU * 1.1 * t) * window(m, 0.3 * n, 0.85 * n, 5)
    _arm(clip, ctx, actor, side, f0, sphere_dir(el, np.full(m, az_p), sx))
    body_yaw = float(np.clip(ang_y, -DEG(40), DEG(40)))
    clip.put("gesture", "body", "rotation_euler", f0, _rot(DEG(-2) * e, 0, 0.45 * body_yaw * e), "blend")
    head_yaw = float(np.clip(ang_y - 0.45 * body_yaw, -DEG(50), DEG(50)))
    clip.put("gesture", "head", "rotation_euler", f0, _rot(float(np.clip(ang_p, -DEG(25), DEG(25))) * shift(e, 2), 0, head_yaw * shift(e, 2)), "blend")
    clip.meta.update(arm=side, elDeg=math.degrees(el_p), azDeg=math.degrees(az_p))
    return clip


@action("shrug")
def shrug(ctx, actor, t0, t1, params):
    rig = actor.rig
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    e = gesture_env(n, ctx.settle, rig.tempo, anti=0.1, over=0.1, hold_to=0.74)
    for side in "LR":
        sx = 1.0 if side == "R" else -1.0
        _arm(clip, ctx, actor, side, f0, sphere_dir(DEG(62) * shift(e, 1), np.full(m, DEG(12)), sx))
    clip.put("gesture", "squash", "scale", f0, _vec(m, z=-0.04 * e, x=0.02 * e, y=0.02 * e), "blend")
    clip.put("gesture", "head", "location", f0, _vec(m, z=-0.12 * rig.eye_r * shift(e, 2)), "blend")
    clip.put("gesture", "head", "rotation_euler", f0, _rot(DEG(-5) * shift(e, 2), DEG(8) * shift(e, 3), 0), "blend")
    clip.put("gesture", "body", "rotation_euler", f0, _rot(DEG(-3) * e, 0, 0), "blend")
    _brows(clip, rig, f0, 0.55 * shift(e, 2), -DEG(8) * shift(e, 2))
    return clip


@action("think")
def think(ctx, actor, t0, t1, params):
    rig = actor.rig
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    side = params.get("arm", "R")
    sx = 1.0 if side == "R" else -1.0
    e = gesture_env(n, ctx.settle, rig.tempo, anti=0.08, over=0.05, hold_to=0.86)
    t = np.arange(m) / FPS
    _arm(clip, ctx, actor, side, f0, sphere_dir(DEG(125) * shift(e, 1), np.full(m, DEG(112)), sx))
    clip.put("gesture", "head", "rotation_euler", f0, _rot(DEG(-7) * shift(e, 2), -sx * DEG(9) * shift(e, 2), -sx * DEG(10) * shift(e, 2)), "blend")
    clip.put("gesture", "body", "rotation_euler", f0, _rot(DEG(-2) * e, DEG(2) * sx * e, 0), "blend")
    for s_ in "LR":
        clip.put("face", f"pupil_{s_}", "location", f0, _vec(m, x=-sx * 0.3 * rig.eye_r * shift(e, 1), z=0.35 * rig.eye_r * shift(e, 1)), "add")
    _brows(clip, rig, f0, 0.3 * shift(e, 2), DEG(6) * shift(e, 2))
    return clip


@action("cheer")
def cheer(ctx, actor, t0, t1, params):
    rig = actor.rig
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    e = gesture_env(n, ctx.settle, rig.tempo, anti=0.16, over=0.12, hold_to=0.8)
    t = np.arange(m) / FPS
    jumps = np.abs(np.sin(TAU * 1.5 * rig.tempo ** 0.5 * (t - 0.28 * n / FPS) / 2)) * window(m, 0.28 * n, 0.8 * n, 3)
    apex = rig.height * 0.07 * rig.energy
    for side in "LR":
        sx = 1.0 if side == "R" else -1.0
        _arm(clip, ctx, actor, side, f0, sphere_dir(DEG(165) * shift(e, 1) + DEG(7) * jumps, np.full(m, DEG(14)), sx))
    clip.put("gesture", "root", "location", f0, _vec(m, z=apex * jumps), "blend")
    sq = 1 + 0.12 * (jumps - 0.45) * window(m, 0.2 * n, 0.85 * n, 3) - 0.09 * np.clip(-e, 0, None)
    clip.put("gesture", "squash", "scale", f0, np.stack([1 / np.sqrt(sq) - 1, 1 / np.sqrt(sq) - 1, sq - 1], axis=1), "blend")
    clip.put("gesture", "head", "rotation_euler", f0, _rot(DEG(-9) * shift(e, 2), 0, 0), "blend")
    clip.put("gesture", "body", "rotation_euler", f0, _rot(DEG(-4) * e, 0, 0), "blend")
    return clip


# ---------------------------------------------------------------- reactions


def _chain_first(rig, stem_prefix):
    return [n for n in rig.controls if n in (f"{stem_prefix}_L1", f"{stem_prefix}_R1")]


@action("react_surprised", bodies=BOTH)
def react_surprised(ctx, actor, t0, t1, params):
    V = _vehicle(actor)
    if V:
        return V.react_surprised(ctx, actor, t0, t1, params)
    rig = actor.rig
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    e = gesture_env(n, ctx.settle, rig.tempo, anti=0.2, over=0.1, hold_to=0.62)
    sz = knots([(0, 1), (0.08 * n, 0.86), (0.2 * n, 1.2), (0.33 * n, 1.14), (0.5 * n, 0.92), (0.64 * n, 1.03), (0.82 * n, 1.0), (n + ctx.settle, 1.0)], m)
    sxy = 1 / np.sqrt(sz)
    clip.put("gesture", "squash", "scale", f0, np.stack([sxy - 1, sxy - 1, sz - 1], axis=1), "blend")
    hop = knots([(0, 0), (0.12 * n, 0), (0.3 * n, 0.07 * rig.height * rig.energy), (0.5 * n, 0), (n + ctx.settle, 0)], m)
    clip.put("gesture", "root", "location", f0, _vec(m, z=hop), "blend")
    clip.put("gesture", "body", "rotation_euler", f0, _rot(DEG(-9) * e, 0, 0), "blend")
    clip.put("gesture", "head", "rotation_euler", f0, _rot(DEG(-7) * shift(e, 2), 0, 0), "blend")
    for side in "LR":
        sx = 1.0 if side == "R" else -1.0
        _arm(clip, ctx, actor, side, f0, sphere_dir(DEG(58) * shift(e, 2), np.full(m, DEG(8)), sx))
    for c in _chain_first(rig, "ear"):
        clip.put("gesture", c, "rotation_euler", f0, _rot(DEG(-26) * shift(e, 1), 0, 0), "blend")
    _brows(clip, rig, f0, 0.9 * shift(e, 2))
    o = np.full(m, -1)
    o[int(0.24 * n) : int(0.72 * n)] = SLOT["O"]
    clip.mouth(f0, o)
    return clip


@action("laugh", bodies=BOTH)
def laugh(ctx, actor, t0, t1, params):
    V = _vehicle(actor)
    if V:
        return V.laugh(ctx, actor, t0, t1, params)
    rig = actor.rig
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    e = gesture_env(n, ctx.settle, rig.tempo, anti=0.1, over=0.06, hold_to=0.86)
    t = np.arange(m) / FPS
    hz = 5.2 * rig.tempo ** 0.5
    ha = np.sin(TAU * hz * (t - 0.2 * n / FPS)) * window(m, 0.2 * n, 0.92 * n, 4)
    clip.put("gesture", "squash", "scale", f0, np.stack([-0.012 * ha, -0.012 * ha, 0.032 * ha], axis=1), "blend")
    clip.put("gesture", "body", "rotation_euler", f0, _rot(DEG(-8) * e + DEG(2.2) * ha, 0, DEG(1.5) * ha), "blend")
    clip.put("gesture", "head", "rotation_euler", f0, _rot(DEG(-15) * shift(e, 2) - DEG(3) * shift(ha, 1), 0, 0), "blend")
    for side in "LR":
        sx = 1.0 if side == "R" else -1.0
        _arm(clip, ctx, actor, side, f0, sphere_dir(DEG(30) * shift(e, 2), np.full(m, DEG(70)), sx))
    closed = 0.9 * np.clip(e * 1.4, 0, 1)
    clip.lid(f0, closed)
    mouth = np.full(m, -1)
    on = (np.arange(m) > 0.14 * n) & (np.arange(m) < 0.94 * n)
    mouth[on] = np.where(ha[on] > -0.2, SLOT["A"], SLOT["E"])
    clip.mouth(f0, mouth)
    _brows(clip, rig, f0, 0.4 * shift(e, 2))
    return clip


@action("droop", bodies=BOTH)
def droop(ctx, actor, t0, t1, params):
    V = _vehicle(actor)
    if V:
        return V.droop(ctx, actor, t0, t1, params)
    rig = actor.rig
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    e = gesture_env(n, ctx.settle, rig.tempo * 0.75, anti=0.05, over=0.03, hold_to=0.8)
    clip.put("gesture", "head", "rotation_euler", f0, _rot(DEG(22) * shift(e, 2), 0, 0), "blend")
    clip.put("gesture", "body", "rotation_euler", f0, _rot(DEG(9) * e, 0, 0), "blend")
    clip.put("gesture", "squash", "scale", f0, _vec(m, z=-0.035 * e, x=0.015 * e, y=0.015 * e), "blend")
    for side in "LR":
        sx = 1.0 if side == "R" else -1.0
        _arm(clip, ctx, actor, side, f0, sphere_dir(DEG(2) * shift(e, 3), np.full(m, DEG(-70)), sx))
    for c in _chain_first(rig, "ear"):
        clip.put("gesture", c, "rotation_euler", f0, _rot(DEG(34) * shift(e, 2), 0, 0), "blend")
    clip.lid(f0, 0.38 * np.clip(e, 0, 1))
    _brows(clip, rig, f0, 0.25 * shift(e, 2), DEG(14) * shift(e, 2))
    fr = np.zeros(m, dtype=bool)
    fr[int(0.15 * n) : int(0.85 * n)] = True
    clip.mouth(f0, np.full(m, -1), fr)
    return clip


# ---------------------------------------------------------------- automatic acting


def talking_clip(ctx, actor, accents, speaking=None):
    """While the actor speaks: a small head dip and an eyebrow lift on each word onset (the head layer), never the mouth (that is the lip-sync)."""
    V = _vehicle(actor)
    if V:
        return V.talking_clip(ctx, actor, accents)
    rig = actor.rig
    clip = Clip(0, ctx.n - 1)
    rng = ctx.rng("talk", actor.id)
    last = -9.0
    for t in accents:
        if t - last < 0.28:
            continue
        last = t
        f = ctx.f(t)
        k = 9
        strength = float(rng.uniform(0.6, 1.0)) * rig.energy
        bump = knots([(0, 0), (2, 1.0), (5, -0.25), (8, 0)], k)
        sign = float(rng.choice([-1.0, 1.0]))
        clip.put("head", "head", "rotation_euler", f, _rot(DEG(3.0 * strength) * bump, 0, sign * DEG(1.6 * strength) * bump), "add")
        clip.put("head", "body", "rotation_euler", f, _rot(DEG(0.9 * strength) * shift(bump, 1), 0, 0), "add")
        _brows(clip, rig, f, 0.3 * strength * bump)
    return clip


def listening_actions(ctx, listener, speaker_id, speaking, accents, explicit_looks=()):
    """When nobody gives the listener a beat: look at the speaker as they start, nod now and then on their accents (not more often than every 1.6 s)."""
    V = _vehicle(listener)
    if V:
        return V.listening_actions(ctx, listener, speaker_id, speaking, accents, explicit_looks)
    out = []
    taken = {round(a["t0"], 1) for a in explicit_looks}
    for t0, t1 in speaking:
        if round(max(t0 - 0.15, 0), 1) in taken:
            continue
        out.append({"action": "look_at", "t0": max(t0 - 0.15, 0.0), "t1": max(t0 - 0.15, 0.0) + 0.45, "params": {"target": speaker_id}})
    rng = ctx.rng("listen", listener.id)
    last = -9.0
    for t in accents:
        if t - last < 1.6 or not any(a <= t <= b for a, b in speaking):
            continue
        if rng.uniform() < 0.55:
            out.append({"action": "nod", "t0": t + 0.1, "t1": t + 0.1 + 0.6, "params": {"count": 1, "amp": 0.55}})
            last = t
    return out
