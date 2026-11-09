# SPDX-License-Identifier: GPL-3.0-or-later
"""The vehicle acting family (HUB-31 CTS-34): the HUB-30 principles (anticipation, easing, overlap, moving holds, springs, tempo) on a body with
wheels, lamp eyes and a front block instead of arms and legs.

The body. A vehicle is `root` (on the ground or the rail top) > `squash` (the suspension) > `body` > `head` (the front block with the lamp eyes and
the bumper-mouth); the wheels hang on `root`, so the body can pitch, roll, squat and shake on its suspension while the wheels stay on the ground.
Only a jump (`bounce`, `react_surprised`) lifts the root. A wheel spins about its control's local x (`rotation_euler[0]`; + rolls forward, to -y)
by the distance its own centre travels along the vehicle's forward axis divided by `vehicle.wheelRadius` (no slide). The lamp glow is
`Mix.glow` (added to the rest value of `head["lamp_glow"]`), smoke is `Mix.puffs` (events the writer plays on the puff pool of `chimney` or
`exhaust`), the hoods are the lids.

Locomotion along paths (the contract with the timeline and the assembler, CTS-35). `drive`, `zoom`, `reverse` (a car) and `chug` (a train) take
    params = {"path": [[x, y], ...]        # a polyline in world metres from the vehicle to the end mark (the path between the two marks);
                                            #   the current root position is put in front of it when it is more than 1 cm away
              | "target": <mark | prop | [x, y, z]>   # or a straight line to a point
              "z": <ground or rail-top height>,     # the root height while moving (default: where the root is); eased in over the move
              "stop": <metres short of the end>}    # optional
and run from t0 to t1: an anticipation (0.16 s / tempo for a car, 0.32 s for a train) and then the move, which arrives at t1; the
suspension rocks and settles after it. The root follows the polyline exactly (by arc length); the facing is the chord one half wheelbase either
side of the root, so corners are rounded the way axles round them; `reverse` faces against the travel. The clip's meta has `distance`, `rootEnd`,
`yawEnd`, `moveStart`/`moveEnd` (frames) and `puffs`. `nominal_seconds(spec, distance, style)` is the usual duration for a distance.
A train only ever chugs: `drive`, `zoom` and `reverse` on a train run as a chug (forward or back); `turn` on a train does nothing (`meta.refused`).
A train's front block never yaws, its body never turns to look.

Every action keys only the controls in its `parts` in library.json (test B2v).
"""
import math

import numpy as np

from . import BOTH, action
from .core import FPS, TAU, Clip, gesture_env, knots, shift, smoothstep, wrap_pi
from .gait import _trapezoid, facing_yaw
from .gestures import SLOT, _aim, _brows, _frames, _idle, _noise, _rot, _vec, blink_amounts

DEG = math.radians
VEH = ("vehicle",)


def is_vehicle(actor):
    return actor is not None and actor.rig.spec.get("kind") == "vehicle"


class VInfo:
    """What the vehicle actions need to know, read from the spec's `vehicle` and `motion.drive` blocks."""

    def __init__(self, rig):
        spec = rig.spec
        v = spec.get("vehicle") or {}
        self.type = v.get("type", "car")
        self.train = self.type == "train"
        self.R = max(float(v.get("wheelRadius", 0.2)), 0.02)
        ws = [w for w in (v.get("wheels") or []) if rig.has(w)] or sorted(n for n in rig.controls if n.startswith("wheel_"))
        self.wheels = ws
        self.wpos = {w: rig.world_rest(w)[:3, 3].copy() for w in ws}
        ys = [abs(p[1]) for p in self.wpos.values()] or [0.4]
        self.half_base = max(max(ys), 0.25)
        d = spec["motion"].get("drive") or {}
        self.style = d.get("style", "chug" if self.train else "zip")
        self.top = max(float(d.get("topSpeed", 1.6 if self.train else 3.0)), 0.2)
        self.accel = max(float(d.get("accel", 0.6 if self.train else 3.0)), 0.1)
        susp = float(np.clip(d.get("suspension", 0.5), 0.0, 1.0))
        self.susp = susp
        # the suspension as a spring: natural frequency (Hz) and damping ratio; a train is heavy and settles late
        self.fn = (0.9 + 0.5 * (1 - susp)) if self.train else (1.7 + 1.1 * (1 - susp))
        self.zeta = 0.32 if self.train else 0.18 + 0.14 * (1 - rig.bounce)
        self.pitch_k = DEG(0.8 if self.train else 1.5 * (0.6 + susp))  # body pitch per m/s2 of acceleration along the travel
        self.roll_k = DEG(0.5 if self.train else 2.0 * (0.6 + susp))  # body roll per m/s2 sideways
        self.puff_src = "chimney" if rig.has("chimney") else ("exhaust" if rig.has("exhaust") else None)
        self.settle = int(round((1.1 if self.train else 0.6) * FPS))  # frames the suspension gets to settle after a move


def vinfo(rig):
    if getattr(rig, "_vinfo", None) is None:
        rig._vinfo = VInfo(rig)
    return rig._vinfo


def nominal_seconds(spec, distance, style="drive"):
    """The usual duration of a move of `distance` metres: an anticipation and a trapezoid at the spec's top speed and acceleration."""
    d = spec["motion"].get("drive") or {}
    train = (spec.get("vehicle") or {}).get("type") == "train"
    top = float(d.get("topSpeed", 1.6 if train else 3.0)) * {"zoom": 1.5, "reverse": 0.6}.get(style, 1.0)
    acc = float(d.get("accel", 0.6 if train else 3.0)) * STYLES.get(style, STYLES["drive"])["accel"]
    tempo = float(spec["motion"].get("tempo", 1.0))
    t_ramp = top / acc
    move = 2 * math.sqrt(distance / acc) if distance < top * t_ramp else distance / top + t_ramp
    return round((0.32 if train else 0.16) / tempo + move, 2)


# ---------------------------------------------------------------- the park state (an engine that is off, half hoods, lamps off)


def park_level(actor):
    if getattr(actor, "vpark", None) is None or len(actor.vpark) != actor.ctx.n:
        actor.vpark = np.zeros(actor.ctx.n)
    return actor.vpark


def _set_park(actor, f0, ramp, to):
    lv = park_level(actor)
    n = len(lv)
    if f0 >= n:
        return
    start = float(lv[f0])
    k = np.arange(n - f0)
    lv[f0:] = start + (to - start) * smoothstep(k / max(ramp, 1))


# ---------------------------------------------------------------- paths


class Polyline:
    """A path of 2D points, walked by arc length; beyond the ends it goes straight on (so a heading is defined everywhere)."""

    def __init__(self, pts):
        p = [np.asarray(q, dtype=float)[:2] for q in pts]
        keep = [p[0]]
        for q in p[1:]:
            if np.linalg.norm(q - keep[-1]) > 1e-4:
                keep.append(q)
        self.p = np.array(keep)
        if len(self.p) < 2:
            self.p = np.array([keep[0], keep[0] + np.array([0.0, -1e-3])])
        self.d = np.diff(self.p, axis=0)
        self.seg = np.linalg.norm(self.d, axis=1)
        self.cum = np.concatenate([[0.0], np.cumsum(self.seg)])
        self.length = float(self.cum[-1]) if len(keep) > 1 else 0.0

    def at(self, s):
        s = np.atleast_1d(np.asarray(s, dtype=float))
        i = np.clip(np.searchsorted(self.cum, s, side="right") - 1, 0, len(self.seg) - 1)
        u = (s - self.cum[i]) / np.maximum(self.seg[i], 1e-9)
        return self.p[i] + self.d[i] * u[:, None]


