# SPDX-License-Identifier: GPL-3.0-or-later
"""The look: palette hexes come out exact under the toon material, the style loader refuses bad files, and the paper post (5.x compositor) changes the frame."""
import os
import tempfile
import unittest

import bpy
import numpy as np
from mathutils import Vector

from cts_blender import materials as M
from cts_blender import shapes as S
from cts_blender.io import CtsError


def render(post):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.resolution_x, sc.render.resolution_y = 96, 54
    st = M.load_style({"post": post, "samples": {"final": 4}})
    M.apply_look(sc, st, "final")
    ob = S.make_object("ball", S.ellipsoid([0.5]), M.toon(st, "#e8843a"), loc=(0, 0, 0))
    M.add_outline(ob, 0.02, st)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    sc.collection.objects.link(cam)
    cam.location = (0, -4, 0)
    cam.rotation_euler = (Vector((0, 0, 0)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc.camera = cam
    with tempfile.TemporaryDirectory() as tmp:
        sc.render.filepath = os.path.join(tmp, "look.png")
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(sc.render.filepath)
        px = np.array(img.pixels[:], dtype=np.float32).reshape(54, 96, 4)
        bpy.data.images.remove(img)
    return px


class Look(unittest.TestCase):
    def test_palette_hex_is_exact_and_paper_changes_the_frame(self):
        clean = render("none")
        mid = clean[27, 48, :3]  # the lit front of the ball
        want = np.array(M.lin("#e8843a")[:3])
        srgb = np.where(want > 0.0031308, 1.055 * want ** (1 / 2.4) - 0.055, 12.92 * want)
        self.assertTrue(np.allclose(mid, srgb, atol=2 / 255), (mid, srgb))
        paper = render("paper")
        self.assertGreater(float(np.abs(paper[..., :3] - clean[..., :3]).mean()), 0.02)

    def test_bad_style_is_refused(self):
        with self.assertRaises(CtsError) as e:
            M.load_style({"post": "oil"})
        self.assertEqual(e.exception.code, "E_STYLE_INVALID")
        with self.assertRaises(CtsError):
            M.load_style({"toon": {"shine": 1}})


if __name__ == "__main__":
    unittest.main()
