# SPDX-License-Identifier: GPL-3.0-or-later
"""B1: the character builder on the mini3d fixture: every standard control, six mouth slots, outlines; a buried mouth is E_FACE_HIDDEN; the same spec builds to the same hashes.
B1v (HUB-31): the mini-vehicles car: wheel controls, lamp eyes, six mouth slots, outlines, no limb control; a lamp buried in the body is E_FACE_HIDDEN."""
import copy
import os
import unittest

import bpy

from cts_blender import materials as M
from cts_blender import build_set as bs
from cts_blender.build_character import LAMP_PROP, LIMB_RE, SLOTS, build_character, read_spec, reset_scene
from cts_blender.fingerprint import fingerprint
from cts_blender.io import CtsError

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TILLY = os.path.join(ROOT, "tests", "fixtures", "mini3d", "cast", "tilly", "character.json")
CAR = os.path.join(ROOT, "tests", "fixtures", "mini-vehicles", "cast", "pip", "character.json")
STANDARD = ["root", "squash", "body", "head", "arm_L", "arm_R", "leg_L", "leg_R", "ear_L1", "ear_R1", "lid_L", "lid_R", "pupil_L", "pupil_R", "mouth"]


def build(spec):
    reset_scene()
    return build_character(spec, M.load_style())


class Build(unittest.TestCase):
    def test_legged_character_has_controls_slots_and_outlines(self):
        spec = read_spec(TILLY)
        rig = build(spec)["rig"]
        for name in STANDARD:
            self.assertIn(name, rig["controls"])
        self.assertEqual(sorted(rig["slots"]), sorted(SLOTS))
        shown = [k for k, ob in rig["slots"].items() if ob.scale.x > 0.5]
        self.assertEqual(shown, ["rest"])
        parts = [o for o in rig["objects"] if "cts_part" in o]
        self.assertEqual(len(parts), len(spec["parts"]))
        self.assertTrue(all(any(m.type == "SOLIDIFY" for m in o.modifiers) for o in parts))

    def test_buried_mouth_is_face_hidden(self):
        spec = read_spec(TILLY)
        bad = copy.deepcopy(spec)
        bad["face"]["mouth"]["at"][1] += 0.06
        with self.assertRaises(CtsError) as e:
            build(bad)
        self.assertEqual(e.exception.code, "E_FACE_HIDDEN")

    def test_same_spec_same_hashes(self):
        spec = read_spec(TILLY)
        a = fingerprint(build(spec)["rig"]["objects"])
        b = fingerprint(build(spec)["rig"]["objects"])
        self.assertEqual(a, b)

    def test_vehicle_has_wheels_lamp_eyes_mouth_slots_outlines_and_no_limbs(self):
        spec = read_spec(CAR)
        built = build(spec)
        rig = built["rig"]
        wheels = {w["control"]: w for w in built["vehicle"]["wheels"]}
        self.assertEqual(sorted(wheels), sorted(spec["vehicle"]["wheels"]))
        for w in wheels.values():
            self.assertIn(w["control"], rig["controls"])
            self.assertEqual((w["axis"], w["index"], w["radius"]), ("x", 0, spec["vehicle"]["wheelRadius"]))
        self.assertFalse([n for n in rig["controls"] if LIMB_RE.match(n)])
        lamps = [o for o in rig["objects"] if "cts_lamp" in o]
        self.assertEqual(len(lamps), 2)
        self.assertIs(rig["lamp"], rig["controls"]["head"])
        self.assertIn(LAMP_PROP, rig["lamp"])
        self.assertTrue(lamps[0].active_material.node_tree.animation_data.drivers)
        self.assertEqual(sorted(rig["slots"]), sorted(SLOTS))
        self.assertEqual([k for k, ob in rig["slots"].items() if ob.scale.x > 0.5], ["rest"])
        self.assertEqual(len(rig["puffs"]["exhaust"]), 8)
        self.assertTrue(all(ob.scale.x < 0.01 for ob in rig["puffs"]["exhaust"]))
        outlined = [o for o in rig["objects"] if "cts_part" in o or "cts_lamp" in o]
        self.assertTrue(all(any(m.type == "SOLIDIFY" for m in o.modifiers) for o in outlined))
        bad = copy.deepcopy(spec)
        bad["face"]["eyes"]["faceY"] += 0.3
        with self.assertRaises(CtsError) as e:
            build(bad)
        self.assertEqual(e.exception.code, "E_FACE_HIDDEN")


class BuildSet(unittest.TestCase):
    def test_park_has_props_marks_cameras_seat_and_builds_the_same_twice(self):
        spec = bs.read_spec(os.path.join(ROOT, "tests", "fixtures", "mini3d", "sets", "park", "set3d.json"))
        reset_scene()
        a = bs.build_set(spec, M.load_style())
        names = {o.name for o in a["objects"]}
        for want in ("park_oak", "park_bench", "park_bench_seat", "park_mark_bench", "park_cam_bench", "park_ground"):
            self.assertIn(want, names)
        self.assertEqual(a["warnings"], [])
        fa = fingerprint(a["objects"])
        reset_scene()
        b = bs.build_set(spec, M.load_style())
        self.assertEqual(fa, fingerprint(b["objects"]))
        bad = copy.deepcopy(spec)
        bad["props"][0]["kind"] = "castle"
        reset_scene()
        with self.assertRaises(CtsError) as e:
            bs.build_set(bad, M.load_style())
        self.assertEqual(e.exception.code, "E_SET_INVALID")


if __name__ == "__main__":
    unittest.main()
