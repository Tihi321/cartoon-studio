# SPDX-License-Identifier: GPL-3.0-or-later
"""The acting library's shared pieces (HUB-30 decisions 3, 4 and 6): math, the layered channel store, the rig measurements and the context.

Pure Python + numpy: nothing here needs Blender, so the maths is easy to test. `compose.py` is where the channels meet bpy.

Conventions (the same as build_character.py): a character faces -y at yaw 0, z up, `_L` is -x. Euler angles are XYZ in radians; a vector pointing
from a pivot along (0, 0, -1) (an arm or leg hanging down) turned by (alpha about x, then beta about y) points along
d = (-cos a sin b, sin a, -cos a cos b); `euler_from_dir` is the inverse. Forward is -y, so a forward swing has a negative alpha.

Layers, per channel and frame (decision 4 and the plan's composition rule):
    value = rest + base + idle + gesture (blended in and out over 4 frames) + head (accents, plus `look`: the aim) + face + secondary
`base` holds states (position, yaw, a seated pose); a base action *sets* its channel from its start frame on and the value then holds. The others add.
"""
import math
import zlib

import numpy as np

FPS = 24
SETTLE_S = 0.4  # a gesture's keys end at most this long after its end time
BLEND_FRAMES = 4
LAYERS = ("base", "idle", "gesture", "head", "look", "face", "secondary")  # "look" belongs to the head layer: where the head and eyes are aimed
TAU = 2.0 * math.pi


# ---------------------------------------------------------------- easing and curves


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def smootherstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * x * (x * (x * 6.0 - 15.0) + 10.0)


def knots(points, n, ease=smoothstep):
    """A curve of n samples (frames 0..n-1) through (frame, value) knots, eased between them (velocity 0 at every knot: slow in, slow out)."""
    pts = sorted(points, key=lambda p: p[0])
    fr = np.array([p[0] for p in pts], dtype=float)
    val = np.array([p[1] for p in pts], dtype=float)
    x = np.arange(n, dtype=float)
    if len(fr) == 1:
        return np.full(n, val[0])
    idx = np.clip(np.searchsorted(fr, x, side="right") - 1, 0, len(fr) - 2)
    dt = np.maximum(fr[idx + 1] - fr[idx], 1e-6)
    u = ease((x - fr[idx]) / dt)
    out = val[idx] + (val[idx + 1] - val[idx]) * u
    out[x <= fr[0]] = val[0]
    out[x >= fr[-1]] = val[-1]
    return out


def window(n, a, b, ramp=4.0):
    """1 between frames a and b, ramping from 0 over `ramp` frames at both ends."""
    x = np.arange(n, dtype=float)
    return smoothstep((x - a) / max(ramp, 1e-6)) * smoothstep((b - x) / max(ramp, 1e-6))


def shift(arr, k):
    """The curve delayed by k frames (overlap: the head lags the body by 2, the arms by 1-3); the first value is held."""
    k = int(k)
    if k <= 0:
        return arr
    return np.concatenate([np.full((k,) + arr.shape[1:], arr[0]), arr[:-k]])


def gesture_env(T, settle, tempo=1.0, peak=1.0, anti=0.12, over=0.08, hold_to=0.7, fps=FPS):
    """The shape of a gesture from frame 0 (its start) to frame T + settle: anticipation (a dip against the direction), a rise that overshoots,
    a moving hold (a slow sway, never frozen), a return that overshoots the rest pose and settles. Eased between the knots. Ends exactly at 0."""
    ts = T / fps
    k = 1.0 / max(tempo, 0.2)
    t_a, t_p, t_s = 0.09 * k, 0.09 * k + 0.2 * k, 0.09 * k + 0.32 * k
    squeeze = min(1.0, 0.55 * ts / t_s) if t_s > 0 else 1.0
    t_a, t_p, t_s = t_a * squeeze, t_p * squeeze, t_s * squeeze
    t_r0 = max(t_s + 0.05, min(ts * hold_to, ts - 0.28 * k))
    n = int(T + settle + 1)
    pts = [(0, 0.0), (t_a * fps, -anti * peak), (t_p * fps, peak * (1 + over)), (t_s * fps, peak), (t_r0 * fps, peak), (max(t_r0 * fps + 2, T - 1), -0.06 * peak), (T + 0.4 * settle, 0.015 * peak), (T + settle - 3, 0.0), (T + settle, 0.0)]
    env = knots(pts, n)
    sway = 0.03 * peak * np.sin(TAU * 0.9 * (np.arange(n) - t_s * fps) / fps) * window(n, t_s * fps, t_r0 * fps, 5)
    env = env + sway
    env[-1] = 0.0
    return env


