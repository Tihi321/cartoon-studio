# SPDX-License-Identifier: GPL-3.0-or-later
"""Automatic framing of the computed shots (HUB-30 decision 10): `wide`, `two`, `cu-<id>`, `ots-<a>-<b>`.

The assembler asks for a shot at the frames it is on screen, `[f0, f1]`, so the frame holds everybody for as long as the camera stays: a walk across the
set does not leave the frame. The rules, in numbers:
- the camera looks along +y with a small tilt; the lens is a 36 mm sensor (`sensor_fit` AUTO, so the width), the visible width at distance d is 2 d 18 / lens;
- `wide`: the group fills 70 % of the width, never less than 3.8 m visible, the group's middle sits at 42 % of the height, never with the feet nearer than 13 % to the bottom edge or the tallest head nearer than 13 % to the top (a seated actor counts at its seat height);
- `two`: the pair fills 62 % of the width, never less than 2.6 m visible, the pair's middle sits at 45 % of the height with the feet in frame;
- `cu-<id>`: head and shoulders, the visible height 0.8 of the character's height (plus how far it rises or sinks while the shot lasts), the top of the character at 90 % of the height and the speaker on a third (turned toward the open side);
- `ots-<a>-<b>`: behind a, a's shoulder at the frame edge, b on the opposite third.
A named camera of the set (`ctx.shots`) wins over a computed one of the same name.

Vehicles (HUB-31 CTS-35): a car or a train is long, its root is the middle of the body and its face is the front block (`head`), not on top.
When a shot holds a vehicle, the group's width is the ground extent of each body (its rest box, `rig.box`, turned with its yaw), so a 4.4 m
engine is framed whole; `cu-<vehicle>` frames the face (the lamp eyes and the bumper mouth) from in front of it, turned a little toward the
-y side (a three-quarter view), never from the side or behind; `ots-<a>-<b>` with a vehicle `a` stands beside a's face, not inside its body.
A shot of creatures only is computed as before (pilot 3 re-renders unchanged).
"""
import math

import numpy as np

from .camera import vec7

SENSOR = 36.0


def vis_width(lens, d):
    return 2.0 * d * (SENSOR / 2.0) / lens


def dist_for_width(lens, w):
    return w * lens / SENSOR


def _track(ctx, ids, f0, f1):
    """(x, y, z) of the actors' roots over the frames [f0, f1], every 2nd frame: arrays (k, 3) per actor."""
    frames = list(range(max(f0, 0), min(max(f1, f0), ctx.n - 1) + 1, 2)) or [max(f0, 0)]
    return {i: np.array([ctx.actors[i].root(f)[:3] for f in frames]) for i in ids}


def _lateral(yaw):
    """The actor's facing as a unit vector on the ground."""
    return np.array([math.sin(yaw), -math.cos(yaw)])


# ---------------------------------------------------------------- vehicles (HUB-31)


def _is_vehicle(actor):
    return getattr(actor.rig, "kind", "creature") == "vehicle"


def _box(actor):
    """(lo, hi) of the body at rest in the root's frame: `rig.box` (set by the assembler from the built meshes), else from the spec's height and
    wheel positions."""
    box = getattr(actor.rig, "box", None)
    if box is not None:
        return np.asarray(box[0], dtype=float), np.asarray(box[1], dtype=float)
    rig = actor.rig
    pts = [rig.world_rest(n)[:3, 3] for n in rig.controls]
    ys = [p[1] for p in pts] or [0.0]
    xs = [p[0] for p in pts] or [0.0]
    r = 0.3
    return np.array([min(xs) - r, min(ys) - r, 0.0]), np.array([max(xs) + r, max(ys) + r, rig.height])


def _corners(actor, f):
    """The four ground corners (x, y) of a vehicle's body at frame f."""
    x, y, _z, yaw = actor.root(f)
    lo, hi = _box(actor)
    c, s = math.cos(yaw), math.sin(yaw)
    return [(x + c * px - s * py, y + s * px + c * py) for px in (lo[0], hi[0]) for py in (lo[1], hi[1])]


def _face(actor, f):
    """The world point of a vehicle's face (the `head` control at rest, turned with the root) and the facing as a unit vector."""
    x, y, z, yaw = actor.root(f)
    h = actor.rig.world_rest("head")[:3, 3]
    c, s = math.cos(yaw), math.sin(yaw)
    return np.array([x + c * h[0] - s * h[1], y + s * h[0] + c * h[1], z + h[2]]), _lateral(yaw)


