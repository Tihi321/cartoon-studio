# SPDX-License-Identifier: GPL-3.0-or-later
"""Sheets (HUB-30 CTS-20, CTS-21): the pictures a person approves before anything else is built.

Character sheet (`sheet.png`, 2048 x 1024, the pieces in `sheet/`):
    row 1  front, three-quarter, side, back (1024 x 1024 each in `sheet/`, shown at 512)
    row 2  the six mouths (REST A E O U MBP), blink, half lid        (512 x 512 each, shown at 256)
    row 3  neutral, happy, sad, surprised, look left, look right      (512 x 512 each, shown at 256)
Set sheet: see `set_sheet` (four views).
"""
import os
import time

import bpy
import numpy as np
from mathutils import Vector

from . import command, materials as M
from .build_character import SLOTS, find_rig, lid_pose, show_mouth
from .io import CtsError, progress

BACKDROP = {"top": "#f1ece0", "horizon": "#f1ece0"}

# 5 x 7 pixel letters for the tile labels
_GLYPHS = {
    "A": ".###.|#...#|#...#|#####|#...#|#...#|#...#", "B": "####.|#...#|#...#|####.|#...#|#...#|####.",
    "C": ".####|#....|#....|#....|#....|#....|.####", "D": "####.|#...#|#...#|#...#|#...#|#...#|####.",
    "E": "#####|#....|#....|####.|#....|#....|#####", "F": "#####|#....|#....|####.|#....|#....|#....",
    "G": ".####|#....|#....|#..##|#...#|#...#|.####", "H": "#...#|#...#|#...#|#####|#...#|#...#|#...#",
    "I": "#####|..#..|..#..|..#..|..#..|..#..|#####", "K": "#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#",
    "L": "#....|#....|#....|#....|#....|#....|#####", "M": "#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#",
    "N": "#...#|##..#|#.#.#|#..##|#...#|#...#|#...#", "O": ".###.|#...#|#...#|#...#|#...#|#...#|.###.",
    "P": "####.|#...#|#...#|####.|#....|#....|#....", "R": "####.|#...#|#...#|####.|#.#..|#..#.|#...#",
    "S": ".####|#....|#....|.###.|....#|....#|####.", "T": "#####|..#..|..#..|..#..|..#..|..#..|..#..",
    "U": "#...#|#...#|#...#|#...#|#...#|#...#|.###.", "W": "#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#",
    "Y": "#...#|#...#|.#.#.|..#..|..#..|..#..|..#..", "3": "####.|....#|....#|.###.|....#|....#|####.",
    "4": "#...#|#...#|#...#|#####|....#|....#|....#", "/": "....#|...#.|..#..|..#..|.#...|#....|#....",
    " ": ".....|.....|.....|.....|.....|.....|.....", "-": ".....|.....|.....|#####|.....|.....|.....",
    "1": "..#..|.##..|..#..|..#..|..#..|..#..|.###.", "2": ".###.|#...#|....#|...#.|..#..|.#...|#####",
    "V": "#...#|#...#|#...#|#...#|#...#|.#.#.|..#..", "X": "#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#",
    "Z": "#####|....#|...#.|..#..|.#...|#....|#####", "J": "..###|...#.|...#.|...#.|...#.|#..#.|.##..",
    "Q": ".###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#", "5": "#####|#....|####.|....#|....#|#...#|.###.",
    "6": ".###.|#....|#....|####.|#...#|#...#|.###.", "7": "#####|....#|...#.|..#..|.#...|.#...|.#...",
    "8": ".###.|#...#|#...#|.###.|#...#|#...#|.###.", "9": ".###.|#...#|#...#|.####|....#|....#|.###.",
    "0": ".###.|#...#|#..##|#.#.#|##..#|#...#|.###.",
}


def draw_label(canvas, text, x, y, scale=3, colour=(0.16, 0.13, 0.1)):
    """Stamps `text` (A-Z, digits, / - space) on a top-down RGBA canvas at pixel (x, y)."""
    cx = x
    for ch in text.upper():
        rows = _GLYPHS.get(ch, _GLYPHS[" "]).split("|")
        for ry, row in enumerate(rows):
            for rx, c in enumerate(row):
                if c == "#":
                    canvas[y + ry * scale : y + (ry + 1) * scale, cx + rx * scale : cx + (rx + 1) * scale, :3] = colour
        cx += 6 * scale


def load_pixels(path):
    """A rendered PNG as a top-down float array (h, w, 4)."""
    img = bpy.data.images.load(path)
    w, h = img.size
    a = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return np.flipud(a.reshape(h, w, 4))


