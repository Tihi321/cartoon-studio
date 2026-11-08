# SPDX-License-Identifier: GPL-3.0-or-later
"""Camera actions: cut, pan, push, follow, shake_small, and the computed shots (wide, two, cu-<id>).

The camera is a state (location, target, lens) per frame; the writer turns it into a location and a look-at rotation. A shot is
{"loc": [x, y, z], "target": [x, y, z], "lens": mm}: a name in `ctx.shots`, a computed shot name, or such a dict.
"""
import numpy as np

from . import action
from .core import FPS, TAU, Clip, smoothstep, window

CAM = "camera"


def computed_shot(ctx, name, f=0):
    """The four computed shots from the actors' positions at frame f: `wide`, `two` (a, b: `two:a:b` or the first two), `cu-<id>`, `ots-<a>-<b>`."""
    ids = list(ctx.actors)
    heads = {i: ctx.actors[i].head_point(f) for i in ids}
    if name == "wide":
        pts = np.array([ctx.actors[i].head_point(f) for i in ids])
        c = pts.mean(axis=0)
        spread = float(np.ptp(pts[:, 0])) if len(pts) > 1 else 0.0
        return {"loc": [c[0], c[1] - (5.5 + 0.4 * spread), 1.6], "target": [c[0], c[1], 0.55], "lens": 32.0}
    if name.startswith("cu-"):
        h = heads[name[3:]]
        return {"loc": [h[0], h[1] - 1.5, h[2] + 0.06], "target": [h[0], h[1], h[2] - 0.02], "lens": 50.0}
    if name.startswith("ots-"):
        a, b = name[4:].split("-")[:2]
        ha, hb = heads[a], heads[b]
        d = (ha - hb)[:2]
        d = d / max(np.linalg.norm(d), 1e-6)
        return {"loc": [ha[0] + d[0] * 0.9, ha[1] + d[1] * 0.9 - 0.4, ha[2] + 0.25], "target": [hb[0], hb[1], hb[2] - 0.05], "lens": 45.0}
    parts = name.split(":")
    pair = parts[1:3] if name.startswith("two:") else ids[:2]
    pts = np.array([heads[i] for i in pair])
    c = pts.mean(axis=0)
    sep = float(np.linalg.norm(pts[0, :2] - pts[-1, :2]))
    return {"loc": [c[0], c[1] - (3.6 + 1.1 * sep), c[2] + 0.45], "target": [c[0], c[1], c[2] - 0.12], "lens": 35.0}


def resolve_shot(ctx, shot, f):
    if isinstance(shot, dict):
        return shot
    if shot in ctx.shots:
        return ctx.shots[shot]
    return computed_shot(ctx, shot, f)


def vec7(shot):
    return np.array(list(shot["loc"]) + list(shot["target"]) + [float(shot.get("lens", 35))], dtype=float)


class CameraTrack:
    """The camera state (n, 7) and an additive shake (n, 7)."""

    def __init__(self, n):
        self.n = n
        self.state = np.tile(np.array([0, -6, 1.5, 0, 0, 0.6, 35.0]), (n, 1))
        self.shake = np.zeros((n, 7))
        self.used = False

    def at(self, f):
        return self.state[int(min(max(f, 0), self.n - 1))]

    def apply(self, clip):
        for _layer, _ctl, prop, f0, vals, kind in clip.items:
            a, b = max(f0, 0), min(f0 + len(vals), self.n)
            if b <= a:
                continue
            if kind == "camhold":
                self.state[a:b] = vals[a - f0 : b - f0]
                if b < self.n and b == f0 + len(vals):
                    self.state[b:] = vals[-1]
            elif kind == "camadd":
                self.shake[a:b] += vals[a - f0 : b - f0]
            self.used = True

    def total(self):
        return self.state + self.shake


def _clip(f0, f1, f_from, vals, kind="camhold"):
    c = Clip(f0, f1)
    c.items.append(("camera", CAM, "state", int(f_from), np.asarray(vals, dtype=float), kind))
    return c


def _cam(ctx):
    return ctx.camera


@action("cut")
def cut(ctx, actor, t0, t1, params):
    f0 = ctx.f(t0)
    shot = vec7(resolve_shot(ctx, params["shot"], f0))
    return _clip(f0, f0, f0, shot[None, :])


@action("pan")
def pan(ctx, actor, t0, t1, params):
    f0, f1 = ctx.f(t0), ctx.f(t1)
    a = _cam(ctx).at(f0).copy()
    b = vec7(resolve_shot(ctx, params["shot"], f1))
    e = smoothstep((np.arange(f1 - f0 + 1)) / max(f1 - f0, 1))[:, None]
    return _clip(f0, f1, f0, a[None, :] + (b - a)[None, :] * e)


@action("push")
def push(ctx, actor, t0, t1, params):
    """A slow dolly-in: the camera moves toward its target (by `amount` of the distance, or to the shot `to`)."""
    f0, f1 = ctx.f(t0), ctx.f(t1)
    a = _cam(ctx).at(f0).copy()
    if "shot" in params:
        b = vec7(resolve_shot(ctx, params["shot"], f1))
    else:
        loc, tgt = a[:3], a[3:6]
        b = a.copy()
        b[:3] = loc + (tgt - loc) * float(params.get("amount", 0.35))
    e = smoothstep((np.arange(f1 - f0 + 1)) / max(f1 - f0, 1))[:, None]
    return _clip(f0, f1, f0, a[None, :] + (b - a)[None, :] * (0.15 * np.arange(f1 - f0 + 1)[:, None] / max(f1 - f0, 1) + 0.85 * e))


@action("follow")
def follow(ctx, actor, t0, t1, params):
    """Keeps a walking actor framed: the camera trucks along behind the actor (a lagging filter), then holds."""
    f0, f1 = ctx.f(t0), ctx.f(t1)
    a = _cam(ctx).at(f0).copy()
    n = f1 - f0 + 1
    who = params["target"]
    p0 = ctx.point(who, f0)
    out = np.tile(a, (n, 1))
    cur = p0[:2].copy()
    for i in range(n):
        p = ctx.point(who, f0 + i)
        cur = cur + (p[:2] - cur) * 0.12
        out[i, 0] = a[0] + (cur[0] - p0[0])
        out[i, 1] = a[1] + (cur[1] - p0[1])
        out[i, 3] = a[3] + (cur[0] - p0[0])
        out[i, 4] = a[4] + (cur[1] - p0[1])
    return _clip(f0, f1, f0, out)


@action("shake_small")
def shake_small(ctx, actor, t0, t1, params):
    f0, f1 = ctx.f(t0), ctx.f(t1) + ctx.settle // 2
    n = f1 - f0 + 1
    rng = ctx.rng("shake", f0)
    amp = float(params.get("amount", 0.014))
    decay = np.exp(-3.0 * np.arange(n) / max(n, 1)) * window(n, 0, n - 1, 2)
    t = np.arange(n) / FPS
    out = np.zeros((n, 7))
    for k in range(3):
        out[:, k] = amp * np.sin(TAU * (7 + 2 * k) * t + rng.uniform(0, TAU)) * decay
    out[:, 5] = amp * 0.5 * np.sin(TAU * 9 * t + rng.uniform(0, TAU)) * decay
    return _clip(f0, f1, f0, out, "camadd")
