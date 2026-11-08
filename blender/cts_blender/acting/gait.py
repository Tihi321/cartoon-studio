# SPDX-License-Identifier: GPL-3.0-or-later
"""Locomotion and posture: walk (with planted feet), run, hop, turn, sit, stand_up.

Foot planting is computed, not solved by IK (HUB-30 decision 3). The root follows an eased path s(t); every footfall is planted where the root is
above it in mid-stance; for each frame the leg control is aimed from the hip to the foot's world position and its z scale takes up the length
difference (a few percent), so a planted foot does not move at all in the model. Start and stop steps come from the eased root speed: the first
and last steps are short because the root is slow there.

These actions write the *base* layer (a state that holds after the action), so the next action starts from where this one ended.
"""
import math

import numpy as np

from . import action
from .core import FPS, TAU, Clip, euler_from_dir, knots, shift, smoothstep, wrap_pi, window
from .limbs import arm_delta, clamp_arm, hang_dir, swing_dirs

GAITS = {
    "walk": dict(duty=0.55, step=1.0, bob=0.06, lean=5.0, arm=24.0, clear=0.20, roll=0.0, wag=1.5, lift=0.0),
    "waddle": dict(duty=0.64, step=0.8, bob=0.05, lean=3.0, arm=14.0, clear=0.12, roll=7.0, wag=5.0, lift=0.0),
    "run": dict(duty=0.36, step=1.7, bob=0.12, lean=13.0, arm=48.0, clear=0.42, roll=0.0, wag=2.0, lift=0.10),
    "tiptoe": dict(duty=0.62, step=0.7, bob=0.02, lean=2.0, arm=8.0, clear=0.14, roll=0.0, wag=0.8, lift=0.05),
}


def _travel(ctx, actor, f0, params):
    """Start, unit direction, distance and the facing that goes with it, for a move to params['target'] (optionally stopping `stop` metres short)."""
    x0, y0, _, yaw0 = actor.root(f0)
    g = ctx.ground(params["target"], f0)
    v = g - np.array([x0, y0])
    dist = float(np.linalg.norm(v))
    u = v / dist if dist > 1e-6 else np.array([0.0, -1.0])
    return np.array([x0, y0]), u, max(0.0, dist - float(params.get("stop", 0.0))), math.atan2(u[0], -u[1]), yaw0


def _yaw_series(yaw0, yaw1, tau, dur):
    return yaw0 + wrap_pi(yaw1 - yaw0) * smoothstep(tau / max(dur, 1e-6))


def solve_legs(rig, xy, yaw, rz, feet):
    """Aims each leg control from its hip at a world foot position. xy (m, 2) root, yaw (m,), rz (m,), feet {side: (m, 3)} -> {side: (alpha, beta, scale)}."""
    out = {}
    c, s = np.cos(yaw), np.sin(yaw)
    for side, fw in feet.items():
        hip = rig.hip[side]
        hx, hy = c * hip[0] - s * hip[1], s * hip[0] + c * hip[1]
        h = np.stack([xy[:, 0] + hx, xy[:, 1] + hy, rz + hip[2]], axis=1)
        v = fw - h
        vl = np.stack([c * v[:, 0] + s * v[:, 1], -s * v[:, 0] + c * v[:, 1], v[:, 2]], axis=1)
        a, b = euler_from_dir(vl)
        out[side] = (a, b, np.clip(np.linalg.norm(vl, axis=1) / rig.leg_len, 0.65, 1.45))
    return out


def foot_series(tau, stances, clear):
    """A foot's world position over time. stances: [(t_land, xy, t_lift), ...]; the first has t_land -inf, the last t_lift +inf. Between a lift and the
    next landing the foot swings on an arc (eased, so it is fast mid-swing). Returns (xy (m, 2), z (m,))."""
    xy = np.zeros((len(tau), 2))
    z = np.zeros(len(tau))
    for i, (t_land, p, t_lift) in enumerate(stances):
        xy[tau >= t_land] = p
        if i + 1 < len(stances):
            nl, np_, _ = stances[i + 1]
            sw = (tau >= t_lift) & (tau < nl)
            if sw.any():
                u = ((tau[sw] - t_lift) / max(nl - t_lift, 1e-6))
                e = smoothstep(u)
                xy[sw] = p[None, :] + (np_ - p)[None, :] * e[:, None]
                z[sw] = clear * np.sin(math.pi * u) ** 0.8
    return xy, z