def _group_x(ctx, ids, tr, frames, ymid, lens, frac, floor):
    """(x min, x max) of a group over the frames as the camera will see it: a vehicle by the corners of its body, a creature 0.4 of the tallest
    height either side of its root; a corner nearer the camera than the group's middle counts wider (the perspective), so a long engine
    pointing at the camera is not cut by the frame edge."""
    half = max(ctx.actors[i].rig.height for i in ids) * 0.4
    pts = []
    for i in ids:
        a = ctx.actors[i]
        if _is_vehicle(a):
            for f in frames:
                pts.extend(_corners(a, f))
        else:
            for x, y in tr[i][:, :2]:
                pts.extend([(x - half, y), (x + half, y)])
    pts = np.array(pts, dtype=float)
    x0, x1 = float(pts[:, 0].min()), float(pts[:, 0].max())
    for _ in range(3):  # the distance depends on the width and the width on the distance: a few rounds settle it
        cx = (x0 + x1) / 2
        d = dist_for_width(lens, max((x1 - x0) / frac, floor))
        k = d / np.maximum(d + pts[:, 1] - ymid, 0.35 * d)
        xe = cx + (pts[:, 0] - cx) * k
        x0, x1 = float(xe.min()), float(xe.max())
    return x0, x1


def _frames(ctx, f0, f1):
    return list(range(max(f0, 0), min(max(f1, f0), ctx.n - 1) + 1, 2)) or [max(f0, 0)]


def close_up_vehicle(ctx, who, f0, f1, aspect, lens=50.0):
    """The face of a vehicle: lamp eyes and bumper mouth at the middle of the frame, a little above the centre, from in front of the face turned
    toward the -y side (a three-quarter view when the vehicle faces sideways, straight on when it faces the default camera)."""
    actor = ctx.actors[who]
    frames = _frames(ctx, f0, f1)
    faces = [_face(actor, f) for f in frames]
    p = np.mean([q for q, _ in faces], axis=0)
    fwd = np.mean([v for _, v in faces], axis=0)
    zs = [actor.root(f)[2] for f in frames]
    vis_h = max(0.6 * actor.rig.height, 1.1) + float(max(zs) - min(zs))
    d = dist_for_width(lens, vis_h * aspect)
    v = fwd + np.array([0.0, -0.8])
    v = v / max(float(np.linalg.norm(v)), 1e-6)
    tz = float(p[2]) + 0.08 * vis_h
    return {"loc": [float(p[0] + v[0] * d), float(p[1] + v[1] * d), tz + 0.06 * d], "target": [float(p[0]), float(p[1]), tz], "lens": lens}


def over_shoulder_vehicle(ctx, a, b, f0, f1, aspect, lens=40.0):
    """Beside a's face (outside its body, on the -y side) looking at b's face (or head)."""
    fm = (f0 + min(f1, ctx.n - 1)) // 2
    A, B = ctx.actors[a], ctx.actors[b]
    pa = _face(A, fm)[0] if _is_vehicle(A) else A.head_point(fm)
    pb = _face(B, fm)[0] if _is_vehicle(B) else B.head_point(fm)
    d = pa[:2] - pb[:2]
    d = d / max(float(np.linalg.norm(d)), 1e-6)
    perp = np.array([-d[1], d[0]])
    if perp[1] > 0:
        perp = -perp
    lo, hi = _box(A)
    side = 0.5 * float(hi[0] - lo[0]) + 0.6 if _is_vehicle(A) else 0.22 * A.rig.height
    cam = pa[:2] + d * 0.6 + perp * side
    return {"loc": [float(cam[0]), float(cam[1]), float(pa[2]) + 0.35], "target": [float(pb[0]), float(pb[1]), float(pb[2])], "lens": lens}