def path_distance(points, q):
    """Distance (m) from 2D points q (N, 2) to a polyline: the sideways error of a wheel on a track."""
    p = np.asarray(points, dtype=float)[:, :2]
    q = np.atleast_2d(np.asarray(q, dtype=float))[:, :2]
    best = np.full(len(q), np.inf)
    for a, b in zip(p[:-1], p[1:]):
        ab = b - a
        t = np.clip(((q - a) @ ab) / max(float(ab @ ab), 1e-12), 0, 1)
        best = np.minimum(best, np.linalg.norm(q - (a + t[:, None] * ab), axis=1))
    return best


def _route(ctx, actor, f0, params, sign):
    x0, y0, z0, yaw0 = actor.root(f0)
    start = np.array([x0, y0])
    if params.get("path"):
        pts = [np.asarray(q, dtype=float)[:2] for q in params["path"]]
        if np.linalg.norm(pts[0] - start) > 0.01:
            pts.insert(0, start)
    elif params.get("target") is not None:
        pts = [start, ctx.ground(params["target"], f0)]
    else:
        fwd = np.array([math.sin(yaw0), -math.cos(yaw0)])
        pts = [start, start + fwd * sign * float(params.get("distance", 2.0))]
    line = Polyline(pts)
    D = max(0.0, line.length - float(params.get("stop", 0.0)))
    return line, D, z0, float(params.get("z", z0)), yaw0


# ---------------------------------------------------------------- the suspension and the wheels


def _spring(target, fn, zeta, x0=0.0, v0=0.0, sub=4):
    """A damped spring that follows `target` (its rest point per frame): the body's pitch or roll on the suspension."""
    w = TAU * fn
    dt = 1.0 / (FPS * sub)
    out = np.zeros(len(target))
    x, v = float(x0), float(v0)
    for i, g in enumerate(target):
        for _ in range(sub):
            a = w * w * (g - x) - 2 * zeta * w * v
            v += a * dt
            x += v * dt
        out[i] = x
    return out


def _carry(ctx, actor, clip, f0, xy, yaw, z, anti_f=0, anti=1.0, stretch=0.0):
    """Writes a move of the root (xy (m, 2), yaw (m,), z (m,)) to the base layer, with the wheels rolling exactly the distance each wheel centre
    travels, and the body riding on the suspension: it pitches with the acceleration along the travel (a squat and a nose lift on a start, a nose
    dip on braking, a damped rock after the stop) and rolls into turns. `anti_f` frames of anticipation first (the rear squats, the springs load).
    The front block lags the body by 2 frames. Every base channel but the root and the wheels ends at exactly 0."""
    rig, mix, vi = actor.rig, actor.mix, vinfo(actor.rig)
    m = len(xy)
    clip.put("base", "root", "location", f0, np.column_stack([xy, z]), "hold")
    clip.put("base", "root", "rotation_euler", f0, np.column_stack([np.zeros(m), np.zeros(m), yaw]), "hold")
    c, s = np.cos(yaw), np.sin(yaw)
    fwd = np.stack([s, -c], axis=1)
    right = np.stack([c, s], axis=1)
    for w, p in vi.wpos.items():
        wp = np.stack([xy[:, 0] + c * p[0] - s * p[1], xy[:, 1] + s * p[0] + c * p[1]], axis=1)
        d = np.diff(wp, axis=0, prepend=wp[:1])
        ds = (d * fwd).sum(axis=1)
        a0 = mix.delta_at(w, "rotation_euler", f0, ("base",))
        vals = np.tile(a0, (m, 1))
        vals[:, 0] = a0[0] + np.cumsum(ds) / vi.R
        clip.put("base", w, "rotation_euler", f0, vals, "hold")
    vel = np.gradient(xy, axis=0) * FPS if m > 1 else np.zeros_like(xy)
    acc = np.gradient(vel, axis=0) * FPS if m > 1 else np.zeros_like(xy)
    if m > 4:
        acc = np.apply_along_axis(lambda a: np.convolve(np.pad(a, 2, mode="edge"), np.ones(5) / 5, mode="valid"), 0, acc)
    a_f = (acc * fwd).sum(axis=1)
    a_l = (acc * right).sum(axis=1)
    e = rig.energy
    lim_p, lim_r = DEG(9 if not vi.train else 3), DEG(8 if not vi.train else 2)
    pitch_t = np.clip(-vi.pitch_k * a_f * e, -lim_p, lim_p)
    roll_t = np.clip(vi.roll_k * a_l * e, -lim_r, lim_r)  # into the turn
    if anti_f > 0:  # anticipation: the rear squats (nose up) before the wheels turn
        pitch_t = pitch_t - DEG(2.6 if not vi.train else 0.8) * anti * e * knots([(0, 0), (0.75 * anti_f, 1.0), (anti_f + 2, 0.5), (anti_f + 6, 0.0)], m)
    b0 = mix.delta_at("body", "rotation_euler", f0, ("base",))
    b1 = mix.delta_at("body", "rotation_euler", max(f0 - 1, 0), ("base",))
    pitch = _spring(pitch_t, vi.fn, vi.zeta, b0[0], (b0[0] - b1[0]) * FPS)
    roll = _spring(roll_t, vi.fn * 1.25, vi.zeta, b0[1], (b0[1] - b1[1]) * FPS)
    fade = smoothstep((m - 1 - np.arange(m)) / 6.0)
    soft_p, soft_r = 1.25 * lim_p, 1.1 * lim_r  # a hard launch or a sharp corner overshoots the spring: limit it softly
    pitch, roll = soft_p * np.tanh(pitch / soft_p) * fade, soft_r * np.tanh(roll / soft_r) * fade
    clip.put("base", "body", "rotation_euler", f0, np.column_stack([pitch, roll, np.zeros(m)]), "hold")
    # the suspension: loaded in the anticipation, a little stretch on the launch; a zoom stretches along the travel with the speed
    speed = np.linalg.norm(vel, axis=1)
    sz = np.zeros(m)
    if anti_f > 0:
        sz = -0.035 * anti * e * knots([(0, 0), (0.8 * anti_f, 1.0), (anti_f + 2, -0.45), (anti_f + 7, 0.1), (anti_f + 11, 0.0)], m)
    sy = stretch * np.clip(speed / vi.top, 0, 1.5) * fade
    sc = np.column_stack([-0.5 * sz - 0.5 * sy, sy - 0.5 * sz, sz - 0.5 * sy])
    clip.put("base", "squash", "scale", f0, sc * fade[:, None], "hold")
    lag_p, lag_r = pitch - shift(pitch, 2), roll - shift(roll, 2)
    clip.put("head", "head", "rotation_euler", f0, np.column_stack([-0.6 * lag_p, -0.6 * lag_r, np.zeros(m)]), "add")
    mv = np.clip(speed / max(0.25 * vi.top, 0.1), 0, 1)
    f_end = min(f0 + m, ctx.n)
    actor.moving[f0:f_end] = np.maximum(actor.moving[f0:f_end], mv[: f_end - f0])
    return speed


def _spin_add(clip, actor, f0, angle):
    """Adds a wheel spin (radians, (k,)) from f0 to every wheel, and keeps the last angle to the end (the wheels' angle is a state)."""
    n = actor.ctx.n
    k = len(angle)
    full = np.concatenate([angle, np.full(max(n - f0 - k, 0), angle[-1])])[: max(n - f0, 0)]
    for w in vinfo(actor.rig).wheels:
        clip.put("base", w, "rotation_euler", f0, _vec(len(full), x=full), "add")


def _pulse(m, f, rise=2, fall=6, amp=1.0, under=0.2):
    """A quick bump from frame f: up in `rise` frames, an undershoot, back to 0 (a puff, a chuff, an accent)."""
    return amp * knots([(0, 0), (f, 0), (f + rise, 1.0), (f + rise + fall * 0.6, -under), (f + rise + fall, 0.0)], m)