def _put_legs(clip, f0, legs, rest_after=True):
    for side, (a, b, s) in legs.items():
        rot = np.zeros((len(a), 3))
        rot[:, 0], rot[:, 1] = a, b
        sc = np.zeros((len(a), 3))
        sc[:, 2] = s - 1.0
        clip.put("base", f"leg_{side}", "rotation_euler", f0, rot, "hold")
        clip.put("base", f"leg_{side}", "scale", f0, sc, "hold")


def _trapezoid(u, r):
    """Progress 0..1 with a smooth start, a cruise and a smooth stop (velocity ramps over a fraction r at each end)."""
    u = np.clip(u, 0, 1)
    v = 1.0 / (1.0 - r)
    return np.where(u < r, v * u * u / (2 * r), np.where(u > 1 - r, 1 - v * (1 - u) ** 2 / (2 * r), v * (u - r / 2)))


# ---------------------------------------------------------------- walk / run / tiptoe / waddle


def _gait(ctx, actor, t0, t1, params, name):
    rig = actor.rig
    f0, f1 = ctx.f(t0), ctx.f(t1)
    clip = Clip(f0, f1)
    if not rig.legs:
        return _hop(ctx, actor, t0, t1, dict(params, _fast=name == "run"))
    g = GAITS[name]
    p0, u, D, psi, yaw0 = _travel(ctx, actor, f0, params)
    if D < 0.03:
        return clip
    m = (f1 - f0) + 1 + ctx.settle
    tau = np.arange(m) / FPS
    Tw = (f1 - f0) / FPS
    L, tempo = rig.leg_len, rig.tempo
    stride = float(rig.walk["stride"]) * g["step"] * (0.9 + 0.1 * rig.bounce)
    A = 0.08
    U = max(Tw - A - 0.1, 0.3)
    N = max(2, int(round(D / stride)) - 1)
    Ts_r = 2 * g["duty"]  # stance time in units of the step time
    T = U / (N + 2.45 - Ts_r)
    Ts, Tsw = Ts_r * T, (2 - Ts_r) * T
    t_a = A
    t_land = [t_a + Tsw + k * T for k in range(N + 1)]
    t_s, t_e = max(t_a - 0.04, 0.02), t_land[N] + 0.45 * T
    r = float(np.clip(1.1 * T / (t_e - t_s), 0.12, 0.45))
    s_of = lambda t: D * _trapezoid((t - t_s) / (t_e - t_s), r)  # noqa: E731
    yaw = _yaw_series(yaw0, psi, tau, 0.3)
    right = lambda y: np.stack([np.cos(y), np.sin(y)], axis=-1)  # noqa: E731
    side_sign = {"L": -1.0, "R": 1.0}
    feet = {}
    plan = {}
    for p, side in enumerate("LR"):
        hx = abs(rig.hip[side][0])
        st = [(-1e9, p0 + right(yaw0) * side_sign[side] * hx, t_a + p * T)]
        for k in range(p, N + 1, 2):
            a_k = D if k >= N - 1 else float(s_of(t_land[k] + Ts / 2))
            y_k = float(_yaw_series(yaw0, psi, np.array([t_land[k]]), 0.3)[0])
            st.append((t_land[k], p0 + u * a_k + right(y_k) * side_sign[side] * hx, t_land[k] + Ts if k < N - 1 else 1e9))
        xy, z = foot_series(tau, st, g["clear"] * L * 0.75)
        feet[side] = np.concatenate([xy, z[:, None]], axis=1)
        plan[side] = [(st[i][0], st[i][2], st[i][1].tolist()) for i in range(1, len(st))]
    prog = _trapezoid((tau - t_s) / (t_e - t_s), r)
    root_xy = p0[None, :] + u[None, :] * (D * prog)[:, None]
    mask = smoothstep((tau - t_s) / (0.6 * T)) * smoothstep((t_e - tau) / (0.6 * T))
    depth = L * g["bob"] * (0.5 + rig.bounce)
    t_mid = t_land[0] + Ts / 2
    bob = 0.5 * depth * mask * (np.cos(TAU * (tau - t_mid) / T) - 1.0) + g["lift"] * L * mask
    legs = solve_legs(rig, root_xy, yaw, bob, feet)
    _put_legs(clip, f0, legs)
    clip.put("base", "root", "location", f0, np.concatenate([root_xy, bob[:, None]], axis=1), "hold")
    clip.put("base", "root", "rotation_euler", f0, np.stack([np.zeros(m), np.zeros(m), yaw], axis=1), "hold")
    # body: anticipation lean back, lean forward while moving, a lean-back overshoot at the stop; the head lags the body by 2 frames
    e = float(rig.energy)
    lean = np.radians(g["lean"] * e) * knots([(0, 0), (t_s * FPS * 0.5, -0.25), ((t_s + 0.45) * FPS, 1.0), ((t_e - 0.1) * FPS, 1.0), ((t_e + 0.12) * FPS, -0.3), ((t_e + 0.42) * FPS, 0.0)], m)
    roll = -np.radians(g["roll"] * e) * mask * np.cos(TAU * (tau - t_mid) / (2 * T))
    wag = np.radians(g["wag"] * e) * mask * np.sin(TAU * (tau - t_mid) / (2 * T))
    body = np.stack([lean, roll, wag], axis=1)
    clip.put("base", "body", "rotation_euler", f0, body, "hold")
    nodz = np.radians(1.6 * e) * mask * np.sin(TAU * (tau - t_mid) / T)
    head = np.stack([-shift(lean, 2) * 0.8 + shift(nodz, 2), -shift(roll, 2) * 0.6, -shift(wag, 2) * 1.2], axis=1)
    clip.put("head", "head", "rotation_euler", f0, head, "add")
    # arms swing against the legs, 2 frames behind them
    la, ra = legs["L"][0], legs["R"][0]
    norm = max(float(np.abs(la).max()), 1e-6)
    amp = math.radians(g["arm"] * e)
    for side, opp in (("L", ra), ("R", la)):
        ang = shift(opp / norm, 2) * amp * mask
        d = arm_delta(rig, actor.mix, side, swing_dirs(rig, side, -ang), f0)
        clip.put("base", f"arm_{side}", "rotation_euler", f0, d, "hold")
    f_end = min(f0 + m, ctx.n)
    actor.moving[f0:f_end] = np.maximum(actor.moving[f0:f_end], mask[: f_end - f0])
    actor.leg_driven[f0 : min(f1 + 1, ctx.n)] = True
    clip.meta.update(gait=name, steps=N + 1, stepTime=T, plan=plan, f0=f0, tau0=f0 / FPS, hipLeg=L, rootEnd=(p0 + u * D).tolist(), timeEnd=t_e)
    return clip