def wide(ctx, f0, f1, aspect, lens=32.0):
    ids = list(ctx.actors)
    tr = _track(ctx, ids, f0, f1)
    xs = np.concatenate([tr[i][:, 0] for i in ids])
    half = max(ctx.actors[i].rig.height for i in ids) * 0.4
    width = float(xs.max() - xs.min()) + 2 * half
    cx = float((xs.max() + xs.min()) / 2)
    if any(_is_vehicle(ctx.actors[i]) for i in ids):
        ym = float(np.mean(np.concatenate([tr[i][:, 1] for i in ids])))
        x0, x1 = _group_x(ctx, ids, tr, _frames(ctx, f0, f1), ym, lens, 0.70, 3.8)
        width, cx = x1 - x0, (x0 + x1) / 2
    zmax = max(float(tr[i][:, 2].max()) + ctx.actors[i].rig.height for i in ids) + 0.1
    zmin = min(float(tr[i][:, 2].min()) for i in ids)
    vis_w = max(width / 0.70, 3.8, aspect * (zmax - zmin) / 0.74)
    d = dist_for_width(lens, vis_w)
    vis_h = vis_w / aspect
    ymid = float(np.mean(np.concatenate([tr[i][:, 1] for i in ids])))
    tz = float(np.clip((zmin + zmax) / 2 + 0.08 * vis_h, zmax - 0.37 * vis_h, zmin + 0.37 * vis_h))
    # vehicles: a higher camera looks over a long body in front (an engine on a track toward the camera) onto the road and the rails
    rise = 0.3 if any(_is_vehicle(ctx.actors[i]) for i in ids) else 0.16
    return {"loc": [cx, ymid - d, tz + rise * d], "target": [cx, ymid, tz], "lens": lens}


def two(ctx, a, b, f0, f1, aspect, lens=35.0):
    tr = _track(ctx, [a, b], f0, f1)
    xs = np.concatenate([tr[a][:, 0], tr[b][:, 0]])
    ys = np.concatenate([tr[a][:, 1], tr[b][:, 1]])
    ha, hb = ctx.actors[a].rig, ctx.actors[b].rig
    hmax = max(ha.height, hb.height)
    width = float(xs.max() - xs.min()) + 0.8 * hmax
    cx = float((xs.max() + xs.min()) / 2)
    if _is_vehicle(ctx.actors[a]) or _is_vehicle(ctx.actors[b]):
        x0, x1 = _group_x(ctx, [a, b] if a != b else [a], tr, _frames(ctx, f0, f1), float(ys.mean()), lens, 0.62, 2.6)
        width, cx = (x1 - x0) * 1.05, (x0 + x1) / 2
    vis_w = max(width / 0.62, 2.6, aspect * (hmax * 1.15) / 0.80)
    d = dist_for_width(lens, vis_w)
    vis_h = vis_w / aspect
    zmax = max(float(tr[a][:, 2].max()) + ha.height, float(tr[b][:, 2].max()) + hb.height) + 0.05
    zmin = min(float(tr[a][:, 2].min()), float(tr[b][:, 2].min()))
    tz = float(np.clip((zmin + zmax) / 2 + 0.05 * vis_h, zmax - 0.40 * vis_h, zmin + 0.37 * vis_h))
    cy = float(ys.mean())
    return {"loc": [cx, cy - d, tz + 0.09 * d], "target": [cx, cy, tz], "lens": lens}