def _src(actor):
    return vinfo(actor.rig).puff_src


def _puff_pulse(clip, actor, f0, m, f, size=1.0, drift=0.0, source=None):
    """A puff from the chimney or the exhaust at frame f0 + f: the source pops (scale) and a cloud leaves it."""
    src = source or _src(actor)
    if src is None or not actor.rig.has(src):
        return
    p = _pulse(m, f, 2, 7, 1.0)
    k = 0.22 if src == "chimney" else 0.35
    clip.put("gesture", src, "scale", f0, np.column_stack([-0.3 * k * p, -0.3 * k * p, k * p * size]), "add")
    clip.puff(f0 + int(f), src, size, drift)


# ---------------------------------------------------------------- locomotion

STYLES = {
    "drive": dict(accel=1.0, sign=1, anti=1.0, stretch=0.0, puff=False),
    "zoom": dict(accel=2.2, sign=1, anti=1.5, stretch=0.12, puff=True),
    "reverse": dict(accel=0.7, sign=-1, anti=0.6, stretch=0.0, puff=False),
    "chug": dict(accel=1.0, sign=1, anti=1.0, stretch=0.0, puff=True),
}


def locomote(ctx, actor, t0, t1, params, style):
    rig, vi = actor.rig, vinfo(actor.rig)
    f0, f1 = ctx.f(t0), ctx.f(t1)
    clip = Clip(f0, f1)
    st = dict(STYLES[style])
    chug = vi.train or style == "chug"
    if vi.train and style != "chug":  # a train only chugs along its track (forward, or back for `reverse`)
        st = dict(STYLES["chug"], sign=st["sign"])
    sign = st["sign"]
    line, D, z0, z1, yaw0 = _route(ctx, actor, f0, params, sign)
    clip.meta.update(style=style, distance=0.0, f0=f0)
    if D < 0.02:
        return clip
    n = max(f1 - f0, 2)
    m = n + 1 + vi.settle
    tau = np.arange(m) / FPS
    T = n / FPS
    A = min((0.32 if vi.train else 0.16) / rig.tempo * math.sqrt(st["anti"]), 0.3 * T)
    Tm = max(T - A, 1.0 / FPS)
    acc = vi.accel * st["accel"]
    q = D / (acc * Tm * Tm)
    r = 0.5 if q >= 0.25 else (1 - math.sqrt(1 - 4 * q)) / 2
    r = float(np.clip(r, 0.12, 0.5))
    s = D * _trapezoid((tau - A) / Tm, r)
    a = vi.half_base
    xy = line.at(s)
    ch = line.at(s + a) - line.at(s - a)
    head = np.unwrap(np.arctan2(ch[:, 0], -ch[:, 1]))
    if sign < 0:
        head = head + math.pi
    head = head + TAU * round((yaw0 - head[0]) / TAU)
    off = yaw0 - head[0]
    yaw = head + off * (1 - smoothstep(s / max(2 * a, 0.3)))
    z = z0 + (z1 - z0) * smoothstep(s / max(D, 1e-6))
    surface = getattr(ctx, "surface", None)  # the assembler's ground height under a car (the crossing boards over a track, CTS-35)
    if surface is not None and not vi.train:  # the mean of what is under the front and the rear axle, so the car rides up the ramp
        ax = np.stack([np.sin(yaw), -np.cos(yaw)], axis=1) * vi.half_base
        z = np.maximum(z, 0.5 * (surface(xy + ax) + surface(xy - ax)))
    anti_f = int(round(A * FPS))
    speed = _carry(ctx, actor, clip, f0, xy, yaw, z, anti_f, st["anti"], st["stretch"])
    puffs = []
    if chug:
        every = max(float(params.get("puffEveryM", 1.5)), 0.2)
        ticks = np.floor(s / every)
        fs = [max(anti_f - 3, 0)] + [int(i) for i in np.nonzero(np.diff(ticks) > 0)[0] + 1]
        for f in fs:
            v = float(speed[min(f, m - 1)])
            size = 0.75 + 0.55 * (1 - min(v / vi.top, 1.0))  # slow, heavy chuffs are big
            _puff_pulse(clip, actor, f0, m, f, size, v)
            ch_ = _pulse(m, f, 2, 7, 1.0)
            clip.put("gesture", "squash", "scale", f0, np.column_stack([0.004 * ch_, 0.004 * ch_, -0.012 * ch_]), "add")
            puffs.append(f0 + f)
    elif st["puff"]:
        _puff_pulse(clip, actor, f0, m, max(anti_f - 2, 0), 1.0, 0.0, "exhaust" if rig.has("exhaust") else None)
        puffs.append(f0 + max(anti_f - 2, 0))
    clip.meta.update(distance=D, rootEnd=xy[-1].tolist(), yawEnd=float(yaw[-1]), moveStart=f0 + anti_f, moveEnd=f1, puffs=puffs, sign=sign, chug=chug)
    return clip


@action("drive", bodies=VEH)
def drive(ctx, actor, t0, t1, params):
    return locomote(ctx, actor, t0, t1, params, "drive")


@action("zoom", bodies=VEH)
def zoom(ctx, actor, t0, t1, params):
    return locomote(ctx, actor, t0, t1, params, "zoom")


@action("reverse", bodies=VEH)
def reverse(ctx, actor, t0, t1, params):
    return locomote(ctx, actor, t0, t1, params, "reverse")


@action("chug", bodies=VEH)
def chug(ctx, actor, t0, t1, params):
    return locomote(ctx, actor, t0, t1, params, "chug")


def turn(ctx, actor, t0, t1, params):
    """A car turns on a short arc on the ground (wheels rolling); a train cannot turn (it follows its track): nothing happens. CTS-41: the arc is
    bent back so the car ends on the line it stood on (its road): the sideways part of the arc's chord is taken out as the turn goes on, only the
    forward part stays."""
    rig, vi = actor.rig, vinfo(actor.rig)
    f0, f1 = ctx.f(t0), ctx.f(t1)
    clip = Clip(f0, f1)
    if vi.train:
        clip.meta["refused"] = "a train only turns with its track"
        return clip
    x0, y0, z0, yaw0 = actor.root(f0)
    delta = wrap_pi(facing_yaw(ctx, actor, f0, params) - yaw0)
    if abs(delta) < DEG(2):
        return clip
    n = max(f1 - f0, 2)
    m = n + 1 + vi.settle
    A = int(round(min(0.12 / rig.tempo, 0.25 * n / FPS) * FPS))
    radius = max(1.1 * vi.half_base, 0.5)
    prog = _trapezoid((np.arange(m) - A) / max(n - A, 1), 0.4)
    yaw = yaw0 + delta * prog
    ds = np.diff(prog, prepend=0.0) * radius * abs(delta)
    mid = yaw - 0.5 * np.diff(yaw, prepend=yaw[0])
    xy = np.array([x0, y0]) + np.cumsum(np.stack([np.sin(mid), -np.cos(mid)], axis=1) * ds[:, None], axis=0)
    side = np.array([math.cos(yaw0), math.sin(yaw0)])  # the start heading's right: off the road
    off = float((xy[-1] - np.array([x0, y0])) @ side)
    xy = xy - np.outer(prog, side * off)
    _carry(ctx, actor, clip, f0, xy, yaw, np.full(m, z0), A, 0.6)
    clip.meta.update(yaw0=yaw0, yaw1=yaw0 + delta, arc=radius * abs(delta))
    return clip


# ---------------------------------------------------------------- auto: idle, blink, look, talk, listen