@action("walk")
def walk(ctx, actor, t0, t1, params):
    style = params.get("style") or actor.rig.walk["style"]
    if style == "hop":
        return _hop(ctx, actor, t0, t1, params)
    return _gait(ctx, actor, t0, t1, params, style if style in GAITS else "walk")


@action("run")
def run(ctx, actor, t0, t1, params):
    return _gait(ctx, actor, t0, t1, params, "run")


# ---------------------------------------------------------------- hop


@action("hop")
def hop(ctx, actor, t0, t1, params):
    return _hop(ctx, actor, t0, t1, params)


def _hop(ctx, actor, t0, t1, params):
    """Hops along a line to the target (or on the spot): crouch, stretch, an arc, a squashed landing, settle. The root stands still on the ground."""
    rig = actor.rig
    f0, f1 = ctx.f(t0), ctx.f(t1)
    clip = Clip(f0, f1)
    if "target" in params:
        p0, u, D, psi, yaw0 = _travel(ctx, actor, f0, params)
    else:
        x0, y0, _, yaw0 = actor.root(f0)
        p0, u, D, psi = np.array([x0, y0]), np.array([0.0, 0.0]), 0.0, yaw0
    if "target" in params and D < 0.03:
        return clip
    fast = bool(params.get("_fast"))
    m = (f1 - f0) + 1 + ctx.settle
    tau = np.arange(m) / FPS
    Tw = max((f1 - f0) / FPS - 0.05, 0.3)
    reach = float(rig.walk["stride"]) * (1.7 if fast else 1.0)
    n = max(1, int(round(D / reach))) if D > 0 else max(1, int(round(Tw / 0.55)))
    Th = Tw / n
    apex = rig.height * (0.07 + 0.12 * rig.bounce) * (1.3 if fast else 1.0) * float(params.get("height", 1.0)) * rig.energy
    sq = [(0, 1.0), (0.10, 0.84), (0.22, 0.85), (0.27, 1.20), (0.42, 1.07), (0.60, 1.10), (0.65, 0.78), (0.78, 1.06), (0.92, 0.99), (1.0, 1.0)]
    pts = [(0, 1.0)]
    for h in range(n):
        pts += [((h + a) * Th * FPS, v) for a, v in sq[1:]]
    sz = knots(pts, m)
    sxy = 1.0 / np.sqrt(np.maximum(sz, 0.2))
    z = np.zeros(m)
    prog = np.zeros(m)
    air = np.zeros(m)
    for h in range(n):
        ua = (tau / Th - h - 0.27) / (0.64 - 0.27)
        inside = (ua > 0) & (ua < 1)
        z[inside] += apex * 4 * ua[inside] * (1 - ua[inside])
        air[inside] = np.maximum(air[inside], np.sin(math.pi * ua[inside]))
        prog += np.clip(ua, 0, 1) / n
    xy = p0[None, :] + u[None, :] * (D * prog)[:, None]
    yaw = _yaw_series(yaw0, psi, tau, 0.25)
    clip.put("base", "root", "location", f0, np.concatenate([xy, z[:, None]], axis=1), "hold")
    clip.put("base", "root", "rotation_euler", f0, np.stack([np.zeros(m), np.zeros(m), yaw], axis=1), "hold")
    clip.put("base", "squash", "scale", f0, np.stack([sxy - 1, sxy - 1, sz - 1], axis=1), "hold")
    lean = np.radians(9 * rig.energy) * (air - 0.35 * (sz < 0.9))
    clip.put("base", "body", "rotation_euler", f0, np.stack([lean, np.zeros(m), np.zeros(m)], axis=1), "hold")
    clip.put("head", "head", "rotation_euler", f0, np.stack([-shift(lean, 2) * 0.7, np.zeros(m), np.zeros(m)], axis=1), "add")
    if rig.legs:  # legs trail behind in the air
        tuck = np.radians(24) * air
        for side in "LR":
            clip.put("base", f"leg_{side}", "rotation_euler", f0, np.stack([tuck, np.zeros(m), np.zeros(m)], axis=1), "hold")
    for side in "LR":  # arms go up a little in the air
        if rig.has(f"arm_{side}"):
            up = shift(air, 2) * math.radians(35 * rig.energy)
            d = arm_delta(rig, actor.mix, side, swing_dirs(rig, side, up), f0)
            clip.put("base", f"arm_{side}", "rotation_euler", f0, d, "hold")
    f_end = min(f0 + m, ctx.n)
    actor.moving[f0:f_end] = np.maximum(actor.moving[f0:f_end], 1.0)
    clip.meta.update(gait="hop", hops=n, hopTime=Th, f0=f0)
    return clip