def close_up(ctx, who, f0, f1, aspect, lens=50.0):
    actor = ctx.actors[who]
    if _is_vehicle(actor):
        return close_up_vehicle(ctx, who, f0, f1, aspect, lens)
    tr = _track(ctx, [who], f0, f1)[who]
    x, y = float(tr[:, 0].mean()), float(tr[:, 1].mean())  # (the third column is the root height: a seated head is higher)
    vis_h = 0.8 * actor.rig.height + float(tr[:, 2].max() - tr[:, 2].min())  # room for a sit or a hop inside the shot
    vis_w = vis_h * aspect
    d = dist_for_width(lens, vis_w)
    tz = float(tr[:, 2].max()) + actor.rig.height - 0.40 * vis_h  # the top of the character (ears included) at 90 % of the height
    yaw = actor.root((f0 + min(f1, ctx.n - 1)) // 2)[3]
    side = float(_lateral(yaw)[0])  # facing +x: the open side is on the right, so the character stands on the left third
    shift = vis_w / 6.0 * float(np.clip(side * 1.5, -1.0, 1.0))
    return {"loc": [x + shift, y - d, tz + 0.04 * d], "target": [x + shift, y, tz], "lens": lens}


def over_shoulder(ctx, a, b, f0, f1, aspect, lens=45.0):
    if _is_vehicle(ctx.actors[a]) or _is_vehicle(ctx.actors[b]):
        return over_shoulder_vehicle(ctx, a, b, f0, f1, aspect)
    fm = (f0 + min(f1, ctx.n - 1)) // 2
    pa, pb = np.array(ctx.actors[a].root(fm)[:2]), np.array(ctx.actors[b].root(fm)[:2])
    d = pa - pb
    d = d / max(np.linalg.norm(d), 1e-6)
    perp = np.array([-d[1], d[0]])
    if perp[1] > 0:  # keep the camera on the near (-y) side
        perp = -perp
    ha, hb = ctx.actors[a].rig, ctx.actors[b].rig
    cam = pa + d * 0.55 * ha.height + perp * 0.22 * ha.height
    tgt = pb - perp * 0.10 * hb.height
    za, zb = ctx.actors[a].root(fm)[2], ctx.actors[b].root(fm)[2]
    return {"loc": [cam[0], cam[1], za + ha.head_z + 0.10 * ha.height], "target": [tgt[0], tgt[1], zb + hb.head_z - 0.05 * hb.height], "lens": lens}


def shot(ctx, name, f0, f1, aspect=16 / 9):
    """The camera dict {loc, target, lens} for a shot name on screen over frames [f0, f1]."""
    if name in ctx.shots:
        return ctx.shots[name]
    ids = list(ctx.actors)
    if name == "wide":
        return wide(ctx, f0, f1, aspect)
    if name.startswith("cu-"):
        return close_up(ctx, name[3:], f0, f1, aspect)
    if name.startswith("ots-"):
        a, b = name[4:].split("-")[:2]
        return over_shoulder(ctx, a, b, f0, f1, aspect)
    if name == "two" or name.startswith("two:"):
        pair = name.split(":")[1:3] if name.startswith("two:") else ids[:2]
        if len(pair) < 2:
            return wide(ctx, f0, f1, aspect)
        return two(ctx, pair[0], pair[1], f0, f1, aspect)
    raise KeyError(f"unknown shot {name!r} (a camera of the set, wide, two, cu-<id> or ots-<a>-<b>)")


# ---------------------------------------------------------------- following shots: the frame at each moment, eased

TRACKED = ("wide", "two", "cu-")
MOVE_WINDOW = 6  # frames either side: how far an actor moved says whether it is walking
MOVING = 0.05  # metres over that window
TAU_GROUP = 0.45
TAU_CU = 0.3


def is_tracked(name, ctx):
    return name not in ctx.shots and (name in ("wide", "two") or name.startswith(("two:", "cu-")))


def _moved(ctx, who, f):
    a, b = ctx.actors[who].root(max(f - MOVE_WINDOW, 0)), ctx.actors[who].root(min(f + MOVE_WINDOW, ctx.n - 1))
    return math.hypot(a[0] - b[0], a[1] - b[1])


def smooth(arr, tau, fps=24.0):
    """A zero-phase exponential filter (forward, then backward): eased, without lag, the ends held."""
    a = 1.0 - math.exp(-1.0 / (tau * fps))
    out = np.array(arr, dtype=float)
    for rev in (False, True):
        seq = out[::-1] if rev else out
        cur = seq[0].copy()
        for i in range(len(seq)):
            cur = cur + (seq[i] - cur) * a
            seq[i] = cur
    return out


def track(ctx, name, f0, f1, aspect=16 / 9):
    """The camera (m, 7: loc, target, lens) for each frame f0..f1 of a following shot: `wide`, `two`, `cu-<id>` frame the group (or the head) as it is at that
    frame, then the series is eased. In `two`, when the pair is too far apart for the figures to stay at 40-60 % of the frame height and one of them is walking,
    the shot follows the walker alone. None for a shot that does not follow."""
    if not is_tracked(name, ctx):
        return None
    ids = list(ctx.actors)
    pair = name.split(":")[1:3] if name.startswith("two:") else ids[:2]
    rows = []
    for f in range(f0, f1 + 1):
        if name == "wide":
            d = wide(ctx, f, f, aspect)
        elif name.startswith("cu-"):
            d = close_up(ctx, name[3:], f, f, aspect)
        elif len(pair) < 2:
            d = wide(ctx, f, f, aspect)
        else:
            a, b = pair
            hmax = max(ctx.actors[a].rig.height, ctx.actors[b].rig.height)
            xa, xb = ctx.actors[a].root(f)[0], ctx.actors[b].root(f)[0]
            too_far = (abs(xa - xb) + 0.8 * hmax) / 0.62 > 1.1 * 2.5 * hmax * aspect
            ma, mb = _moved(ctx, a, f), _moved(ctx, b, f)
            if too_far and max(ma, mb) > MOVING:
                who = a if ma >= mb else b
                d = two(ctx, who, who, f, f, aspect)
            else:
                d = two(ctx, a, b, f, f, aspect)
        rows.append(vec7(d))
    return smooth(np.array(rows), TAU_CU if name.startswith("cu-") else TAU_GROUP)
