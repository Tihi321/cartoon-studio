# SPDX-License-Identifier: GPL-3.0-or-later
"""B3 (CTS-33): the road and rail kit on the mini-vehicles crossing set: every path is a `path:<id>` curve that follows the spec's points and
carries its running surface (the rail top for a track, where the rails really end), and the crossing lies across the track."""
import math
import os
import unittest

from cts_blender import build_set as bs
from cts_blender import materials as M
from cts_blender.build_character import reset_scene

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CROSSING = os.path.join(ROOT, "tests", "fixtures", "mini-vehicles", "sets", "crossing", "set3d.json")


class RoadAndRail(unittest.TestCase):
    def test_crossing_set_has_path_curves_rail_top_and_a_crossing_across_the_track(self):
        spec = bs.read_spec(CROSSING)
        reset_scene()
        built = bs.build_set(spec, M.load_style())
        objs = {o.name: o for o in built["objects"]}
        for pid, path in spec["paths"].items():
            curve = objs[f"path:{pid}"]
            self.assertEqual(curve.type, "CURVE")
            self.assertEqual(curve["cts_path_kind"], path["kind"])
            pts = [tuple(round(c, 4) for c in p.co[:2]) for p in curve.data.splines[0].points]
            self.assertEqual(pts, [tuple(float(c) for c in p) for p in path["points"]])
            self.assertEqual(built["paths"][pid]["surface"], bs.RAIL_TOP if path["kind"] == "track" else bs.ROAD_TOP)
        rails = objs["crossing_rail_rails"]
        self.assertAlmostEqual(max(v.co.z for v in rails.data.vertices), bs.RAIL_TOP, places=5)
        xing = built["crossings"][0]
        self.assertEqual((xing["track"], xing["road"]), ("rail", "road"))
        self.assertAlmostEqual(math.radians(xing["rot"]) % math.pi, 0.0, places=5)  # the track runs along y


if __name__ == "__main__":
    unittest.main()