def idle_engine_clip(ctx, actor, f0=0, f1=None, auto=True):
    """The engine running: a fine suspension bob and a shiver (a car), a slow breathing heave and now and then a breathing puff (a train); the
    shiver stops while parked, the bob fades while moving. With `auto`, the park state also gives half hoods and lamps off."""
    rig, n, vi = actor.rig, ctx.n, vinfo(actor.rig)
    f1 = n - 1 if f1 is None else min(f1, n - 1)
    clip = Clip(f0, f1)
    rng = ctx.rng("idle", actor.id)
    t = np.arange(n) / FPS
    e = rig.energy
    park = park_level(actor)
    run = 1.0 - park
    free = 1.0 - np.clip(actor.moving, 0, 1)
    hz = (0.22 if vi.train else 1.5) * math.sqrt(rig.tempo)
    ph = float(rng.uniform(0, TAU))
    breath = np.sin(TAU * hz * t + ph)
    amp = (0.011 if vi.train else 0.004) * e
    shiver = _noise(rng, n, 0.02)
    sh_amp = (0.0012 if vi.train else 0.0028) * e
    z = amp * breath * free * (0.35 + 0.65 * run) + sh_amp * shiver * run
    _idle(clip, "squash", "scale", np.column_stack([-0.5 * z, -0.5 * z, z]), f0, f1)
    sway, roll_n, jit = _noise(rng, n, 1.1), _noise(rng, n, 1.5), _noise(rng, n, 0.02)
    body = _rot(DEG(0.25 * e) * sway * free + DEG(0.12) * jit * run, DEG(0.3 * e) * roll_n * free + DEG(0.08) * jit * run, 0)
    _idle(clip, "body", "rotation_euler", body, f0, f1)
    hx, hz_ = _noise(rng, n, 0.5), _noise(rng, n, 0.7)
    yaw_h = 0.0 if vi.train else DEG(0.6 * e) * hz_
    _idle(clip, "head", "rotation_euler", _rot(DEG(0.5 * e) * hx - 0.004 * e * breath, 0, yaw_h), f0, f1)
    if vi.train and rig.has("chimney"):  # the chimney breathes with the heave, and puffs at a breath peak every few seconds when standing
        _idle(clip, "chimney", "scale", np.column_stack([np.zeros(n), np.zeros(n), 0.03 * breath * run]), f0, f1)
        if auto:
            last = -99.0
            for i in range(1, n - 1):
                if breath[i] >= breath[i - 1] and breath[i] > breath[i + 1] and breath[i] > 0.9 and t[i] - last > 3.0 / rig.tempo and free[i] > 0.95 and run[i] > 0.95:
                    clip.puff(i, "chimney", 0.45, 0.0)
                    last = t[i]
    # the antenna is a spring chain (the secondary layer): the shiver and the bob drive it
    if auto and park.any():
        clip.lid(0, 0.5 * park)
        clip.glow(0, -park)
    return clip


@action("idle_engine", bodies=VEH)
def idle_engine(ctx, actor, t0, t1, params):
    return idle_engine_clip(ctx, actor, ctx.f(t0), ctx.f(t1), auto=False)


def hood_blink():
    """A hood blink: a train's heavy hoods are slower."""
    return np.array([0.0, 0.4, 0.8, 1.0, 1.0, 0.7, 0.35, 0.0])


def blink(ctx, actor, t0, t1, params):
    f0, f1 = ctx.f(t0), ctx.f(t1)
    clip = Clip(f0, f1)
    clip.lid(f0, hood_blink() if vinfo(actor.rig).train else blink_amounts())
    return clip


def look_at(ctx, actor, t0, t1, params):
    """The pupils lead; the front block follows 2 frames later (a car: yaw up to 22 deg; a train never yaws), pitch -12..+10 deg; a car's body
    twists up to 12 deg on its suspension only when the car stands still and the target is past `bodyPastDeg` (60). Holds until the next look."""
    rig, vi = actor.rig, vinfo(actor.rig)
    f0, f1 = ctx.f(t0), ctx.f(t1)
    clip = Clip(f0, f1)
    end = int(min(params.get("_hold_to", ctx.n - 1), ctx.n - 1))
    m = max(end - f0 + 1, f1 - f0 + 1)
    n = max(f1 - f0, 1)
    past = DEG(float(params.get("bodyPastDeg", 60)))
    head_lim = 0.0 if vi.train else DEG(22)
    body_lim = 0.0 if vi.train else DEG(12)
    lag = 3 if vi.train else 2
    prev_h = actor.mix.delta_at("head", "rotation_euler", f0, ("look",))
    prev_b = actor.mix.delta_at("body", "rotation_euler", f0, ("look",))
    ps = actor.mix.delta_at("pupil_L", "location", f0, ("face",)) if rig.has("pupil_L") else np.zeros(3)
    head = np.zeros((m, 3))
    body = np.zeros((m, 3))
    pup = np.zeros((m, 3))
    cur_y, cur_p, cur_b = prev_h[2], prev_h[0], prev_b[2]
    for i in range(m):
        f = min(f0 + i, ctx.n - 1)
        target = None if params.get("target") is None else ctx.point(params["target"], f)
        if target is None:
            tgt_y = tgt_p = 0.0
        else:
            tgt_y, tgt_p = _aim(ctx, actor, f, target)
            tgt_y = wrap_pi(tgt_y)
        yaw_h = float(np.clip(tgt_y, -head_lim, head_lim))
        stopped = actor.moving[f] < 0.05
        yaw_b = float(np.clip(tgt_y - yaw_h, -body_lim, body_lim)) if (abs(tgt_y) > past and stopped) else 0.0
        pit_h = float(np.clip(tgt_p, -DEG(12), DEG(10)))
        p = float(smoothstep((i - lag) / n))
        goal_y = prev_h[2] * (1 - p) + yaw_h * p
        goal_p = prev_h[0] * (1 - p) + pit_h * p
        goal_b = prev_b[2] * (1 - p) + yaw_b * p
        k = 0.3 if vi.train else 0.45
        cur_y, cur_p, cur_b = cur_y + (goal_y - cur_y) * k, cur_p + (goal_p - cur_p) * k, cur_b + (goal_b - cur_b) * k
        head[i] = (cur_p, 0.0, cur_y)
        body[i] = (0.0, 0.0, cur_b)
        res_y, res_p = tgt_y - (cur_y + cur_b if target is not None else 0.0), tgt_p - cur_p
        q = float(smoothstep((i + 1) / max(n * 0.45, 1)))
        px = np.clip(res_y / DEG(40), -1, 1) * 0.6 * rig.eye_r
        pz = np.clip(-res_p / DEG(30), -1, 1) * 0.45 * rig.eye_r
        pup[i] = (ps[0] * (1 - q) + px * q, 0.0, ps[2] * (1 - q) + pz * q)
    clip.put("look", "head", "rotation_euler", f0, head, "hold")
    if body_lim > 0:
        clip.put("look", "body", "rotation_euler", f0, body, "hold")
    for side in "LR":
        clip.put("face", f"pupil_{side}", "location", f0, pup, "hold")
    swing = abs(wrap_pi(head[min(n, m - 1), 2] - prev_h[2])) + abs(body[min(n, m - 1), 2] - prev_b[2]) + abs(pup[min(n, m - 1), 0] - ps[0]) / max(rig.eye_r, 1e-6) * DEG(20)
    clip.meta.update(bigTurn=swing > DEG(30), f0=f0)
    return clip


