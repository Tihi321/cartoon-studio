# SPDX-License-Identifier: GPL-3.0-or-later
"""B2: the acting library. The registry names equal library.json; each gesture's keys stay inside [t0, t1 + settle] and come back to the rest pose;
in a 3 m walk each planted foot moves less than 2 cm in world space during its contact phase; a tail spring settles within 1 s after the root stops."""
import copy
import math
import os
import unittest

import bpy
import numpy as np
from mathutils import Vector

from cts_blender import materials as M
from cts_blender.acting import ACTIONS, compose, manifest, registry_names
from cts_blender.acting.core import FPS, SETTLE_S, Ctx
from cts_blender.build_character import build_character, read_spec, reset_scene

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TILLY = os.path.join(ROOT, "tests", "fixtures", "mini3d", "cast", "tilly", "character.json")
POINTS = {"oak": (-3.0, 2.0, 1.5), "seat": (0.0, 2.0, 0.45)}


def fresh(spec=None, seconds=14.0, yaw=90.0):
    ctx = Ctx(int(seconds * FPS), seed=3, points=POINTS)
    ctx.seats = {"bench": {"xy": [1.0, 1.0], "z": 0.45, "yaw": 0.0}}
    actor = ctx.add_actor("tilly", spec or read_spec(TILLY), {"xy": (0.0, 0.0), "yaw": yaw})
    return ctx, actor


class Registry(unittest.TestCase):
    def test_registry_names_equal_library_json(self):
        self.assertEqual(registry_names(), sorted(manifest()))


class Gestures(unittest.TestCase):
    def test_keys_stay_in_window_and_return_to_rest(self):
        names = [n for n, a in manifest().items() if a["kind"] in ("gesture", "react") and n not in ("idle", "look_at", "sit", "stand_up")]
        self.assertGreaterEqual(len(names), 10)
        for name in names:
            ctx, actor = fresh()
            spec = manifest()[name]
            t0 = 2.0
            t1 = t0 + spec["seconds"]["default"]
            clip = ACTIONS[name](ctx, actor, t0, t1, {"target": "oak"} if spec["needsTarget"] else {})
            f0, f1 = ctx.f(t0), ctx.f(t1)
            lo, hi = clip.span()
            self.assertGreaterEqual(lo, f0, name)
            self.assertLessEqual(hi, f1 + int(round(SETTLE_S * FPS)), name)
            clip.apply(actor.mix)
            moved = False
            for layer, d in actor.mix.layers.items():
                if layer == "base":  # a gesture never writes the state layer
                    continue
                for key, arr in d.items():
                    self.assertLess(float(np.abs(arr[hi:]).max()), 1e-6, f"{name} {key} does not return to rest")
                    self.assertLess(float(np.abs(arr[: f0]).max()) if f0 else 0.0, 1e-6, f"{name} {key} moves before t0")
                    moved = moved or float(np.abs(arr).max()) > 1e-3
            if name != "blink":
                self.assertTrue(moved or actor.mix.lid["L"].max() > 0, f"{name} does nothing")
            self.assertEqual(float(actor.mix.lid["L"][hi:].max()), 0.0, name)
        # sit then stand_up: the same pose as before
        ctx, actor = fresh()
        base = {k: v.copy() for k, v in actor.mix.layers["base"].items()}
        ACTIONS["sit"](ctx, actor, 1.0, 2.3, {"target": "bench"}).apply(actor.mix)
        self.assertGreater(actor.root(ctx.f(3.0))[2], 0.1)
        ACTIONS["stand_up"](ctx, actor, 3.0, 4.2, {}).apply(actor.mix)
        end = ctx.f(4.2) + ctx.settle
        for key, arr in base.items():
            if key != ("root", "rotation_euler") and key[0] in ("root", "arm_L", "arm_R", "body", "squash", "leg_L", "leg_R") and key[1] != "location":
                np.testing.assert_allclose(actor.mix.layers["base"][key][end], arr[end], atol=1e-5, err_msg=str(key))
        self.assertAlmostEqual(actor.root(end)[2], 0.0, places=4)