# ---------------------------------------------------------------- turn


def facing_yaw(ctx, actor, f, params):
    """The yaw a `turn` goes to: 'left' | 'right' | 'front' | 'back', degrees, or a target to face."""
    fc = params.get("facing", params.get("target"))
    named = {"left": -90.0, "right": 90.0, "front": 0.0, "back": 180.0}
    if isinstance(fc, (int, float)):
        return math.radians(fc)
    if isinstance(fc, str) and fc in named:
        return math.radians(named[fc])
    x0, y0, _, yaw0 = actor.root(f)
    g = ctx.ground(fc if fc is not None else "center", f)
    v = g - np.array([x0, y0])
    return math.atan2(v[0], -v[1]) if np.linalg.norm(v) > 1e-6 else yaw0


@action("turn")
def turn(ctx, actor, t0, t1, params):
    rig = actor.rig
    f0, f1 = ctx.f(t0), ctx.f(t1)
    clip = Clip(f0, f1)
    x0, y0, z0, yaw0 = actor.root(f0)
    yaw1 = facing_yaw(ctx, actor, f0, params)
    delta = wrap_pi(yaw1 - yaw0)
    if abs(delta) < math.radians(2):
        return clip
    m = (f1 - f0) + 1 + ctx.settle
    n = f1 - f0
    k = 1.0 / rig.tempo
    t_a = min(0.1 * k * FPS, 0.25 * n)
    prog = knots([(0, 0.0), (t_a, -0.07), (n * 0.78, 1.05), (n, 1.0), (n + 0.5 * ctx.settle, 1.0)], m)
    yaw = yaw0 + delta * prog
    clip.put("base", "root", "rotation_euler", f0, np.stack([np.zeros(m), np.zeros(m), yaw], axis=1), "hold")
    lead = shift(prog, 0)
    ahead = np.concatenate([prog[3:], np.full(3, prog[-1])])  # the head is 3 frames ahead of the body, then the body catches up
    clip.put("head", "head", "rotation_euler", f0, np.stack([np.zeros(m), np.zeros(m), 0.45 * delta * (ahead - lead)], axis=1), "add")
    twist = np.radians(min(9.0, abs(math.degrees(delta)) * 0.1)) * np.sign(delta) * knots([(0, 0), (t_a, -1.0), (n * 0.6, 0.3), (n, 0)], m)
    clip.put("base", "body", "rotation_euler", f0, np.stack([np.zeros(m), np.zeros(m), twist], axis=1), "hold")
    if rig.legs and abs(delta) > math.radians(25):
        _turn_feet(ctx, actor, clip, f0, m, n, yaw0, yaw)
    actor.moving[f0 : min(f0 + m, ctx.n)] = np.maximum(actor.moving[f0 : min(f0 + m, ctx.n)], 0.0)
    clip.meta.update(yaw0=yaw0, yaw1=yaw1)
    return clip


