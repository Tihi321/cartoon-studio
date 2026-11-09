# SPDX-License-Identifier: GPL-3.0-or-later
"""Secondary motion: ears, tails and accessory chains follow their parent's world motion through damped springs, baked last (the `secondary` layer).

A chain is the controls `<stem>1..n` (`ear_L1`, `tail1`, `acc_scarf1`) with `springs[<stem>]` {stiffness, damping} in the character spec (a library default
otherwise). Each joint is a rod hanging on a pivot: when the pivot accelerates, the rod's tip lags (angular acceleration -(u x a) / length), a spring
(stiffness k, damping c) pulls the joint back to its rest angle, and every joint after the first feels the pivot motion of the one before it. The
base acceleration comes from the world motion of the chain's parent, taken from the composed channels (forward kinematics), so a walk, a hop or a nod shakes them.
A vehicle's antenna (`antenna1..n`, HUB-31) is the same chain on `body`, with a lower gain and a smaller swing; wheels are never a chain. CTS-41:
the antenna feels its input through a soft knee (`ANTENNA_ACC`) and meets a soft stop before its 40 degree limit, so a hard zoom swings it
without pinning it there.
"""
import math

import numpy as np

from .core import FPS

SUBSTEPS = 4
MAX_ACC = 40.0
MAX_ANGLE = math.radians(55)
STOP_GAIN = 12.0  # CTS-41: the antenna's soft stop: the stiffness grows by this much at the limit (with the angle to the power STOP_POW)
STOP_POW = 4
ANTENNA_ACC = 6.0  # CTS-41: m/s2 where the antenna's input acceleration bends over (tanh)


def _joint_axis(rig, name, nxt):
    """(unit direction, length) of the rod of a joint, in its own frame: toward the next joint, else toward the centre of its parts."""
    if nxt is not None:
        v = rig.rest_loc[nxt]
    else:
        pts = [np.array(p["at"], dtype=float) for p in rig.parts if p["control"] == name]
        v = 2.0 * np.mean(pts, axis=0) if pts else np.array([0.0, 0.0, 0.1])
    ln = float(np.linalg.norm(v))
    if ln < 1e-4:
        return np.array([0.0, 0.0, 1.0]), 0.1
    return v / ln, max(ln, 0.06)


def bake_secondary(ctx, actor):
    rig, mix, n = actor.rig, actor.mix, ctx.n
    dt = 1.0 / (FPS * SUBSTEPS)
    baked = {}
    for stem, joints in rig.chains.items():
        if not all(j in rig.controls for j in joints):
            continue
        first = joints[0]
        parent = rig.controls[first]["parent"]
        if parent is None:
            continue
        k, c = rig.spring(stem)
        wm = mix.world([parent])[parent]
        pivot = wm @ np.append(rig.rest_loc[first], 1.0)
        pivot = pivot[:, :3]
        acc = np.zeros((n, 3))
        acc[1:-1] = (pivot[2:] - 2 * pivot[1:-1] + pivot[:-2]) * FPS * FPS
        if n > 3:
            acc[1:-1] = 0.25 * acc[:-2] + 0.5 * acc[1:-1] + 0.25 * acc[2:]
        rot = wm[:, :3, :3]
        rot = rot / np.maximum(np.linalg.norm(rot, axis=1, keepdims=True), 1e-9)
        a_loc = np.einsum("nji,nj->ni", rot, np.clip(acc, -MAX_ACC, MAX_ACC))
        axes = [_joint_axis(rig, j, joints[i + 1] if i + 1 < len(joints) else None) for i, j in enumerate(joints)]
        u_par = [rig.rest_rot_matrix(j) @ ax[0] for j, ax in zip(joints, axes)]
        lens = [ax[1] for ax in axes]
        nj = len(joints)
        psi = np.zeros((nj, 3))
        om = np.zeros((nj, 3))
        out = np.zeros((nj, n, 3))
        gain = 0.9 * rig.energy
        max_angle = MAX_ANGLE
        stop = False
        if stem == "antenna":  # HUB-31: a vehicle's whip antenna is a stiffer rod than an ear, and swings less
            gain, max_angle = 0.45 * rig.energy, math.radians(40)
            stop = True
            # CTS-41: a hard launch or stop is felt up to ANTENNA_ACC (a soft knee), not in full: the rod swings with the car, it does not slam
            mag = np.linalg.norm(a_loc, axis=1, keepdims=True)
            a_loc = a_loc * (ANTENNA_ACC * np.tanh(mag / ANTENNA_ACC) / np.maximum(mag, 1e-9))
        for f in range(n):
            for _ in range(SUBSTEPS):
                a_piv = a_loc[f].copy()
                prev_ang = np.zeros(3)
                for i in range(nj):
                    u = u_par[i]
                    drive = -np.cross(u, a_piv) / lens[i] * gain
                    th = psi[i] - (psi[i - 1] if i else 0.0)
                    thd = om[i] - (om[i - 1] if i else 0.0)
                    # CTS-41: the antenna meets a soft stop (the spring stiffens toward its limit), so a hard zoom swings it far but never pins it
                    kk = k * (1.0 + STOP_GAIN * (float(np.linalg.norm(th)) / max_angle) ** STOP_POW) if stop else k
                    ang_acc = drive - kk * th - c * thd
                    ang_acc -= u * float(ang_acc @ u)  # no twist about the rod
                    om[i] += ang_acc * dt
                    om[i] -= u * float(om[i] @ u)
                    psi[i] += om[i] * dt
                    a_piv = a_piv + np.cross(ang_acc, u * lens[i])
                    # keep the joint's own angle sane
                    rel = psi[i] - (psi[i - 1] if i else 0.0)
                    m = float(np.linalg.norm(rel))
                    if m > max_angle:
                        psi[i] = (psi[i - 1] if i else 0.0) + rel * (max_angle / m)
                        om[i] *= 0.5
            for i in range(nj):
                out[i, f] = psi[i] - (psi[i - 1] if i else 0.0)
        for i, j in enumerate(joints):
            baked[j] = out[i]
            mix.add("secondary", j, "rotation_euler", 0, out[i])
    return baked