def talking_clip(ctx, actor, accents):
    """While a vehicle speaks: on each word onset the front block gives a small nod-accent, the visors (brows) lift over the lamp hoods and the
    suspension dips a little. Never the mouth (that is the lip-sync)."""
    rig, vi = actor.rig, vinfo(actor.rig)
    clip = Clip(0, ctx.n - 1)
    rng = ctx.rng("talk", actor.id)
    last = -9.0
    for t in accents:
        if t - last < 0.28:
            continue
        last = t
        f = ctx.f(t)
        strength = float(rng.uniform(0.6, 1.0)) * rig.energy
        bump = knots([(0, 0), (2, 1.0), (5, -0.25), (8, 0)], 9)
        sign = float(rng.choice([-1.0, 1.0]))
        yaw = 0.0 if vi.train else sign * DEG(1.2 * strength)
        clip.put("head", "head", "rotation_euler", f, _rot(DEG(2.4 * strength) * bump, sign * DEG(0.8 * strength) * bump, yaw * bump), "add")
        clip.put("head", "squash", "scale", f, _vec(9, x=0.002 * strength * shift(bump, 1), y=0.002 * strength * shift(bump, 1), z=-0.006 * strength * shift(bump, 1)), "add")
        _brows(clip, rig, f, 0.25 * strength * bump)
    return clip


def listening_actions(ctx, listener, speaker_id, speaking, accents, explicit_looks=()):
    """A vehicle listening: looks at the speaker as they start, leans toward them through the line, and nods now and then on their accents."""
    out = []
    taken = {round(a["t0"], 1) for a in explicit_looks}
    for t0, t1 in speaking:
        tl = max(t0 - 0.15, 0.0)
        if round(tl, 1) not in taken:
            out.append({"action": "look_at", "t0": tl, "t1": tl + 0.45, "params": {"target": speaker_id}})
        if t1 - t0 > 0.9:
            out.append({"action": "lean", "t0": t0 + 0.2, "t1": t0 + 0.2 + min(2.2, t1 - t0 - 0.3), "params": {"target": speaker_id, "amp": 0.5}})
    rng = ctx.rng("listen", listener.id)
    last = -9.0
    for t in accents:
        if t - last < 1.8 or not any(a <= t <= b for a, b in speaking):
            continue
        if rng.uniform() < 0.45:
            out.append({"action": "nod", "t0": t + 0.1, "t1": t + 0.1 + 0.6, "params": {"count": 1, "amp": 0.5}})
            last = t
    return out


# ---------------------------------------------------------------- gestures shared with creatures (called from gestures.py)


def _count_env(n, m, settle, count, d, first=-0.22, decay=0.1, alt=False):
    """The knots of a repeated gesture (a nod, a shake): `count` beats of length d frames after a small anticipation."""
    pts = [(0, 0.0), (0.12 * d, first)]
    for c in range(count):
        a = 0.12 * d + c * d
        k = 1.0 - decay * c
        if alt:
            pts += [(a + 0.25 * d, -k), (a + 0.75 * d, k * 0.9)]
        else:
            pts += [(a + 0.28 * d, k), (a + 0.62 * d, -0.18), (a + 0.9 * d, 0.0)]
    pts += [(n + 0.4 * settle, 0.04), (n + settle - 3, 0.0), (n + settle, 0.0)]
    return knots(sorted([(min(f, m - 1), v) for f, v in pts], key=lambda p: p[0]), m)


def nod(ctx, actor, t0, t1, params):
    """The front dips on the suspension: the body pitches nose-down, the springs give, the front block follows 2 frames later."""
    rig = actor.rig
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    count = int(params.get("count", 2))
    amp = DEG(6 * rig.energy) * float(params.get("amp", 1.0))
    d = min(0.4 / rig.tempo, 0.9 * (n / FPS) / max(count, 1)) * FPS
    e = _count_env(n, m, ctx.settle, count, d)
    clip.put("gesture", "body", "rotation_euler", f0, _rot(amp * e, 0, 0), "blend")
    clip.put("gesture", "squash", "scale", f0, _vec(m, x=0.006 * np.abs(e), y=0.006 * np.abs(e), z=-0.02 * float(params.get("amp", 1.0)) * np.clip(e, 0, None)), "blend")
    clip.put("gesture", "head", "rotation_euler", f0, _rot(0.8 * amp * shift(e, 2), 0, 0), "blend")
    return clip


def shake_head(ctx, actor, t0, t1, params):
    """The front block wiggles side to side (a train's heavy nose rocks rather than turns), the body counters a little."""
    rig, vi = actor.rig, vinfo(actor.rig)
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    count = int(params.get("count", 2))
    amp = DEG((7 if vi.train else 15) * rig.energy)
    d = min(0.38 / rig.tempo, 0.88 * (n / FPS) / max(count, 1)) * FPS
    e = _count_env(n, m, ctx.settle, count, d, first=0.2, decay=0.18, alt=True)
    he = shift(e, 2)
    if vi.train:
        clip.put("gesture", "head", "rotation_euler", f0, _rot(0, amp * he, 0.25 * amp * he), "blend")
        clip.put("gesture", "body", "rotation_euler", f0, _rot(0, -0.2 * amp * e, 0), "blend")
    else:
        clip.put("gesture", "head", "rotation_euler", f0, _rot(0.04 * amp * np.abs(he), 0.2 * amp * he, amp * he), "blend")
        clip.put("gesture", "body", "rotation_euler", f0, _rot(0, 0.1 * amp * e, -0.2 * amp * e), "blend")
    return clip


def _jump(m, a, t_up, t_down, apex, stretch=0.16, crouch=0.14):
    """One jump from frame a that lifts the wheels: a crouch, a stretch on the take-off (t_up), the arc, a squashed landing (t_down), a settle.
    Returns (z, squash z, air), each 0 outside the jump."""
    sz = knots([(0, 0), (a, 0), (a + 0.75 * (t_up - a), -crouch), (t_up, -0.6 * crouch), (t_up + 2, stretch), (0.5 * (t_up + t_down), 0.04), (t_down, 0.03), (t_down + 2, -0.7 * crouch), (t_down + 6, 0.04), (t_down + 10, 0.0), (max(m - 1, t_down + 11), 0.0)], m)
    u = (np.arange(m) - t_up) / max(t_down - t_up, 1)
    air = np.where((u > 0) & (u < 1), np.sin(math.pi * np.clip(u, 0, 1)), 0.0)
    z = np.where((u > 0) & (u < 1), apex * 4 * u * (1 - u), 0.0)
    return z, sz, air


def react_surprised(ctx, actor, t0, t1, params):
    """A jump with the wheels off the ground, a stretch, the visors shoot up, the hoods snap open, an O mouth and a puff."""
    rig, vi = actor.rig, vinfo(actor.rig)
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    e = gesture_env(n, ctx.settle, rig.tempo, anti=0.2, over=0.1, hold_to=0.62)
    apex = rig.height * (0.04 if vi.train else 0.1 + 0.06 * rig.bounce) * rig.energy
    t_up = max(0.1 * n, 2)
    t_down = t_up + max(int((0.12 if vi.train else 0.3) / max(rig.tempo, 0.5) * FPS), 4)
    z, sz, air = _jump(m, 0, t_up, min(t_down, 0.62 * n + 2), apex, stretch=0.1 if vi.train else 0.18)
    clip.put("gesture", "root", "location", f0, _vec(m, z=z), "blend")
    clip.put("gesture", "squash", "scale", f0, np.column_stack([-0.5 * sz, -0.5 * sz, sz]), "blend")
    clip.put("gesture", "body", "rotation_euler", f0, _rot(-DEG(7 if not vi.train else 2.5) * e, 0, 0), "blend")
    clip.put("gesture", "head", "rotation_euler", f0, _rot(-DEG(6) * shift(e, 2), 0, 0), "blend")
    for w in vi.wheels:  # in the air the wheels hang a little lower on their springs
        clip.put("gesture", w, "location", f0, _vec(m, z=-0.25 * vi.R * shift(air, 1)), "blend")
    _brows(clip, rig, f0, 0.45 * shift(e, 2))  # a visor sits on its lamp: it lifts less than a creature's brow
    clip.lid(f0, 0.35 * knots([(0, 0), (0.06 * n, 1.0), (0.12 * n, 0.0), (m - 1, 0.0)], m))  # a squeeze before the hoods snap open
    _puff_pulse(clip, actor, f0, m, int(t_up), 1.1, 0.0)
    o = np.full(m, -1)
    o[int(0.18 * n) : int(0.7 * n)] = SLOT["O"]
    clip.mouth(f0, o)
    return clip


