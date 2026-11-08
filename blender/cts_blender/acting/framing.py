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
"""
import math

import numpy as np

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


def wide(ctx, f0, f1, aspect, lens=32.0):
    ids = list(ctx.actors)
    tr = _track(ctx, ids, f0, f1)
    xs = np.concatenate([tr[i][:, 0] for i in ids])
    half = max(ctx.actors[i].rig.height for i in ids) * 0.4
    width = float(xs.max() - xs.min()) + 2 * half
    zmax = max(float(tr[i][:, 2].max()) + ctx.actors[i].rig.height for i in ids) + 0.1
    zmin = min(float(tr[i][:, 2].min()) for i in ids)
    vis_w = max(width / 0.70, 3.8, aspect * (zmax - zmin) / 0.74)
    d = dist_for_width(lens, vis_w)
    vis_h = vis_w / aspect
    cx = float((xs.max() + xs.min()) / 2)
    ymid = float(np.mean(np.concatenate([tr[i][:, 1] for i in ids])))
    tz = float(np.clip((zmin + zmax) / 2 + 0.08 * vis_h, zmax - 0.37 * vis_h, zmin + 0.37 * vis_h))
    return {"loc": [cx, ymid - d, tz + 0.16 * d], "target": [cx, ymid, tz], "lens": lens}


def two(ctx, a, b, f0, f1, aspect, lens=35.0):
    tr = _track(ctx, [a, b], f0, f1)
    xs = np.concatenate([tr[a][:, 0], tr[b][:, 0]])
    ys = np.concatenate([tr[a][:, 1], tr[b][:, 1]])
    ha, hb = ctx.actors[a].rig, ctx.actors[b].rig
    hmax = max(ha.height, hb.height)
    width = float(xs.max() - xs.min()) + 0.8 * hmax
    vis_w = max(width / 0.62, 2.6, aspect * (hmax * 1.15) / 0.80)
    d = dist_for_width(lens, vis_w)
    vis_h = vis_w / aspect
    zmax = max(float(tr[a][:, 2].max()) + ha.height, float(tr[b][:, 2].max()) + hb.height) + 0.05
    zmin = min(float(tr[a][:, 2].min()), float(tr[b][:, 2].min()))
    tz = float(np.clip((zmin + zmax) / 2 + 0.05 * vis_h, zmax - 0.40 * vis_h, zmin + 0.37 * vis_h))
    cx, cy = float((xs.max() + xs.min()) / 2), float(ys.mean())
    return {"loc": [cx, cy - d, tz + 0.09 * d], "target": [cx, cy, tz], "lens": lens}


def close_up(ctx, who, f0, f1, aspect, lens=50.0):
    actor = ctx.actors[who]
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
