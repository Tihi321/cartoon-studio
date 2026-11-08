# SPDX-License-Identifier: GPL-3.0-or-later
"""The set builder (HUB-30 decision 2, CTS-21): `sets/<id>/set3d.json` (cts.set3d/1) -> `set.blend`.

A set is a collection `set_<id>`: the ground (a slab of `ground.size` plus a far plane of the same colour out to the horizon, with flat patches
on it), props from the kit (`props.json`), the marks (empties at (x, y, 0) with `cts_mark`), the named cameras (`cts_camera`) and a seat empty
on each prop that has a `seat` (`cts_seat`). The sky is a world setting: the colours are stored on the collection (`cts_sky_top`,
`cts_sky_horizon`) and the assembler applies them with `materials.apply_sky`.

Ground patches stay below 1 cm so blob shadows (1.5 cm) lie on top of them. Props are built from one to a few meshes each; a prop root empty
`<set>_<prop>` carries `cts_prop` and `cts_kind`.
"""
import hashlib
import json
import math
import os
import time

import bpy
from mathutils import Vector

from . import command, materials as M, shapes as S
from .fingerprint import fingerprint
from .io import CtsError, progress

KIT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "props.json")


def kit():
    with open(KIT_FILE, "r", encoding="utf-8") as f:
        return json.load(f)["kinds"]


def read_spec(path):
    with open(path, "r", encoding="utf-8") as f:
        spec = json.load(f)
    if spec.get("schema") != "cts.set3d/1":
        raise CtsError("E_SET_INVALID", f"{path}: not a cts.set3d/1 file")
    return spec


def spec_hash(path):
    with open(path, "rb") as f:
        return hashlib.sha1(f.read()).hexdigest()