def damped(n, freq_hz, zeta, amp=1.0, fps=FPS, start=0):
    """A damped return, 1 -> 0 with overshoot (the settle after a pose): amp * e^(-zeta w t) cos(wd t) from frame `start`."""
    t = np.maximum(np.arange(n) - start, 0) / fps
    w = TAU * freq_hz
    wd = w * math.sqrt(max(1 - zeta * zeta, 1e-6))
    return amp * np.exp(-zeta * w * t) * (np.cos(wd * t) + zeta * w / wd * np.sin(wd * t))


# ---------------------------------------------------------------- rotations, directions, forward kinematics


def rot_matrix(rot):
    """Euler XYZ (radians) of shape (N, 3) -> (N, 3, 3) matrices (x first, z last)."""
    rot = np.asarray(rot, dtype=float).reshape(-1, 3)
    cx, cy, cz = np.cos(rot[:, 0]), np.cos(rot[:, 1]), np.cos(rot[:, 2])
    sx, sy, sz = np.sin(rot[:, 0]), np.sin(rot[:, 1]), np.sin(rot[:, 2])
    m = np.empty((len(rot), 3, 3))
    m[:, 0, 0] = cy * cz
    m[:, 0, 1] = sx * sy * cz - cx * sz
    m[:, 0, 2] = cx * sy * cz + sx * sz
    m[:, 1, 0] = cy * sz
    m[:, 1, 1] = sx * sy * sz + cx * cz
    m[:, 1, 2] = cx * sy * sz - sx * cz
    m[:, 2, 0] = -sy
    m[:, 2, 1] = sx * cy
    m[:, 2, 2] = cx * cy
    return m


def local_matrix(loc, rot, scale):
    loc = np.asarray(loc, dtype=float).reshape(-1, 3)
    n = len(loc)
    m = np.zeros((n, 4, 4))
    m[:, :3, :3] = rot_matrix(rot) * np.asarray(scale, dtype=float).reshape(-1, 1, 3)
    m[:, :3, 3] = loc
    m[:, 3, 3] = 1.0
    return m


def dir_from_euler(a, b):
    return np.stack([-np.cos(a) * np.sin(b), np.sin(a), -np.cos(a) * np.cos(b)], axis=-1)


def euler_from_dir(d, ref_beta=None):
    """(alpha, beta) of a direction (N, 3): the inverse of dir_from_euler. beta is unwrapped along the series so it never jumps by 2 pi."""
    d = np.asarray(d, dtype=float).reshape(-1, 3)
    d = d / np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)
    a = np.arcsin(np.clip(d[:, 1], -1, 1))
    b = np.arctan2(-d[:, 0], -d[:, 2])
    near_pole = np.cos(a) < 1e-4
    if near_pole.any():  # straight forward or back: beta is free, keep the last good one
        for i in range(len(b)):
            if near_pole[i]:
                b[i] = b[i - 1] if i > 0 else (ref_beta if ref_beta is not None else 0.0)
    if ref_beta is not None:
        b = np.unwrap(np.concatenate([[ref_beta], b]))[1:]
    else:
        b = np.unwrap(b)
    return a, b


def sphere_dir(el, az, side):
    """An arm direction from elevation (0 hanging, 90 level, 180 up) and azimuth (0 outward, 90 forward), side +1 for _R and -1 for _L (radians)."""
    el, az = np.asarray(el, dtype=float), np.asarray(az, dtype=float)
    return np.stack([side * np.sin(el) * np.cos(az), -np.sin(el) * np.sin(az), -np.cos(el)], axis=-1)


def yaw_matrix(yaw):
    c, s = np.cos(yaw), np.sin(yaw)
    m = np.zeros((len(np.atleast_1d(yaw)), 3, 3))
    m[:, 0, 0], m[:, 0, 1], m[:, 1, 0], m[:, 1, 1], m[:, 2, 2] = c, -s, s, c, 1.0
    return m


def wrap_pi(a):
    return (a + math.pi) % TAU - math.pi


# ---------------------------------------------------------------- the rig, measured from the spec