def save_pixels(path, arr):
    """Writes a top-down (h, w, 4) float array as a PNG."""
    h, w = arr.shape[:2]
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=False)
    img.pixels.foreach_set(np.flipud(arr).astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)


def shrink(arr, k):
    h, w = arr.shape[:2]
    return arr.reshape(h // k, k, w // k, k, 4).mean(axis=(1, 3))


def sheet_scene(style, sky=BACKDROP):
    """The scene settings of a sheet: the series look without post, a plain backdrop, one orthographic camera."""
    sc = bpy.context.scene
    st = dict(style)
    st["post"] = "none"
    M.apply_look(sc, st, "final", sky=sky)
    sc.render.resolution_percentage = 100
    cam = bpy.data.objects.get("sheet_cam")
    if cam is None:
        cd = bpy.data.cameras.new("sheet_cam")
        cd.type = "ORTHO"
        cam = bpy.data.objects.new("sheet_cam", cd)
        sc.collection.objects.link(cam)
    sc.camera = cam
    return sc, cam


def render_to(sc, path, size):
    sc.render.resolution_x = sc.render.resolution_y = size
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


def aim_front(cam, centre, scale, yaw_deg=0.0):
    cam.data.ortho_scale = scale
    cam.location = (centre[0], centre[1] - 12.0, centre[2])
    cam.rotation_euler = (np.pi / 2, 0, 0)


class Posing:
    """Sets control values relative to the rest pose and puts them back."""

    def __init__(self, rig):
        self.rig = rig
        self.rest = {n: (ob.location.copy(), ob.rotation_euler.copy(), ob.scale.copy()) for n, ob in rig["controls"].items()}
        self.slots = {k: ob.scale.copy() for k, ob in rig["slots"].items()}

    def reset(self):
        for n, (loc, rot, sc) in self.rest.items():
            ob = self.rig["controls"][n]
            ob.location, ob.rotation_euler, ob.scale = loc.copy(), rot.copy(), sc.copy()
        for k, s in self.slots.items():
            self.rig["slots"][k].scale = s.copy()

    def move(self, name, dx=0.0, dy=0.0, dz=0.0, rot=(0, 0, 0), scale=None):
        ob = self.rig["controls"].get(name)
        if ob is None:
            return
        loc, r, _s = self.rest[name]
        ob.location = (loc.x + dx, loc.y + dy, loc.z + dz)
        ob.rotation_euler = (r.x + np.radians(rot[0]), r.y + np.radians(rot[1]), r.z + np.radians(rot[2]))
        if scale is not None:
            ob.scale = scale


def expressions(spec, posing):
    """Named face poses for the sheet. (The acting library has its own emotion presets; these only have to show that the controls work.)"""
    eyes = spec["face"]["eyes"]
    r = eyes["r"]
    rig = posing.rig

    def lids(amount):
        z, sc = lid_pose(amount, r)
        for side in ("L", "R"):
            posing.move(f"lid_{side}", dz=z, scale=sc)

    def brows(dz, tilt):
        for side, sx in (("L", -1), ("R", 1)):
            posing.move(f"brow_{side}", dz=dz, rot=(0, sx * tilt, 0))

    def look(dx):
        for side in ("L", "R"):
            posing.move(f"pupil_{side}", dx=dx * r * 0.45)

    out = {}

    def neutral():
        pass

    def happy():
        show_mouth(rig, "A")
        lids(0.3)
        brows(0.012, 0)
        posing.move("head", rot=(-6, 0, 0))

    def sad():
        show_mouth(rig, "rest", frown=True)
        lids(0.45)
        brows(0.0, -18)
        posing.move("head", rot=(14, 0, 0))
        for side, sx in (("L", -1), ("R", 1)):
            posing.move(f"ear_{side}1", rot=(0, sx * -14, 0))

    def surprised():
        show_mouth(rig, "O")
        brows(0.03, 0)
        posing.move("squash", scale=(0.96, 0.96, 1.06))
        for side in ("L", "R"):
            posing.move(f"ear_{side}1", rot=(-10, 0, 0))

    out["neutral"] = neutral
    out["happy"] = happy
    out["sad"] = sad
    out["surprised"] = surprised
    out["look_left"] = lambda: look(-1)
    out["look_right"] = lambda: look(1)
    out["blink"] = lambda: lids(1.0)
    out["half_lid"] = lambda: lids(0.5)
    return out


def _bbox_of(rig):
    lo, hi = Vector((1e9,) * 3), Vector((-1e9,) * 3)
    for ob in rig["objects"]:
        if ob.type != "MESH" or "cts_shadow" in ob:
            continue
        for c in ob.bound_box:
            w = ob.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    return lo, hi


def character_sheet(rig, spec, style, out_dir):
    """Renders the pieces and the one `sheet.png` into `out_dir`. Returns {file, tiles, seconds}."""
    t0 = time.perf_counter()
    sc, cam = sheet_scene(style)
    parts_dir = os.path.join(out_dir, "sheet")
    os.makedirs(parts_dir, exist_ok=True)
    posing = Posing(rig)
    bpy.context.view_layer.update()
    lo, hi = _bbox_of(rig)
    radius = max(abs(lo.x), abs(hi.x), abs(lo.y), abs(hi.y))
    frame = max(hi.z - lo.z, 2 * radius) * 1.18
    centre = (0.0, 0.0, (lo.z + hi.z) / 2)
    root = rig["controls"]["root"]
    eyes, mouth = spec["face"]["eyes"], spec["face"]["mouth"]
    head = rig["controls"]["head"]
    tiles = {}
    total = 4 + len(SLOTS) + 8  # views, mouths, the other face poses
    step = [0]

    def tick(stage):
        step[0] += 1
        progress(step[0], total, stage)

    for name, yaw in (("front", 0), ("three_quarter", 35), ("side", 90), ("back", 180)):
        posing.reset()
        root.rotation_euler.z = posing.rest["root"][1].z + np.radians(yaw)
        aim_front(cam, centre, frame)
        path = os.path.join(parts_dir, f"{name}.png")
        render_to(sc, path, 1024)
        tiles[name] = path
        tick(f"sheet {name}")
    posing.reset()

    face_frame = max(2 * eyes["x"] * 3.4, abs(eyes["z"] - mouth["at"][2]) * 3.9)
    expr = expressions(spec, posing)

    def face_shot(name, pose):
        posing.reset()
        pose()
        bpy.context.view_layer.update()
        c = head.matrix_world @ Vector((0.0, eyes["faceY"], (eyes["z"] + mouth["at"][2]) / 2))
        aim_front(cam, (c.x, c.y, c.z), face_frame)
        path = os.path.join(parts_dir, f"{name}.png")
        render_to(sc, path, 512)
        tiles[name] = path
        tick(f"sheet {name}")

    for slot in SLOTS:
        face_shot(f"mouth_{slot}", lambda s=slot: show_mouth(rig, s))
    for name in ("blink", "half_lid", "neutral", "happy", "sad", "surprised", "look_left", "look_right"):
        face_shot(name, expr[name])
    posing.reset()

    canvas = np.ones((1024, 2048, 4), dtype=np.float32)
    canvas[..., :3] = np.array([0.945, 0.925, 0.878])
    labels = {"front": "FRONT", "three_quarter": "3/4", "side": "SIDE", "back": "BACK", "blink": "BLINK", "half_lid": "HALF LID",
              "neutral": "NEUTRAL", "happy": "HAPPY", "sad": "SAD", "surprised": "SURPRISED", "look_left": "LOOK LEFT", "look_right": "LOOK RIGHT"}
    for i, name in enumerate(("front", "three_quarter", "side", "back")):
        canvas[0:512, i * 512 : (i + 1) * 512] = shrink(load_pixels(tiles[name]), 2)
        draw_label(canvas, labels[name], i * 512 + 10, 10)
    row2 = [f"mouth_{s}" for s in SLOTS] + ["blink", "half_lid"]
    row3 = ["neutral", "happy", "sad", "surprised", "look_left", "look_right"]
    for y0, row in ((512, row2), (768, row3)):
        for i, name in enumerate(row):
            canvas[y0 : y0 + 256, i * 256 : (i + 1) * 256] = shrink(load_pixels(tiles[name]), 2)
            draw_label(canvas, labels.get(name, name.replace("mouth_", "")), i * 256 + 6, y0 + 6, scale=2)
    sheet = os.path.join(out_dir, "sheet.png")
    save_pixels(sheet, canvas)
    return {"file": sheet, "tiles": sorted(tiles), "seconds": round(time.perf_counter() - t0, 2)}


@command("sheet")
def sheet_command(job):
    """job: {kind: "character", blend, spec, style?, outDir} re-renders a sheet from a built .blend."""
    kind = job.get("kind", "character")
    if kind == "character":
        from .build_character import read_spec

        bpy.ops.wm.open_mainfile(filepath=job["blend"])
        spec = read_spec(job["spec"])
        rig = find_rig(spec["id"])
        info = character_sheet(rig, spec, M.load_style(job.get("style")), job["outDir"])
        return {"sheet": info["file"], "seconds": info["seconds"]}
    if kind == "set":
        from . import build_set

        return build_set.sheet_from_job(job)
    raise CtsError("E_BLENDER_FAILED", f"unknown sheet kind {kind!r}")
