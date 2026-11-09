# SPDX-License-Identifier: GPL-3.0-or-later
"""The acting library (HUB-30 CTS-23): every action is a function `(ctx, actor, t0, t1, params) -> Clip` (a set of contributions to the actor's layers).

`library.json` is the single source of the names; this registry must list exactly the same, with the same `bodies` (tests B2 and B2v). To add an
action: write the function with `@action("name", bodies=...)` in a family module, add it to `library.json` (bodies, parts, seconds, overLine,
needsTarget, params) and to docs. A name both bodies share (`nod`, `look_at`, `turn`...) is one function that branches on the body kind
(`vehicle.is_vehicle(actor)`) to the vehicle version in `vehicle.py`; the creature branch is left as it was (pilot 3 re-renders unchanged).

The scene assembler (CTS-25) drives it like this:

    ctx = Ctx(n_frames, seed, points=..., shots=...)
    ctx.add_actor("tilly", spec, {"xy": (x, y), "yaw": deg})
    compose.build(ctx, {"tilly": {"actions": [{"action": "walk", "t0": 0, "t1": 4, "params": {"target": "bench"}}], "speaking": [[t0, t1]], ...}}, camera=[...])
    compose.write(ctx, scene_objects)        # dense channels through api5
"""
import json
import os

ACTIONS = {}
HERE = os.path.dirname(os.path.abspath(__file__))
BOTH = ("creature", "vehicle")


def action(name, bodies=("creature",)):
    """Registers an action; `bodies` are the body kinds that can do it (HUB-31) and must equal its `bodies` in library.json (test B2v)."""

    def deco(fn):
        ACTIONS[name] = fn
        fn.action_name = name
        fn.bodies = tuple(bodies)
        return fn

    return deco


def library():
    with open(os.path.join(HERE, "library.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def manifest():
    """{name: entry} of library.json."""
    return {a["name"]: a for a in library()["actions"]}


def registry_names():
    return sorted(ACTIONS)


def registry_bodies():
    """{name: sorted body kinds} as the code registers them."""
    return {n: sorted(fn.bodies) for n, fn in ACTIONS.items()}


from . import camera, gait, gestures, vehicle  # noqa: E402,F401  (they register their actions; vehicle.py holds the vehicle-only ones, HUB-31)