def _zrange(p):
    """(lowest, highest) z of a part in its control's space."""
    s, z = p["size"], p["at"][2]
    sh = p["shape"]
    if sh == "capsule":
        half = s[1] / 2
    elif sh == "cone":
        half = s[1] / 2
    elif sh == "box":
        half = s[2] / 2
    elif sh == "torus":
        half = s[1]
    elif sh == "arc":
        half = s[0]
    elif sh == "cylinder":  # HUB-31: [r] (length 2r), [r, length] or [rx, ry, length], along z
        half = (s[1] if len(s) == 2 else s[2] if len(s) > 2 else 2 * s[0]) / 2
    else:
        half = s[2] if len(s) > 2 else s[0]
    return z - half, z + half


def chain_stem(name):
    """`ear_L2` -> ('ear_L', 2); a control that is not a numbered chain joint gives (None, 0)."""
    i = len(name)
    while i > 0 and name[i - 1].isdigit():
        i -= 1
    if i == len(name) or i == 0:
        return None, 0
    return name[:i], int(name[i:])


class Rig:
    """What the library needs to know about a character, read from `character.json` (cts.character3d/1)."""

    def __init__(self, spec):
        self.spec = spec
        self.id = spec["id"]
        self.controls = spec["controls"]
        m = spec["motion"]
        self.tempo, self.energy, self.bounce = float(m["tempo"]), float(m["energy"]), float(m["bounce"])
        self.walk = m.get("walk")  # a vehicle has `drive` instead (HUB-31)
        self.kind = spec.get("kind", "creature")
        self.parts = list(spec["parts"]) + list(spec.get("accessories") or [])
        self.order = self._order()
        self.rest_loc = {n: np.array(c["at"], dtype=float) for n, c in self.controls.items()}
        self.rest_rot = {n: np.radians(np.array(c.get("rot", (0, 0, 0)), dtype=float)) for n, c in self.controls.items()}
        self._world = {}
        self.legs = self.has("leg_L") and self.has("leg_R")
        self.hip = {s: self.world_rest(f"leg_{s}")[:3, 3] for s in "LR"} if self.legs else {}
        self.leg_len = max(self.hip["L"][2], 0.05) if self.legs else 0.0
        self.height = float(spec["height"])
        self.head_z = float(self.world_rest("head")[2, 3])
        self.eye_r = float(spec["face"]["eyes"]["r"])
        self.body_c, self.body_r = self._body_ellipsoid()
        self.shoulder = {}
        self.arm_len = {}
        self.arm_rad = {}
        for s in "LR":
            n = f"arm_{s}"
            if self.has(n):
                self.shoulder[s] = (np.linalg.inv(self.world_rest("body")) @ np.append(self.world_rest(n)[:3, 3], 1.0))[:3]
                mine = [p for p in self.parts if p["control"] == n]
                low = min((_zrange(p)[0] for p in mine), default=-0.2)
                self.arm_len[s] = max(-low, 0.05)
                self.arm_rad[s] = max((min(p["size"][0], p["size"][1]) for p in mine if p["shape"] in ("ellipsoid", "capsule")), default=0.03)
        self.chains = self._chains()
        self.seat_drop = self._seat_drop()

    def has(self, name):
        return name in self.controls

    def rest_rot_matrix(self, name):
        return rot_matrix(self.rest_rot[name].reshape(1, 3))[0]

    def _order(self):
        out, seen = [], set()

        def visit(n):
            if n in seen:
                return
            p = self.controls[n]["parent"]
            if p:
                visit(p)
            seen.add(n)
            out.append(n)

        for n in sorted(self.controls):
            visit(n)
        return out

    def world_rest(self, name):
        if name not in self._world:
            c = self.controls[name]
            m = local_matrix(self.rest_loc[name], self.rest_rot[name], (1, 1, 1))[0]
            self._world[name] = (self.world_rest(c["parent"]) @ m) if c["parent"] else m
        return self._world[name]

    def _body_ellipsoid(self):
        best, vol = None, -1.0
        for p in self.parts:
            if p["control"] == "body" and p["shape"] in ("ellipsoid", "spines"):
                r = np.array(p["size"], dtype=float)
                v = float(np.prod(r))
                if v > vol:
                    best, vol = p, v
        if best is None:
            return np.array([0.0, 0.0, 0.0]), np.array([0.1, 0.1, 0.1])
        r = np.array(best["size"], dtype=float)
        return np.array(best["at"], dtype=float), (r if len(r) == 3 else np.full(3, r[0]))

    def _chains(self):
        stems = {}
        for n in self.controls:
            stem, i = chain_stem(n)
            if stem and not n.startswith("lid_") and not n.startswith("pupil_") and not n.startswith("wheel_"):
                stems.setdefault(stem, []).append((i, n))
        return {s: [n for _, n in sorted(v)] for s, v in stems.items()}

    def _seat_drop(self):
        """How far the body's lowest point is above the root's ground point at rest (the root is lowered by this less the seat height to sit)."""
        c, r = self.body_c, self.body_r
        z = self.world_rest("body")[2, 3] + c[2] - r[2]
        return float(z)

    def spring(self, stem):
        s = (self.spec.get("springs") or {}).get(stem)
        if s:
            return float(s["stiffness"]), float(s["damping"])
        return (60.0, 6.0) if stem.startswith("ear") else (45.0, 5.0)