class Builder:
    def __init__(self, spec, style):
        self.spec, self.style, self.sid = spec, style, spec["id"]
        self.coll = bpy.data.collections.new(f"set_{self.sid}")
        bpy.context.scene.collection.children.link(self.coll)
        self.coll["cts_set"] = self.sid

    def tag(self, ob, **props):
        ob["cts_set"] = self.sid
        for k, v in props.items():
            ob[k] = v
        return ob

    def mesh(self, name, bm, hexcol, parent=None, loc=(0, 0, 0), rot=(0, 0, 0), outline=None, shade=None, unlit=False, smooth=True):
        mat = M.flat(hexcol) if unlit else M.toon(self.style, hexcol, shade)
        ob = S.make_object(f"{self.sid}_{name}", bm, mat, parent, loc, rot, smooth=smooth, collection=self.coll)
        self.tag(ob)
        if outline is None:
            ext = max(max(v.co.length for v in ob.data.vertices) if ob.data.vertices else 0.1, 0.05)
            outline = M.default_outline_width((ext, ext, ext))
        M.add_outline(ob, outline, self.style)
        return ob

    def empty(self, name, parent=None, loc=(0, 0, 0), rot=(0, 0, 0), size=0.1, **props):
        e = S.empty(f"{self.sid}_{name}", parent, loc, rot, size=size, collection=self.coll)
        return self.tag(e, **props)

    # ---- ground

    def ground(self):
        g = self.spec["ground"]
        w, d = g["size"]
        bm = S.box([w, d, 0.1])
        self.mesh("ground", bm, g["colour"], loc=(0, 0, -0.05), shade=0.85, outline=0.0, smooth=False)
        far = S.box([400, 400, 0.1])
        self.mesh("ground_far", far, g["colour"], loc=(0, 0, -0.17), shade=0.85, outline=0.0, smooth=False)
        for i, p in enumerate(g.get("patches", [])):
            top = 0.003 + 0.001 * i
            sx, sy = p["size"]
            bm = S.box([sx, sy, 0.02]) if p["shape"] == "rect" else S.cylinder([sx / 2, sy / 2, 0.02])
            self.mesh(f"patch{i}", bm, p["colour"], loc=(p["at"][0], p["at"][1], top - 0.01), shade=0.88, outline=0.0, smooth=False)

    # ---- props

    def prop(self, p):
        kind, pid = p["kind"], p["id"]
        if kind not in KIT:
            raise CtsError("E_SET_INVALID", f"prop {pid}: unknown kind {kind!r} (kit: {', '.join(sorted(KIT))})")
        col = {**{k: None for k in KIT[kind]["colours"]}, **(p.get("colours") or {})}
        bad = [k for k in (p.get("colours") or {}) if k not in KIT[kind]["colours"]]
        if bad:
            raise CtsError("E_SET_INVALID", f"prop {pid}: {kind} has no colour {bad[0]!r} (it has {', '.join(KIT[kind]['colours'])})")
        root = self.empty(pid, None, (p["at"][0], p["at"][1], 0.0), (0, 0, p.get("rot", 0.0)), size=0.2, cts_prop=pid, cts_kind=kind)
        s = p.get("scale", 1.0)
        root.scale = (s, s, s)
        getattr(self, f"_{kind}")(pid, root, lambda k, default: col.get(k) or default)
        if p.get("seat"):
            st = p["seat"]
            self.empty(f"{pid}_seat", root, (st["at"][0], st["at"][1], st["height"]), size=0.1, cts_seat=pid)

    def _tree_round(self, pid, root, c):
        self.mesh(f"{pid}_trunk", S.cone([0.22, 1.6, 0.17]), c("trunk", "#7a4e2e"), root, (0, 0, 0.8), outline=0.02)
        leaves, leaves2 = c("leaves", "#58a84a"), c("leaves2", "#63b34f")
        self.mesh(f"{pid}_crown", S.ellipsoid([1.3, 1.3, 1.15]), leaves, root, (0, 0, 2.3), shade=0.78, outline=0.03)
        self.mesh(f"{pid}_crown2", S.ellipsoid([0.9, 0.9, 0.8]), leaves2, root, (-0.85, 0.15, 2.0), shade=0.78, outline=0.025)
        self.mesh(f"{pid}_crown3", S.ellipsoid([0.85, 0.85, 0.75]), leaves2, root, (0.85, 0.1, 2.05), shade=0.78, outline=0.025)

    def _tree_cone(self, pid, root, c):
        self.mesh(f"{pid}_trunk", S.cone([0.18, 0.8, 0.15]), c("trunk", "#7a4e2e"), root, (0, 0, 0.4), outline=0.02)
        self.mesh(f"{pid}_top", S.cone([1.0, 3.0, 0.05]), c("leaves", "#3f8a45"), root, (0, 0, 2.2), shade=0.75, outline=0.03)

    def _bush(self, pid, root, c):
        leaves = c("leaves", "#4f9e45")
        bm = S.ellipsoid([0.7, 0.55, 0.45])
        S.add_ellipsoid(bm, (0.45, 0.4, 0.35), (0.55, 0.1, -0.05))
        S.add_ellipsoid(bm, (0.4, 0.38, 0.32), (-0.5, 0.05, -0.08))
        self.mesh(f"{pid}_body", bm, leaves, root, (0, 0, 0.35), shade=0.75, outline=0.015)

    def _bench(self, pid, root, c):
        wood, legs = c("wood", "#c98a4b"), c("legs", "#6b4a35")
        seat = S.new_bm()
        for k in range(3):
            S.add_box(seat, (1.6, 0.13, 0.05), (0, -0.15 + k * 0.15, 0.45))
        for k in range(2):
            S.add_box(seat, (1.6, 0.05, 0.12), (0, 0.17, 0.66 + k * 0.17), (-8, 0, 0))
        self.mesh(f"{pid}_boards", seat, wood, root, shade=0.75, outline=0.01, smooth=False)
        frame = S.new_bm()
        for sx in (-0.7, 0.7):
            for sy in (-0.18, 0.18):
                S.add_box(frame, (0.07, 0.07, 0.45), (sx, sy, 0.22))
            S.add_box(frame, (0.07, 0.06, 0.5), (sx, 0.2, 0.7))
        self.mesh(f"{pid}_frame", frame, legs, root, outline=0.01, smooth=False)

    def _rock(self, pid, root, c):
        bm = S.ellipsoid([0.5, 0.4, 0.3])
        S.add_ellipsoid(bm, (0.28, 0.25, 0.2), (0.4, -0.1, -0.05))
        self.mesh(f"{pid}_stone", bm, c("stone", "#9a9a96"), root, (0, 0, 0.18), shade=0.78, outline=0.012)

    def _flowers(self, pid, root, c):
        import random

        rng = random.Random(int(hashlib.sha1(pid.encode()).hexdigest()[:8], 16))
        cols = [c("a", "#ffffff"), c("b", "#ffd84a"), c("c", "#ff9fc0")]
        for ci, hexcol in enumerate(cols):
            bm = S.new_bm()
            for _ in range(10):
                a, r = rng.uniform(0, math.tau), 0.9 * math.sqrt(rng.random())
                S.add_ellipsoid(bm, (0.06, 0.06, 0.035), (r * math.cos(a), r * math.sin(a), 0.03), seg=12)
            self.mesh(f"{pid}_bloom{ci}", bm, hexcol, root, outline=0.0, unlit=True)

    def _fence(self, pid, root, c):
        wood = c("wood", "#b98a55")
        bm = S.new_bm()
        for i in range(7):
            S.add_box(bm, (0.08, 0.08, 0.7), (-1.5 + i * 0.5, 0, 0.35))
        for z in (0.28, 0.52):
            S.add_box(bm, (3.1, 0.05, 0.07), (0, 0, z))
        self.mesh(f"{pid}_fence", bm, wood, root, shade=0.78, outline=0.008, smooth=False)

    def _house(self, pid, root, c):
        self.mesh(f"{pid}_walls", S.box([3.0, 2.4, 2.0]), c("walls", "#f0d9a8"), root, (0, 0, 1.0), shade=0.8, outline=0.03, smooth=False)
        import bmesh
        from mathutils import Matrix

        roof = S.cone([2.4, 1.3, 0.0001], seg=4)
        bmesh.ops.rotate(roof, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 4, 3, "Z"), verts=roof.verts)
        bmesh.ops.scale(roof, vec=Vector((1.0, 0.75, 1.0)), verts=roof.verts)
        self.mesh(f"{pid}_roof", roof, c("roof", "#c4553d"), root, (0, 0, 2.65), shade=0.75, outline=0.03, smooth=False)
        self.mesh(f"{pid}_door", S.box([0.6, 0.06, 1.2]), c("door", "#7a4e2e"), root, (0, -1.22, 0.6), outline=0.01, smooth=False)
        for sx in (-0.9, 0.9):
            self.mesh(f"{pid}_window{sx}", S.box([0.55, 0.06, 0.55]), "#bfe6f5", root, (sx, -1.22, 1.25), outline=0.01, smooth=False)

    def _cloud(self, pid, root, c):
        bm = S.ellipsoid([2.6, 1.3, 1.8])
        for dx, dz, r in ((2.4, -0.4, 1.7), (-2.4, -0.5, 1.6), (1.0, 0.9, 1.5)):
            S.add_ellipsoid(bm, (r * 1.2, r * 0.6, r), (dx, 0, dz), seg=24)
        self.mesh(f"{pid}_puffs", bm, c("cloud", "#ffffff"), root, (0, 0, 8.0), outline=0.0, unlit=True)

    # ---- marks, cameras

    def marks(self):
        for name, (x, y) in self.spec["marks"].items():
            self.empty(f"mark_{name}", None, (x, y, 0.0), size=0.15, cts_mark=name)

    def cameras(self):
        for name, c in self.spec.get("cameras", {}).items():
            cd = bpy.data.cameras.new(f"{self.sid}_cam_{name}")
            cd.lens = c["lens"]
            cam = bpy.data.objects.new(f"{self.sid}_cam_{name}", cd)
            self.coll.objects.link(cam)
            cam.location = tuple(c["loc"])
            cam.rotation_euler = (Vector(c["target"]) - Vector(c["loc"])).to_track_quat("-Z", "Y").to_euler()
            self.tag(cam, cts_camera=name)