def _turn_feet(ctx, actor, clip, f0, m, n, yaw0, yaw):
    """Feet stay where they stand until the turn is half done, then each steps to its place under the new facing."""
    rig = actor.rig
    tau = np.arange(m) / FPS
    x0, y0, _, _ = actor.root(f0)
    p0 = np.array([x0, y0])
    yaw_end = float(yaw[-1])
    feet = {}
    for i, side in enumerate("LR"):
        sg = -1.0 if side == "L" else 1.0
        hx = abs(rig.hip[side][0])
        old = p0 + np.array([math.cos(yaw0), math.sin(yaw0)]) * sg * hx
        new = p0 + np.array([math.cos(yaw_end), math.sin(yaw_end)]) * sg * hx
        t_lift = (0.45 + 0.18 * i) * n / FPS
        t_land = t_lift + 0.28 * n / FPS
        xy, z = foot_series(tau, [(-1e9, old, t_lift), (t_land, new, 1e9)], 0.15 * rig.leg_len)
        feet[side] = np.concatenate([xy, z[:, None]], axis=1)
    legs = solve_legs(rig, np.tile(p0, (m, 1)), yaw, np.zeros(m), feet)
    _put_legs(clip, f0, legs)
    clip.meta["leg_driven"] = True


# ---------------------------------------------------------------- sit / stand_up