def laugh(ctx, actor, t0, t1, params):
    """The suspension shakes with the laugh, the front block tips back, the hoods squint, the mouth opens and closes."""
    rig, vi = actor.rig, vinfo(actor.rig)
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    e = gesture_env(n, ctx.settle, rig.tempo, anti=0.1, over=0.06, hold_to=0.86)
    t = np.arange(m) / FPS
    hz = (3.6 if vi.train else 5.4) * rig.tempo ** 0.5
    w = smoothstep((np.arange(m) - 0.15 * n) / 4) * smoothstep((0.92 * n - np.arange(m)) / 4)
    ha = np.sin(TAU * hz * (t - 0.15 * n / FPS)) * w
    k = 0.6 if vi.train else 1.0
    clip.put("gesture", "squash", "scale", f0, np.column_stack([-0.01 * k * ha, -0.01 * k * ha, 0.03 * k * ha]), "blend")
    clip.put("gesture", "body", "rotation_euler", f0, _rot(-DEG(4) * k * e + DEG(1.8) * k * ha, DEG(1.6) * k * shift(ha, 1), 0), "blend")
    clip.put("gesture", "head", "rotation_euler", f0, _rot(-DEG(8) * shift(e, 2) - DEG(2.5) * k * shift(ha, 1), 0, 0), "blend")
    clip.lid(f0, 0.62 * np.clip(e * 1.4, 0, 1))
    mouth = np.full(m, -1)
    on = (np.arange(m) > 0.14 * n) & (np.arange(m) < 0.94 * n)
    mouth[on] = np.where(ha[on] > -0.2, SLOT["A"], SLOT["E"])
    clip.mouth(f0, mouth)
    return clip


def droop(ctx, actor, t0, t1, params):
    """Sad: the body sags on its springs nose-down, the front block hangs, half hoods, the visors tilt, the antenna wilts, a frown."""
    rig = actor.rig
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    e = gesture_env(n, ctx.settle, rig.tempo * 0.75, anti=0.05, over=0.03, hold_to=0.8)
    clip.put("gesture", "body", "rotation_euler", f0, _rot(DEG(4) * e, 0, 0), "blend")
    clip.put("gesture", "head", "rotation_euler", f0, _rot(DEG(9) * shift(e, 2), 0, 0), "blend")
    clip.put("gesture", "squash", "scale", f0, _vec(m, z=-0.045 * e, x=0.02 * e, y=0.02 * e), "blend")
    if rig.has("antenna1"):
        clip.put("gesture", "antenna1", "rotation_euler", f0, _rot(DEG(28) * shift(e, 3), 0, 0), "blend")
    clip.lid(f0, 0.45 * np.clip(e, 0, 1))
    _brows(clip, rig, f0, -0.15 * shift(e, 2), -DEG(14) * shift(e, 2))
    fr = np.zeros(m, dtype=bool)
    fr[int(0.15 * n) : int(0.85 * n)] = True
    clip.mouth(f0, np.full(m, -1), fr)
    return clip


# ---------------------------------------------------------------- vehicle-only gestures


@action("bounce", bodies=VEH)
def bounce(ctx, actor, t0, t1, params):
    """Happy hops on the spot: each a crouch, the wheels leaving the ground, a squashed landing; the last one settles."""
    rig, vi = actor.rig, vinfo(actor.rig)
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    count = max(int(params.get("count", 2)), 1)
    apex = rig.height * (0.035 if vi.train else 0.06 + 0.08 * rig.bounce) * rig.energy
    hop = n / count
    z, sz, air = np.zeros(m), np.zeros(m), np.zeros(m)
    for h in range(count):
        a = h * hop
        zi, si, ai = _jump(m, a, a + 0.3 * hop, a + 0.72 * hop, apex * (1 - 0.15 * h), 0.12, 0.1)
        z, sz, air = z + zi, sz + si, np.maximum(air, ai)
    z[n:] = 0.0
    sz = sz * smoothstep((n + ctx.settle - np.arange(m)) / 4)
    clip.put("gesture", "root", "location", f0, _vec(m, z=z), "blend")
    clip.put("gesture", "squash", "scale", f0, np.column_stack([-0.5 * sz, -0.5 * sz, sz]), "blend")
    pitch = -DEG(3 * rig.energy) * (np.gradient(z) * FPS / max(apex * 4, 1e-3))
    clip.put("gesture", "body", "rotation_euler", f0, _rot(pitch, 0, 0), "blend")
    clip.put("gesture", "head", "rotation_euler", f0, _rot(-0.6 * (pitch - shift(pitch, 2)), 0, 0), "blend")
    for w in vi.wheels:
        clip.put("gesture", w, "location", f0, _vec(m, z=-0.2 * vi.R * shift(air, 1)), "blend")
    return clip


def _local_aim(ctx, actor, f, target):
    """(yaw, pitch) of a target seen from the vehicle's front block (yaw > 0 is to the vehicle's +x side)."""
    return _aim(ctx, actor, f, ctx.point(target, f))


@action("lean", bodies=VEH)
def lean(ctx, actor, t0, t1, params):
    """Leans toward a target on the suspension (a roll to its side, a pitch toward it if it is ahead); the front block turns a little to it."""
    rig, vi = actor.rig, vinfo(actor.rig)
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    yaw, _ = _local_aim(ctx, actor, f0, params["target"]) if params.get("target") is not None else (DEG(90), 0.0)
    amp = float(params.get("amp", 1.0)) * rig.energy * (0.4 if vi.train else 1.0)
    e = gesture_env(n, ctx.settle, rig.tempo, anti=0.15, over=0.08, hold_to=0.8)
    side, ahead = math.sin(yaw), math.cos(yaw)
    clip.put("gesture", "body", "rotation_euler", f0, _rot(DEG(3.5) * amp * ahead * e, DEG(6) * amp * side * e, 0), "blend")
    clip.put("gesture", "squash", "scale", f0, _vec(m, z=-0.015 * amp * e, x=0.007 * amp * e, y=0.007 * amp * e), "blend")
    hy = 0.0 if vi.train else float(np.clip(yaw, -DEG(18), DEG(18))) * 0.6
    clip.put("gesture", "head", "rotation_euler", f0, _rot(0, -DEG(2) * amp * side * shift(e, 2), hy * shift(e, 2)), "blend")
    return clip


@action("tilt", bodies=VEH)
def tilt(ctx, actor, t0, t1, params):
    """A quizzical roll of the front block (the vehicle's "think"): one visor up, the other hood half down, a slow moving hold."""
    rig = actor.rig
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    sx = -1.0 if params.get("side", "R") == "L" else 1.0
    e = gesture_env(n, ctx.settle, rig.tempo, anti=0.1, over=0.06, hold_to=0.84)
    he = shift(e, 2)
    clip.put("gesture", "head", "rotation_euler", f0, _rot(-DEG(3) * he, sx * DEG(11) * he, 0), "blend")
    clip.put("gesture", "body", "rotation_euler", f0, _rot(0, sx * DEG(2.5) * e, 0), "blend")
    up, down = ("R", "L") if sx > 0 else ("L", "R")
    if rig.has(f"brow_{up}"):
        clip.put("face", f"brow_{up}", "location", f0, _vec(m, z=0.35 * rig.eye_r * he), "add")
    if rig.has(f"brow_{down}"):
        clip.put("face", f"brow_{down}", "location", f0, _vec(m, z=-0.12 * rig.eye_r * he), "add")
    amt = 0.35 * np.clip(shift(e, 3), 0, 1)
    clip.lid(f0, amt if down == "L" else np.zeros(m), amt if down == "R" else np.zeros(m))
    return clip