def nominal_walk_speed(rig, style=None):
    """Metres a second at the character's usual pace (stride x cadence x tempo); the timeline uses it to give a walk its duration."""
    w = rig.walk
    k = {"walk": 1.0, "waddle": 1.0, "hop": 1.0, "run": 2.2, "tiptoe": 0.6}.get(style or w["style"], 1.0)
    return float(w["stride"] * w["cadence"] * rig.tempo * k)


# ---------------------------------------------------------------- channels, layers, clips


class Mix:
    """The channels of one actor: rest + layers. A channel is (control, prop), prop `location` | `rotation_euler` | `scale`, values (N, 3)."""

    def __init__(self, n, rig):
        self.n, self.rig = n, rig
        self.layers = {k: {} for k in LAYERS}
        self.lid = {s: np.zeros(n) for s in "LR"}  # 0 open ... 1 closed (face layer, absolute)
        self.mouth = np.zeros(n, dtype=int)  # index into SLOTS, 0 = rest
        self.mouth_set = np.zeros(n, dtype=bool)
        self.frown = np.zeros(n, dtype=bool)
        self.glow = np.zeros(n)  # vehicles: added to the lamp glow (`lamp_glow`, 0..1 after the rest value), HUB-31
        self.puffs = []  # vehicles: puff events {f, source, size, drift} for the puff pool, HUB-31

    def rest(self, ctl, prop):
        r = self.rig
        if prop == "location":
            return r.rest_loc[ctl]
        if prop == "rotation_euler":
            return r.rest_rot[ctl]
        return np.ones(3)

    def arr(self, layer, ctl, prop):
        d = self.layers[layer]
        key = (ctl, prop)
        if key not in d:
            d[key] = np.zeros((self.n, 3))
        return d[key]

    def delta(self, ctl, prop, layers=LAYERS):
        out = np.zeros((self.n, 3))
        for k in layers:
            a = self.layers[k].get((ctl, prop))
            if a is not None:
                out += a
        return out

    def value(self, ctl, prop, layers=LAYERS):
        return self.mesh_rest(ctl, prop) + self.delta(ctl, prop, layers)

    def mesh_rest(self, ctl, prop):
        return np.broadcast_to(self.rest(ctl, prop), (self.n, 3))

    def at(self, ctl, prop, f, layers=LAYERS):
        f = int(min(max(f, 0), self.n - 1))
        out = np.array(self.rest(ctl, prop), dtype=float)
        for k in layers:
            a = self.layers[k].get((ctl, prop))
            if a is not None:
                out = out + a[f]
        return out

    def delta_at(self, ctl, prop, f, layers=("base",)):
        f = int(min(max(f, 0), self.n - 1))
        out = np.zeros(3)
        for k in layers:
            a = self.layers[k].get((ctl, prop))
            if a is not None:
                out = out + a[f]
        return out

    def has_control(self, ctl):
        return self.rig.has(ctl)

    def add(self, layer, ctl, prop, f0, vals, weight=None):
        if not self.rig.has(ctl):
            return
        vals = np.asarray(vals, dtype=float).reshape(len(vals), -1)
        if vals.shape[1] == 1:
            vals = np.repeat(vals, 3, axis=1)
        f0 = int(f0)
        a, b = max(f0, 0), min(f0 + len(vals), self.n)
        if b <= a:
            return
        v = vals[a - f0 : b - f0]
        if weight is not None:
            v = v * weight[a - f0 : b - f0, None]
        self.arr(layer, ctl, prop)[a:b] += v

    def hold(self, layer, ctl, prop, f0, vals):
        """Sets the channel from f0 on: the given values, then the last one held to the end (a state)."""
        if not self.rig.has(ctl):
            return
        vals = np.asarray(vals, dtype=float).reshape(len(vals), -1)
        if vals.shape[1] == 1:
            vals = np.repeat(vals, 3, axis=1)
        f0 = int(f0)
        a = self.arr(layer, ctl, prop)
        b = min(f0 + len(vals), self.n)
        if b > f0 >= 0:
            a[f0:b] = vals[: b - f0]
            if b < self.n:
                a[b:] = vals[b - f0 - 1]

    def touched(self):
        s = set()
        for d in self.layers.values():
            s.update(k[0] for k in d)
        return s

    def world(self, names, layers=LAYERS):
        """World matrices (N, 4, 4) of the controls, from the composed channels."""
        cache = {}

        def go(n):
            if n in cache:
                return cache[n]
            m = local_matrix(self.value(n, "location", layers), self.value(n, "rotation_euler", layers), self.value(n, "scale", layers))
            p = self.rig.controls[n]["parent"]
            cache[n] = (go(p) @ m) if p else m
            return cache[n]

        return {n: go(n) for n in names}