KIT = kit()


def warnings_for(spec):
    """Marks inside a prop's footprint and benches without a seat."""
    out = []
    for name, (x, y) in spec["marks"].items():
        for p in spec["props"]:
            r = KIT[p["kind"]]["footprint"] * p.get("scale", 1.0)
            if r > 0 and math.hypot(x - p["at"][0], y - p["at"][1]) < r:
                out.append(f"mark {name!r} is inside the footprint of prop {p['id']!r} ({p['kind']}, radius {r:.2f} m): an actor would stand in it")
    for p in spec["props"]:
        if p["kind"] == "bench" and not p.get("seat"):
            out.append(f"bench {p['id']!r} has no seat: nobody can sit on it")
    return out


def build_set(spec, style):
    b = Builder(spec, style)
    b.coll["cts_sky_top"], b.coll["cts_sky_horizon"] = spec["sky"]["top"], spec["sky"]["horizon"]
    b.ground()
    for p in spec["props"]:
        b.prop(p)
    b.marks()
    b.cameras()
    bpy.context.view_layer.update()
    return {"collection": b.coll, "objects": list(b.coll.objects), "warnings": warnings_for(spec)}


def find_set(sid):
    coll = bpy.data.collections.get(f"set_{sid}")
    if coll is None:
        raise CtsError("E_SET_INVALID", f"no set {sid!r} in this file")
    return {"collection": coll, "objects": list(coll.objects)}