def _seat(ctx, actor, f, params):
    t = params.get("target")
    s = ctx.seats.get(t)
    if s is None:
        raise KeyError(f"{t!r} has no seat (a prop with a `seat`)")
    return np.array(s["xy"], dtype=float), float(s["z"]), float(s["yaw"])


def _arms_to(clip, actor, f0, m, e, side, dirs_end, lag=2):
    """Eases an arm from its current base direction to `dirs_end` (a state: held after)."""
    rig, mix = actor.rig, actor.mix
    if not rig.has(f"arm_{side}"):
        return
    a0 = mix.delta_at(f"arm_{side}", "rotation_euler", f0)
    rest = rig.rest_rot[f"arm_{side}"]
    end = arm_delta(rig, mix, side, np.asarray(dirs_end).reshape(1, 3), f0, ref=(a0[0] + rest[0], a0[1] + rest[1]))[0]
    w = shift(e, lag)[:, None]
    clip.put("base", f"arm_{side}", "rotation_euler", f0, a0[None, :] + w * (end - a0)[None, :], "hold")


@action("sit")
def sit(ctx, actor, t0, t1, params):
    rig, mix = actor.rig, actor.mix
    f0, f1 = ctx.f(t0), ctx.f(t1)
    clip = Clip(f0, f1)
    xy_s, h, yaw_s = _seat(ctx, actor, f0, params)
    x0, y0, z0, yaw0 = actor.root(f0)
    m = (f1 - f0) + 1 + ctx.settle
    n = f1 - f0
    z_sit = h - rig.seat_drop
    near = np.linalg.norm(xy_s - np.array([x0, y0]))
    tau = np.arange(m)
    slide = smoothstep(tau / max(0.5 * n, 1))
    xy = np.array([x0, y0])[None, :] + (xy_s - np.array([x0, y0]))[None, :] * slide[:, None]
    yaw = yaw0 + wrap_pi(yaw_s - yaw0) * smoothstep(tau / max(0.55 * n, 1))
    up = max(z_sit, 0.0)
    z = knots([(0, z0), (0.30 * n, z0), (0.38 * n, z0 - 0.012), (0.62 * n, z0 + up + 0.05 * rig.height), (0.82 * n, z0 + up - 0.008), (n, z0 + up), (n + ctx.settle, z0 + up)], m)
    clip.put("base", "root", "location", f0, np.concatenate([xy, z[:, None]], axis=1), "hold")
    clip.put("base", "root", "rotation_euler", f0, np.stack([np.zeros(m), np.zeros(m), yaw], axis=1), "hold")
    sq = knots([(0, 1), (0.30 * n, 0.9), (0.38 * n, 0.87), (0.5 * n, 1.12), (0.78 * n, 1.0), (0.84 * n, 0.9), (n, 1.0), (n + ctx.settle, 1.0)], m)
    sxy = 1 / np.sqrt(sq)
    clip.put("base", "squash", "scale", f0, np.stack([sxy - 1, sxy - 1, sq - 1], axis=1), "hold")
    lean = np.radians(11) * knots([(0, 0), (0.32 * n, 1.0), (0.6 * n, 0.2), (n, -0.2), (n + ctx.settle, 0.0)], m)
    clip.put("base", "body", "rotation_euler", f0, np.stack([lean, np.zeros(m), np.zeros(m)], axis=1), "hold")
    clip.put("head", "head", "rotation_euler", f0, np.stack([-shift(lean, 2) * 0.8, np.zeros(m), np.zeros(m)], axis=1), "add")
    e_legs = knots([(0, 0), (0.45 * n, 0), (0.75 * n, 1.0), (0.9 * n, 1.04), (n, 1.0), (n + ctx.settle, 1.0)], m)
    if rig.legs:
        for side in "LR":
            a = -math.radians(76) * e_legs
            clip.put("base", f"leg_{side}", "rotation_euler", f0, np.stack([a, np.zeros(m), np.zeros(m)], axis=1), "hold")
            clip.put("base", f"leg_{side}", "scale", f0, np.zeros((m, 3)), "hold")
    e_arm = knots([(0, 0), (0.4 * n, 0), (0.85 * n, 1.0), (n, 1.0)], m)
    for side in "LR":
        if rig.has(f"arm_{side}"):
            sx = 1.0 if side == "R" else -1.0
            lap = np.array([sx * 0.18, -0.55, -0.82])
            _arms_to(clip, actor, f0, m, e_arm, side, clamp_arm(rig, side, lap.reshape(1, 3))[0])
    actor.seated[f0 + n : ] = True
    clip.meta.update(seat=params.get("target"), zSit=z_sit)
    return clip


