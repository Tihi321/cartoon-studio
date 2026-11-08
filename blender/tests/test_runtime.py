# SPDX-License-Identifier: GPL-3.0-or-later
"""The Blender-side basics: the version the scripts are written for, the probe, the 5.x interpolation shim, the CTS protocol line."""
import contextlib
import io as stdio
import json
import unittest

import bpy

from cts_blender import api5, io, load_commands


class Runtime(unittest.TestCase):
    def test_blender_is_5_2(self):
        self.assertEqual(tuple(bpy.app.version[:2]), (5, 2))

    def test_probe_names_version_and_gpu_key(self):
        out = load_commands()["probe"]({})
        self.assertTrue(out["version"].startswith("5.2"))
        self.assertIn("gpu", out)

    def test_set_interpolation_after_keying(self):
        ob = bpy.data.objects.new("t", None)
        bpy.context.scene.collection.objects.link(ob)
        ob.location.x = 0
        ob.keyframe_insert("location", index=0, frame=1)
        ob.location.x = 1
        ob.keyframe_insert("location", index=0, frame=5)
        self.assertEqual(api5.set_interpolation(ob, "CONSTANT", "location"), 2)
        self.assertTrue(all(k.interpolation == "CONSTANT" for fc in api5.fcurves(ob) for k in fc.keyframe_points))

    def test_event_is_one_cts_line(self):
        buf = stdio.StringIO()
        with contextlib.redirect_stdout(buf):
            io.progress(2, 10, "render")
        line = buf.getvalue()
        self.assertTrue(line.startswith("CTS ") and line.endswith("\n") and line.count("\n") == 1)
        self.assertEqual(json.loads(line[4:]), {"type": "progress", "done": 2, "total": 10, "stage": "render"})


if __name__ == "__main__":
    unittest.main()