@command("build-set")
def build_set_command(job):
    """job: {spec, style?, outDir, sheet?: bool}. Writes outDir/set.blend and outDir/build.json (and sheet.png)."""
    t0 = time.perf_counter()
    spec_path, out = job["spec"], job["outDir"]
    os.makedirs(out, exist_ok=True)
    spec = read_spec(spec_path)
    style = M.load_style(job.get("style"))
    from .build_character import reset_scene

    progress(0, 3, "build")
    reset_scene()
    built = build_set(spec, style)
    blend = os.path.join(out, "set.blend")
    fp = fingerprint(built["objects"])
    bpy.ops.wm.save_as_mainfile(filepath=blend, compress=True)
    info = {
        "schema": "cts.set-build/1",
        "id": spec["id"],
        "specHash": spec_hash(spec_path),
        "blender": bpy.app.version_string,
        "props": [p["id"] for p in spec["props"]],
        "marks": sorted(spec["marks"]),
        "cameras": sorted(spec.get("cameras", {})),
        "objects": fp["count"],
        "hash": {"objects": fp["objects"], "controls": fp["controls"], "keys": fp["keys"]},
        "warnings": built["warnings"],
    }
    sheet = None
    if job.get("sheet", True):
        from . import sheets

        progress(1, 3, "sheet")
        sheet = sheets.set_sheet(spec, style, out)
        info["sheet"] = sheet
    info["buildSeconds"] = round(time.perf_counter() - t0, 2)
    with open(os.path.join(out, "build.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(info, f, indent=2)
        f.write("\n")
    progress(3, 3, "done")
    return {"blend": blend, "build": os.path.join(out, "build.json"), "sheet": sheet and sheet["file"], "warnings": built["warnings"], "buildSeconds": info["buildSeconds"], "specHash": info["specHash"], "hash": info["hash"]}


def sheet_from_job(job):
    from . import sheets

    bpy.ops.wm.open_mainfile(filepath=job["blend"])
    spec = read_spec(job["spec"])
    info = sheets.set_sheet(spec, M.load_style(job.get("style")), job["outDir"])
    return {"sheet": info["file"], "seconds": info["seconds"]}
