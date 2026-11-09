# SPDX-License-Identifier: GPL-3.0-or-later
"""The vehicle acting family (HUB-31). CTS-31 registers the names only, so the registry equals `library.json` (test B2); every function is a stub
that returns an empty clip (no keys: the actor holds its pose and the idle and springs still run). CTS-34 writes the real animation here.

Actions shared with creatures (`blink`, `look_at`, `turn`, `nod`, `shake_head`, `react_surprised`, `laugh`, `droop` and the camera) keep one name
and live in their creature modules; CTS-34 branches on the actor's body kind there (`actor.rig.spec.get("kind") == "vehicle"`).
"""
from . import action
from .core import Clip

VEHICLE_ONLY = (
    "idle_engine",
    "drive",
    "zoom",
    "reverse",
    "chug",
    "bounce",
    "lean",
    "tilt",
    "wiggle",
    "rev",
    "honk",
    "whistle",
    "puff",
    "flash",
    "wink",
    "point_nose",
    "spin_wheels",
    "park",
    "start_up",
)


def _stub(name):
    def run(ctx, actor, t0, t1, params):
        clip = Clip(ctx.f(t0), ctx.f(t1))
        clip.meta["stub"] = name
        return clip

    run.__name__ = name
    run.__doc__ = f"{name}: a stub until CTS-34 (an empty clip)."
    return action(name)(run)


for _name in VEHICLE_ONLY:
    _stub(_name)