class Walk(unittest.TestCase):
    def test_planted_feet_slip_less_than_2_cm_over_3_m(self):
        spec = read_spec(TILLY)
        reset_scene()
        style = M.load_style()
        rig = build_character(spec, style)["rig"]
        ctx, actor = fresh(spec)
        plan = {"tilly": {"actions": [{"action": "walk", "t0": 0.5, "t1": 5.0, "params": {"target": [3.0, 0.0, 0.0]}}]}}
        compose.build(ctx, plan)
        compose.write(ctx, {"actors": {"tilly": {"controls": rig["controls"], "slots": rig["slots"], "shadow": None}}, "camera": None})
        clip = actor.clips[0][1]
        self.assertAlmostEqual(clip.meta["rootEnd"][0], 3.0, places=3)
        L = actor.rig.leg_len
        sc = bpy.context.scene
        f0 = clip.meta["f0"]
        foot = {"L": [], "R": []}
        for f in range(ctx.f(5.0) + 2):
            sc.frame_set(f + compose.FIRST_FRAME)
            for s in "LR":
                p = rig["controls"][f"leg_{s}"].matrix_world @ Vector((0, 0, -L))
                foot[s].append(np.array(p))
        phases = 0
        for s in "LR":
            for t_land, t_lift, _xy in clip.meta["plan"][s]:
                a = f0 + int(math.ceil(t_land * FPS)) + 1
                b = min(f0 + int(t_lift * FPS) - 1 if t_lift < 1e8 else ctx.f(5.0), len(foot[s]) - 1)
                if b - a < 2:
                    continue
                seg = np.array(foot[s][a : b + 1])
                phases += 1
                self.assertLess(float(np.linalg.norm(seg[:, :2] - seg[0, :2], axis=1).max()), 0.02, f"foot {s} slips in the contact phase at frame {a}")
                self.assertLess(float(np.abs(seg[:, 2]).max()), 0.02, f"foot {s} is off the ground in its contact phase at frame {a}")
        self.assertGreaterEqual(phases, 8)


class Spring(unittest.TestCase):
    def test_tail_spring_settles_within_a_second_after_the_root_stops(self):
        spec = copy.deepcopy(read_spec(TILLY))
        spec["controls"]["tail1"] = {"parent": "body", "at": [0, 0.1, 0.0], "rot": [-30, 0, 0]}
        spec["controls"]["tail2"] = {"parent": "tail1", "at": [0, 0, 0.12]}
        spec["springs"]["tail"] = {"stiffness": 45, "damping": 6}
        spec["parts"].append({"id": "tail_a", "shape": "ellipsoid", "size": [0.05, 0.05, 0.08], "at": [0, 0, 0.06], "colour": "fur", "control": "tail1"})
        spec["parts"].append({"id": "tail_b", "shape": "ellipsoid", "size": [0.05, 0.05, 0.08], "at": [0, 0, 0.06], "colour": "fur", "control": "tail2"})
        ctx, actor = fresh(spec, seconds=10.0)
        compose.build(ctx, {"tilly": {"actions": [{"action": "walk", "t0": 0.5, "t1": 4.5, "params": {"target": [3.0, 0.0, 0.0]}}]}})
        clip = actor.clips[0][1]
        stop = clip.meta["f0"] + int(clip.meta["timeEnd"] * FPS)
        tail = actor.mix.layers["secondary"][("tail1", "rotation_euler")]
        mag = np.linalg.norm(tail, axis=1)
        during = float(mag[: stop + 1].max())
        self.assertGreater(math.degrees(during), 1.5, "the tail never moved while walking")
        after = float(mag[stop + FPS :].max())
        self.assertLess(after, max(math.radians(0.5), 0.08 * during), f"tail still swings {math.degrees(after):.2f} deg a second after the root stopped")


if __name__ == "__main__":
    unittest.main()
