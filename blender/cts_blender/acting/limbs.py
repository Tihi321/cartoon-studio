# SPDX-License-Identifier: GPL-3.0-or-later
"""Arms and legs as directions about their pivots (arcs about the shoulder), and the rotation limits that keep an arm outside the body."""
import math

import numpy as np

from .core import dir_from_euler, euler_from_dir


def _unit(d):
    d = np.asarray(d, dtype=float).reshape(-1, 3)
    return d / np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-9)


def clamp_arm(rig, side, d):
    """Turns arm directions d (N, 3, in the body's frame) outward until the whole arm is outside the body ellipsoid (the plan's arm rotation limits)."""
    if side not in rig.shoulder:
        return _unit(d)
    sx = 1.0 if side == "R" else -1.0
    r = rig.body_r + rig.arm_rad[side] * 0.25
    s = np.linspace(0.3, 1.0, 8) * rig.arm_len[side]
    d = _unit(d).copy()
    for _ in range(60):
        pts = rig.shoulder[side][None, None, :] + s[None, :, None] * d[:, None, :]
        bad = ((((pts - rig.body_c) / r) ** 2).sum(-1) < 1.0).any(axis=1)
        if not bad.any():
            break
        d[bad] += np.array([sx * 0.06, 0.0, 0.0])
        d[bad] /= np.linalg.norm(d[bad], axis=1, keepdims=True)
    return d


def hang_dir(rig, side, n=1):
    """The direction of a hanging arm: straight down, turned out just enough to clear the body."""
    return clamp_arm(rig, side, np.tile([0.0, 0.0, -1.0], (n, 1)))[0]


def arm_delta(rig, mix, side, dirs, f0, ref=None):
    """The rotation_euler delta (N, 3) that points the arm along `dirs`, relative to the arm's rest. `ref` is the euler (alpha, beta) the series continues from."""
    rest = rig.rest_rot[f"arm_{side}"]
    rb = None if ref is None else ref[1]
    a, b = euler_from_dir(dirs, rb)
    out = np.zeros((len(a), 3))
    out[:, 0], out[:, 1] = a - rest[0], b - rest[1]
    return out


def arm_dirs_now(rig, mix, side, f, layers=("base",)):
    r = mix.at(f"arm_{side}", "rotation_euler", f, layers)
    return dir_from_euler(r[0], r[1])


def swing_dirs(rig, side, forward, abduct=None):
    """Directions of an arm swung forward (+) or back (-) by `forward` radians (N,), abducted by `abduct` (default: just clear of the body)."""
    sx = 1.0 if side == "R" else -1.0
    forward = np.asarray(forward, dtype=float)
    if abduct is None:
        h = hang_dir(rig, side)
        b0 = math.asin(min(1.0, abs(h[0])))
    else:
        b0 = abduct
    d = np.stack([sx * math.sin(b0) * np.ones_like(forward), -np.sin(forward) * math.cos(b0), -np.cos(forward) * math.cos(b0)], axis=-1)
    return clamp_arm(rig, side, d)