@action("wiggle", bodies=VEH)
def wiggle(ctx, actor, t0, t1, params):
    """A happy rear wiggle (the vehicle's "cheer"): the body swings about its middle while the front block holds steady, the springs bounce."""
    rig, vi = actor.rig, vinfo(actor.rig)
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    e = gesture_env(n, ctx.settle, rig.tempo, anti=0.12, over=0.05, hold_to=0.82)
    t = np.arange(m) / FPS
    hz = (1.6 if vi.train else 3.0) * rig.tempo ** 0.5
    w = smoothstep((np.arange(m) - 0.15 * n) / 4) * smoothstep((0.85 * n - np.arange(m)) / 4)
    osc = np.sin(TAU * hz * (t - 0.15 * n / FPS)) * w
    amp = DEG((2 if vi.train else 7) * rig.energy)
    clip.put("gesture", "body", "rotation_euler", f0, _rot(-DEG(1.5) * e, 0.3 * amp * osc, amp * osc), "blend")
    clip.put("gesture", "head", "rotation_euler", f0, _rot(-DEG(3) * shift(e, 2), 0, -0.8 * amp * shift(osc, 2)), "blend")
    b = np.abs(osc)
    clip.put("gesture", "squash", "scale", f0, np.column_stack([-0.01 * b, -0.01 * b, 0.025 * b - 0.01 * np.clip(-e, 0, None)]), "blend")
    return clip


@action("rev", bodies=VEH)
def rev(ctx, actor, t0, t1, params):
    """Revving: the springs crouch, the body shivers harder with each rev, the rear squats, the exhaust (or chimney) pops a puff on each rev."""
    rig, vi = actor.rig, vinfo(actor.rig)
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    e = gesture_env(n, ctx.settle, rig.tempo, anti=0.05, over=0.05, hold_to=0.85)
    rng = ctx.rng("rev", actor.id, f0)
    jit = rng.normal(size=m) * smoothstep((np.arange(m) - 2) / 3) * smoothstep((n - np.arange(m)) / 3)
    revs = int(params.get("count", 2))
    pulse = np.zeros(m)
    src = "exhaust" if rig.has("exhaust") else _src(actor)
    for r in range(revs):
        f = int((0.15 + 0.6 * r / max(revs, 1)) * n)
        pulse += _pulse(m, f, 3, 8, 1.0, 0.25)
        _puff_pulse(clip, actor, f0, m, f + 2, 0.8, 0.0, src)
    sz = -0.03 * e - 0.012 * pulse
    clip.put("gesture", "squash", "scale", f0, np.column_stack([-0.5 * sz + 0.0035 * jit, -0.5 * sz, sz + 0.004 * jit]), "blend")
    clip.put("gesture", "body", "rotation_euler", f0, _rot(-DEG(2.5) * e - DEG(1.5) * pulse + DEG(0.35) * jit, DEG(0.3) * jit, 0), "blend")
    clip.put("gesture", "head", "rotation_euler", f0, _rot(DEG(1.2) * (pulse - shift(pulse, 2)), 0, 0), "blend")
    return clip


def _flash(m, frames, width=3):
    g = np.zeros(m)
    for f in frames:
        g = np.maximum(g, knots([(0, 0), (f, 0), (f + 1, 1.0), (f + 1 + width, 1.0), (f + 3 + width, 0.0)], m))
    return g


@action("honk", bodies=VEH)
def honk(ctx, actor, t0, t1, params):
    """Honk (a car; a train whistles): the front block squashes, then stretches forward with the horn, the lamps flash, the hoods squeeze then
    pop open. The horn sound is a separate sfx beat."""
    rig, vi = actor.rig, vinfo(actor.rig)
    if vi.train:
        return whistle(ctx, actor, t0, t1, params)
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    a_f = max(int(0.18 * n), 2)
    p_f = a_f + max(int(0.12 * n), 2)
    sq = knots([(0, 0), (a_f, -1.0), (p_f, 1.0), (p_f + 0.35 * n, 0.85), (0.85 * n, -0.15), (n + 0.5 * ctx.settle, 0.03), (n + ctx.settle - 2, 0.0), (m - 1, 0.0)], m)
    k = rig.energy
    clip.put("gesture", "head", "scale", f0, np.column_stack([-0.05 * k * sq, 0.12 * k * sq, 0.05 * k * sq]), "blend")
    clip.put("gesture", "head", "location", f0, _vec(m, y=-0.035 * k * rig.height * np.clip(sq, 0, None)), "blend")
    clip.put("gesture", "body", "rotation_euler", f0, _rot(DEG(2.5) * k * shift(sq, 1), 0, 0), "blend")
    clip.put("gesture", "squash", "scale", f0, np.column_stack([0.012 * k * sq, -0.02 * k * sq, -0.015 * k * np.abs(sq)]), "blend")
    if rig.has("horn"):
        hp = knots([(0, 0), (a_f, 0), (p_f, 1.0), (p_f + 0.4 * n, 0.8), (0.85 * n, 0.0), (m - 1, 0.0)], m)
        clip.put("gesture", "horn", "scale", f0, np.column_stack([0.35 * hp, 0.35 * hp, 0.35 * hp]), "blend")
    clip.lid(f0, 0.5 * knots([(0, 0), (a_f, 1.0), (p_f - 1, 0.0), (m - 1, 0.0)], m))
    clip.glow(f0, _flash(m, [p_f - 1, p_f + int(0.25 * n)], 2))
    return clip


@action("whistle", bodies=VEH)
def whistle(ctx, actor, t0, t1, params):
    """Whistle (a train; a car honks): the springs load, the chimney stretches tall and blows a big puff, the nose lifts, the hoods squeeze then open."""
    rig, vi = actor.rig, vinfo(actor.rig)
    if not vi.train and not rig.has("chimney"):
        return honk(ctx, actor, t0, t1, params)
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    e = gesture_env(n, ctx.settle, rig.tempo, anti=0.2, over=0.08, hold_to=0.75)
    k = rig.energy
    clip.put("gesture", "squash", "scale", f0, np.column_stack([-0.008 * k * e, -0.008 * k * e, 0.02 * k * e]), "blend")
    clip.put("gesture", "body", "rotation_euler", f0, _rot(-DEG(1.8) * k * e, 0, 0), "blend")
    clip.put("gesture", "head", "rotation_euler", f0, _rot(-DEG(3.5) * k * shift(e, 2), 0, 0), "blend")
    if rig.has("chimney"):
        ce = shift(e, 1)
        clip.put("gesture", "chimney", "scale", f0, np.column_stack([-0.12 * ce, -0.12 * ce, 0.38 * ce]), "blend")
        clip.puff(f0 + int(0.25 * n), "chimney", 1.5, 0.0)
        clip.puff(f0 + int(0.5 * n), "chimney", 1.1, 0.0)
    clip.lid(f0, 0.45 * knots([(0, 0), (0.12 * n, 1.0), (0.22 * n, 0.0), (m - 1, 0.0)], m))
    return clip


@action("puff", bodies=VEH)
def puff(ctx, actor, t0, t1, params):
    """Puffs of smoke from the chimney (a train) or the exhaust (a car), each with a little pop of the source and the springs."""
    rig = actor.rig
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    count = max(int(params.get("count", 1)), 1)
    src = params.get("source") or _src(actor)
    sq = np.zeros(m)
    for i in range(count):
        f = int((0.1 + 0.8 * i / count) * n)
        _puff_pulse(clip, actor, f0, m, f, float(params.get("size", 1.0)), 0.0, src)
        sq += _pulse(m, f, 2, 6, 1.0)
    clip.put("gesture", "squash", "scale", f0, np.column_stack([0.004 * sq, 0.004 * sq, -0.012 * sq]), "blend")
    return clip