class Clip:
    """What an action returns: contributions to the layers of one actor. `kind` of an item: 'add', 'blend' (add with the 4 frame weight in and out),
    'hold' (set and hold), 'lid' (max of the closed amount), 'mouth' (viseme indices, -1 = no opinion), 'camera' (see camera.py)."""

    def __init__(self, f0, f1):
        self.f0, self.f1 = int(f0), int(f1)
        self.items = []
        self.meta = {}

    def put(self, layer, ctl, prop, f0, vals, kind="add"):
        vals = np.asarray(vals, dtype=float)
        if len(vals) == 0:
            return self
        self.items.append((layer, ctl, prop, int(f0), vals, kind))
        return self

    def lid(self, f0, amount_L, amount_R=None):
        self.items.append(("face", "lid", "L", int(f0), np.asarray(amount_L, dtype=float), "lid"))
        self.items.append(("face", "lid", "R", int(f0), np.asarray(amount_L if amount_R is None else amount_R, dtype=float), "lid"))
        return self

    def mouth(self, f0, idx, frown=None):
        self.items.append(("face", "mouth", "slot", int(f0), np.asarray(idx, dtype=int), "mouth"))
        if frown is not None:
            self.items.append(("face", "mouth", "frown", int(f0), np.asarray(frown, dtype=bool), "frown"))
        return self

    def glow(self, f0, vals):
        """Adds to the lamp glow of a vehicle (a flash is +1, lamps off is -1)."""
        self.items.append(("face", "lamp", "glow", int(f0), np.asarray(vals, dtype=float), "glow"))
        return self

    def puff(self, f, source, size=1.0, drift=0.0):
        """A puff of smoke from `source` (chimney or exhaust) at frame f; drift is the vehicle's speed (m/s), so the puff stays behind."""
        self.items.append(("face", "puff", source, int(f), np.array([size, drift], dtype=float), "puff"))
        return self

    def span(self):
        """(first frame, last frame) of every key in the clip (a puff counts as its start frame)."""
        lo = min((it[3] for it in self.items), default=self.f0)
        hi = max((it[3] + (len(it[4]) - 1 if it[5] != "puff" else 0) for it in self.items), default=self.f1)
        return lo, hi

    def apply(self, mix):
        for layer, ctl, prop, f0, vals, kind in self.items:
            if kind == "add":
                mix.add(layer, ctl, prop, f0, vals)
            elif kind == "blend":
                n = len(vals)
                i = np.arange(n)
                w = smoothstep(np.minimum(np.minimum(i + 1, n - i), BLEND_FRAMES) / BLEND_FRAMES)
                mix.add(layer, ctl, prop, f0, vals, weight=w)
            elif kind == "hold":
                mix.hold(layer, ctl, prop, f0, vals)
            elif kind == "lid":
                a, b = max(f0, 0), min(f0 + len(vals), mix.n)
                if b > a:
                    mix.lid[prop][a:b] = np.maximum(mix.lid[prop][a:b], vals[a - f0 : b - f0])
            elif kind == "mouth":
                a, b = max(f0, 0), min(f0 + len(vals), mix.n)
                if b > a:
                    v = vals[a - f0 : b - f0]
                    ok = v >= 0
                    mix.mouth[a:b][ok] = v[ok]
                    mix.mouth_set[a:b] |= ok
            elif kind == "frown":
                a, b = max(f0, 0), min(f0 + len(vals), mix.n)
                if b > a:
                    mix.frown[a:b] |= vals[a - f0 : b - f0]
            elif kind == "glow":
                a, b = max(f0, 0), min(f0 + len(vals), mix.n)
                if b > a:
                    mix.glow[a:b] += vals[a - f0 : b - f0]
            elif kind == "puff":
                if 0 <= f0 < mix.n:
                    mix.puffs.append({"f": f0, "source": prop, "size": float(vals[0]), "drift": float(vals[1])})