@action("stand_up")
def stand_up(ctx, actor, t0, t1, params):
    rig = actor.rig
    f0, f1 = ctx.f(t0), ctx.f(t1)
    clip = Clip(f0, f1)
    x0, y0, z0, yaw0 = actor.root(f0)
    m = (f1 - f0) + 1 + ctx.settle
    n = f1 - f0
    fwd = np.array([math.sin(yaw0), -math.cos(yaw0)])
    step = float(params.get("step", 0.65)) * rig.height
    xy = np.array([x0, y0])[None, :] + fwd[None, :] * (step * smoothstep((np.arange(m) - 0.35 * n) / (0.5 * n)))[:, None]
    z = knots([(0, z0), (0.28 * n, z0 - 0.01), (0.5 * n, z0 + 0.05 * rig.height), (0.8 * n, 0.0), (n, 0.0), (n + ctx.settle, 0.0)], m)
    clip.put("base", "root", "location", f0, np.concatenate([xy, z[:, None]], axis=1), "hold")
    sq = knots([(0, 1), (0.25 * n, 0.9), (0.5 * n, 1.14), (0.8 * n, 1.02), (0.88 * n, 0.86), (n, 1.0), (n + ctx.settle, 1.0)], m)
    sxy = 1 / np.sqrt(sq)
    clip.put("base", "squash", "scale", f0, np.stack([sxy - 1, sxy - 1, sq - 1], axis=1), "hold")
    lean0 = float(mix_val(actor, "body", f0)[0][0])
    lean = lean0 * (1 - smoothstep(np.arange(m) / (0.3 * n))) + np.radians(14) * knots([(0, 0), (0.25 * n, 1.0), (0.55 * n, 0.0), (n, -0.15), (n + ctx.settle, 0)], m)
    clip.put("base", "body", "rotation_euler", f0, np.stack([lean, np.zeros(m), np.zeros(m)], axis=1), "hold")
    clip.put("head", "head", "rotation_euler", f0, np.stack([-shift(lean - lean0, 2) * 0.8, np.zeros(m), np.zeros(m)], axis=1), "add")
    if rig.legs:
        a0 = float(mix_val(actor, "leg_L", f0)[0][0])
        e = 1 - knots([(0, 0), (0.15 * n, 0), (0.6 * n, 1.0), (n, 1.0), (n + ctx.settle, 1.0)], m)
        for side in "LR":
            clip.put("base", f"leg_{side}", "rotation_euler", f0, np.stack([a0 * e, np.zeros(m), np.zeros(m)], axis=1), "hold")
            clip.put("base", f"leg_{side}", "scale", f0, np.zeros((m, 3)), "hold")
    e_arm = knots([(0, 0), (0.3 * n, 0), (0.8 * n, 1.0), (n, 1.0)], m)
    for side in "LR":
        _arms_to(clip, actor, f0, m, e_arm, side, hang_dir(rig, side))
    actor.seated[f0:] = np.where(np.arange(f0, ctx.n) < f0 + int(0.4 * n), actor.seated[f0:], False)
    return clip


def mix_val(actor, ctl, f):
    return actor.mix.delta_at(ctl, "rotation_euler", f)[None, :]