@action("flash", bodies=VEH)
def flash(ctx, actor, t0, t1, params):
    """Both lamps flash `count` times, with a small squint of the hoods between flashes."""
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    count = max(int(params.get("count", 2)), 1)
    step = n / count
    fl = [int(i * step + 0.1 * step) for i in range(count)]
    w = max(int(0.35 * step) - 2, 1)
    clip.glow(f0, _flash(m, fl, w))
    sq = np.zeros(m)
    for f in fl:
        sq = np.maximum(sq, knots([(0, 0), (f + w + 1, 0), (f + w + 3, 1.0), (f + w + 5, 0.0), (m - 1, 0.0)], m))
    clip.lid(f0, 0.3 * sq)
    return clip


@action("wink", bodies=VEH)
def wink(ctx, actor, t0, t1, params):
    """One hood closes and opens (side L or R) while the front block rolls a little to that side."""
    rig = actor.rig
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    side = params.get("side", "R")
    if side not in ("L", "R"):
        side = "R"
    sx = 1.0 if side == "R" else -1.0
    amt = knots([(0, 0), (0.25 * n, 1.0), (0.65 * n, 1.0), (n, 0.0), (m - 1, 0.0)], m)
    clip.lid(f0, amt if side == "L" else np.zeros(m), amt if side == "R" else np.zeros(m))
    e = gesture_env(n, ctx.settle, rig.tempo, anti=0.1, over=0.08, hold_to=0.7)
    clip.put("gesture", "head", "rotation_euler", f0, _rot(-DEG(1.5) * e, -sx * DEG(5) * e, 0), "blend")
    return clip


@action("point_nose", bodies=VEH)
def point_nose(ctx, actor, t0, t1, params):
    """Aims the front at a target: the front block turns (a car) and pitches to it, the body lunges forward on its springs (the wheels stay put),
    the lamps flash at the peak."""
    rig, vi = actor.rig, vinfo(actor.rig)
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    yaw, pitch = _local_aim(ctx, actor, f0, params["target"])
    e = gesture_env(n, ctx.settle, rig.tempo, anti=0.2, over=0.1, hold_to=0.78)
    he = shift(e, 2)
    hy = 0.0 if vi.train else float(np.clip(yaw, -DEG(22), DEG(22)))
    by = 0.0 if vi.train else float(np.clip(yaw - hy, -DEG(8), DEG(8)))
    hp = float(np.clip(pitch, -DEG(12), DEG(10)))
    clip.put("gesture", "head", "rotation_euler", f0, _rot(hp * he, 0, hy * he), "blend")
    clip.put("gesture", "body", "rotation_euler", f0, _rot(DEG(3) * e, 0, by * e), "blend")
    clip.put("gesture", "squash", "scale", f0, np.column_stack([-0.01 * e, 0.04 * e, -0.02 * e]), "blend")
    lunge = 0.05 * rig.height * e
    c, s = math.cos(by), math.sin(by)
    clip.put("gesture", "body", "location", f0, _vec(m, x=lunge * s, y=-lunge * c), "blend")
    peak = int(np.argmax(e))
    clip.glow(f0, _flash(m, [peak], 3))
    return clip


@action("spin_wheels", bodies=VEH)
def spin_wheels(ctx, actor, t0, t1, params):
    """Wheelspin on the spot: the wheels whirl up and run down again, the rear squats and shivers, the exhaust or chimney puffs."""
    rig, vi = actor.rig, vinfo(actor.rig)
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    revs_s = float(params.get("revsPerSecond", 3.0 if not vi.train else 1.5))
    w = knots([(0, 0), (0.25 * n, 1.0), (0.75 * n, 1.0), (n, 0.0), (m - 1, 0.0)], m)
    ang = np.cumsum(w) * TAU * revs_s / FPS
    _spin_add(clip, actor, f0, ang)
    rng = ctx.rng("spin", actor.id, f0)
    jit = rng.normal(size=m) * w
    e = gesture_env(n, ctx.settle, rig.tempo, anti=0.05, over=0.05, hold_to=0.8)
    clip.put("gesture", "squash", "scale", f0, np.column_stack([0.006 * jit, np.zeros(m), -0.025 * e + 0.006 * jit]), "blend")
    clip.put("gesture", "body", "rotation_euler", f0, _rot(-DEG(3) * e + DEG(0.4) * jit, DEG(0.4) * jit, 0), "blend")
    src = "exhaust" if rig.has("exhaust") else _src(actor)
    for f in (int(0.2 * n), int(0.5 * n)):
        _puff_pulse(clip, actor, f0, m, f, 0.8, 0.0, src)
    clip.meta["spin"] = float(ang[-1])
    return clip


@action("park", bodies=VEH)
def park(ctx, actor, t0, t1, params):
    """Parks: the springs settle with a sigh, the engine stops (the idle shiver ends), the hoods come half down and the lamps go out; it holds
    until a `start_up`."""
    rig = actor.rig
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    e = knots([(0, 0), (0.2 * n, 0.3), (0.5 * n, 1.0), (0.7 * n, 0.85), (n, 0.0), (m - 1, 0.0)], m)
    clip.put("gesture", "squash", "scale", f0, np.column_stack([0.015 * e, 0.015 * e, -0.035 * e]), "blend")
    clip.put("gesture", "body", "rotation_euler", f0, _rot(DEG(1.5) * e, 0, 0), "blend")
    clip.put("gesture", "head", "rotation_euler", f0, _rot(DEG(3) * shift(e, 2), 0, 0), "blend")
    _set_park(actor, f0 + int(0.35 * n), max(int(0.6 * n), 2), 1.0)
    return clip


@action("start_up", bodies=VEH)
def start_up(ctx, actor, t0, t1, params):
    """Starts up: a cough and a shiver through the springs, the hoods open, the lamps come on with a flash, a puff."""
    rig = actor.rig
    f0, f1, n, m = _frames(ctx, t0, t1)
    clip = Clip(f0, f1)
    w = knots([(0, 0), (0.15 * n, 1.0), (0.6 * n, 0.5), (n, 0.0), (m - 1, 0.0)], m)
    t = np.arange(m) / FPS
    shiver = np.sin(TAU * 9.0 * t) * w
    cough = _pulse(m, int(0.12 * n), 2, 7, 1.0, 0.4)
    clip.put("gesture", "squash", "scale", f0, np.column_stack([-0.008 * shiver, np.zeros(m), 0.012 * shiver - 0.02 * cough]), "blend")
    clip.put("gesture", "body", "rotation_euler", f0, _rot(-DEG(2) * cough + DEG(0.6) * shiver, DEG(0.5) * shift(shiver, 1), 0), "blend")
    clip.put("gesture", "head", "rotation_euler", f0, _rot(-DEG(3) * shift(cough, 2), 0, 0), "blend")
    if float(park_level(actor)[min(f0, ctx.n - 1)]) > 0.01:
        _set_park(actor, f0 + int(0.25 * n), max(int(0.45 * n), 2), 0.0)
    else:  # not parked: the hoods blink awake
        clip.lid(f0, 0.5 * knots([(0, 0), (0.1 * n, 1.0), (0.45 * n, 0.0), (m - 1, 0.0)], m))
    clip.glow(f0, _flash(m, [int(0.5 * n)], 2))
    for src in ("chimney", "exhaust"):
        if rig.has(src):
            _puff_pulse(clip, actor, f0, m, int(0.14 * n), 0.9, 0.0, src)
            break
    return clip