# ---------------------------------------------------------------- actors and the context


class Actor:
    def __init__(self, ctx, aid, spec, start):
        self.ctx, self.id, self.rig = ctx, aid, Rig(spec)
        self.mix = Mix(ctx.n, self.rig)
        x, y = start["xy"]
        yaw = math.radians(start.get("yaw", 0.0))
        z = float(start.get("z", 0.0))  # a vehicle stands on the road top or the rail top (HUB-31); a creature on the ground
        self.mix.hold("base", "root", "location", 0, np.array([[x, y, z]] * ctx.n))
        self.mix.hold("base", "root", "rotation_euler", 0, np.array([[0.0, 0.0, yaw]] * ctx.n))
        from .limbs import arm_delta, hang_dir

        for side in "LR":  # the standing pose: arms hang just clear of the body (the spec's rest pose may have them inside it)
            if self.rig.has(f"arm_{side}"):
                d = arm_delta(self.rig, self.mix, side, hang_dir(self.rig, side).reshape(1, 3), 0)
                self.mix.hold("base", f"arm_{side}", "rotation_euler", 0, np.tile(d, (ctx.n, 1)))
        self.clips = []
        self.moving = np.zeros(ctx.n)  # 0..1: how much the actor is walking, hopping or running (idle fades out under it)
        self.seated = np.zeros(ctx.n, dtype=bool)
        self.leg_driven = np.zeros(ctx.n, dtype=bool)  # legs solved by a gait: idle and gestures must not move the hips

    def root(self, f):
        loc = self.mix.at("root", "location", f, ("base",))
        rot = self.mix.at("root", "rotation_euler", f, ("base",))
        return float(loc[0]), float(loc[1]), float(loc[2]), float(rot[2])

    def head_point(self, f):
        x, y, z, _ = self.root(f)
        return np.array([x, y, z + self.rig.head_z])


class Ctx:
    def __init__(self, n, seed=1, points=None, shots=None, fps=FPS):
        self.n, self.fps, self.seed = int(n), fps, int(seed)
        self.points = {k: np.array(v, dtype=float) for k, v in (points or {}).items()}
        self.seats = {}
        self.shots = shots or {}
        self.actors = {}
        self.settle = int(round(SETTLE_S * fps))
        self.camera = None
        self.surface = None  # vehicles (HUB-31): fn(xy (m, 2)) -> the height a car's wheels run on there (the assembler sets it; None = flat)

    def f(self, t):
        return int(round(t * self.fps))

    def rng(self, *key):
        h = zlib.crc32(repr((self.seed,) + tuple(key)).encode("utf-8"))
        return np.random.default_rng(h)

    def add_actor(self, aid, spec, start):
        a = Actor(self, aid, spec, start)
        self.actors[aid] = a
        return a

    def point(self, name, f=0):
        """The world point a name stands for: an actor's head, a seat, a mark, a prop's aim point, or an explicit [x, y, z]."""
        if isinstance(name, (list, tuple, np.ndarray)):
            p = np.array(name, dtype=float)
            return p if len(p) == 3 else np.array([p[0], p[1], 0.0])
        if name in self.actors:
            return self.actors[name].head_point(f)
        if name in self.points:
            return self.points[name]
        raise KeyError(f"unknown target {name!r}")

    def ground(self, name, f=0):
        p = self.point(name, f)
        return np.array([p[0], p[1]])
