# SPDX-License-Identifier: GPL-3.0-or-later
"""The set builder (HUB-30 decision 2, CTS-21): `sets/<id>/set3d.json` (cts.set3d/1) -> `set.blend`.

A set is a collection `set_<id>`: the ground (a slab of `ground.size` plus a far plane of the same colour out to the horizon, with flat patches
on it), props from the kit (`props.json`), the marks (empties at (x, y, 0) with `cts_mark`), the named cameras (`cts_camera`) and a seat empty
on each prop that has a `seat` (`cts_seat`). The sky is a world setting: the colours are stored on the collection (`cts_sky_top`,
`cts_sky_horizon`) and the assembler applies them with `materials.apply_sky`.

Ground patches stay below 1 cm so blob shadows (1.5 cm) lie on top of them. Props are built from one to a few meshes each; a prop root empty
`<set>_<prop>` carries `cts_prop` and `cts_kind`.

Road and rail (HUB-31 decision 11, CTS-33): each path of the set (`paths: {id: {kind road|track, points, width?}}`) becomes a poly curve object
named `path:<id>` at ground level (z 0) on the centre line, with `cts_path`, `cts_path_kind`, `cts_path_width`, `cts_path_length` and
`cts_path_surface` (the height a wheel bottom runs on: the asphalt top of a road, `ROAD_TOP`; the rail top of a track, `RAIL_TOP`). `build.json`
lists the same under `paths` (plus `gauge` for a track), `railTop` and `crossings`, so the engine reads them without Blender. A `road` or `track`
prop is built along its `path` (its `at`, `rot` and `scale` are not used); a `crossing` turns itself so its boards lie across the nearest track
path. When the set has paths, the set sheet gets a third row: the set seen from above with the paths drawn over it and the marks labelled.
"""
import hashlib
import json
import math
import os
import time

import bpy
import numpy as np
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
        self.crossings, self.along = [], None

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
        build = getattr(self, f"_{kind}", None)
        if build is None:
            raise CtsError("E_SET_INVALID", f"prop {pid}: the set builder cannot build a {kind!r} yet")
        if kind in PATH_PROPS:
            self.along = self.path_of(p, PATH_PROPS[kind])
            root = self.empty(pid, None, (0.0, 0.0, 0.0), size=0.2, cts_prop=pid, cts_kind=kind, cts_path=p["path"])
        else:
            rot = self.crossing_rot(p) if kind == "crossing" else p.get("rot", 0.0)
            root = self.empty(pid, None, (p["at"][0], p["at"][1], 0.0), (0, 0, rot), size=0.2, cts_prop=pid, cts_kind=kind)
            s = p.get("scale", 1.0)
            root.scale = (s, s, s)
        build(pid, root, lambda k, default: col.get(k) or default)
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

    # ---- road and rail (CTS-33)

    def path_of(self, p, kind):
        pid, name = p["id"], p.get("path")
        path = (self.spec.get("paths") or {}).get(name) if name else None
        if path is None:
            raise CtsError("E_SET_INVALID", f"prop {pid}: a {p['kind']} names the {kind} path it is built along ({name!r} is not a path of the set)")
        if path["kind"] != kind:
            raise CtsError("E_SET_INVALID", f"prop {pid}: a {p['kind']} is built along a {kind} path; {name!r} is a {path['kind']}")
        return path

    def _road(self, pid, root, c):
        """Asphalt along the path, a light kerb line on each edge and white centre dashes (1 m on, 1 m off)."""
        pts, half = self.along["points"], path_width(self.along) / 2
        self.mesh(f"{pid}_asphalt", ribbon(pts, -half, half, 0.0, ROAD_TOP), c("asphalt", "#5d6068"), root, shade=0.85, outline=0.0, smooth=False)
        kerb = S.new_bm()
        for lo, hi in ((-half - 0.06, -half + 0.12), (half - 0.12, half + 0.06)):
            ribbon(pts, lo, hi, 0.0, KERB_TOP, kerb)
        self.mesh(f"{pid}_kerb", kerb, c("kerb", "#d6d0c2"), root, shade=0.85, outline=0.006, smooth=False)
        dash, length, s = S.new_bm(), polyline_length(pts), DASH / 2
        while s + DASH / 2 <= length - 0.2:
            (x, y), yaw = point_at(pts, s)
            S.add_box(dash, (DASH, 0.14, 0.008), (x, y, ROAD_TOP + 0.003), (0, 0, yaw))
            s += 2 * DASH
        self.mesh(f"{pid}_dashes", dash, c("dash", "#f6f1df"), root, outline=0.0, unlit=True, smooth=False)

    def _track(self, pid, root, c):
        """A ballast bed along the path, sleepers every 0.6 m and two rails whose top is `RAIL_TOP`."""
        pts, width = self.along["points"], path_width(self.along)
        half, g = width / 2, gauge(width) / 2
        self.mesh(f"{pid}_ballast", ribbon(pts, -half, half, 0.0, BALLAST_TOP, taper=0.12), c("ballast", "#a39a8b"), root, shade=0.8, outline=0.008, smooth=False)
        sleepers, length, s = S.new_bm(), polyline_length(pts), SLEEPER_STEP / 2
        while s <= length - 0.1:
            (x, y), yaw = point_at(pts, s)
            S.add_box(sleepers, (0.24, width * 0.86, SLEEPER_TOP - BALLAST_TOP), (x, y, (BALLAST_TOP + SLEEPER_TOP) / 2), (0, 0, yaw))
            s += SLEEPER_STEP
        self.mesh(f"{pid}_sleepers", sleepers, c("sleeper", "#7b5a3d"), root, shade=0.78, outline=0.008, smooth=False)
        rails = S.new_bm()
        for side in (-g, g):
            ribbon(pts, side - RAIL_W / 2, side + RAIL_W / 2, SLEEPER_TOP, RAIL_TOP, rails)
        self.mesh(f"{pid}_rails", rails, c("rail", "#9a9ca6"), root, shade=0.7, outline=0.008, smooth=False)

    def crossing_rot(self, p):
        """A crossing lies across the nearest track path (its local +y along the track); with no track within 3 m it keeps its `rot`."""
        near = nearest_path(self.spec, p["at"], "track")
        if near is None or near[1] > 3.0:
            return p.get("rot", 0.0)
        dx, dy = near[2]
        return math.degrees(math.atan2(-dx, dy))

    def _crossing(self, pid, root, c):
        """Boards over the track where the road crosses it (with a ramp down to the asphalt on each side), a static barrier with its striped
        arm raised on the near side of the road, and a striped cross sign on the far side."""
        p = next(q for q in self.spec["props"] if q["id"] == pid)
        track, road = nearest_path(self.spec, p["at"], "track"), nearest_path(self.spec, p["at"], "road")
        track = track if track and track[1] <= 3.0 else None
        road = road if road and road[1] <= 3.0 else None
        tw = path_width(self.spec["paths"][track[0]]) if track else PATH_WIDTH_DEFAULT["track"]
        rw = path_width(self.spec["paths"][road[0]]) if road else PATH_WIDTH_DEFAULT["road"]
        g, out, rh, top = gauge(tw) / 2, tw / 2 + 0.15, rw / 2, RAIL_TOP - 0.006
        boards = S.new_bm()
        for lo, hi in ((-g + RAIL_W, g - RAIL_W), (g + RAIL_W, out), (-out, -g - RAIL_W)):
            S.add_box(boards, (hi - lo, 2 * rh, top), ((lo + hi) / 2, 0, top / 2))
        for sx in (-1, 1):
            S.add_box(boards, (0.7, 2 * rh, top * 0.5), (sx * (out + 0.35), 0, top * 0.25))
        self.mesh(f"{pid}_boards", boards, c("boards", "#9c7048"), root, shade=0.8, outline=0.008, smooth=False)
        post, stripe = c("post", "#ece7dc"), c("stripe", "#d8423a")
        bx, by = -(out + 0.9), -(rh + 0.45)
        self.mesh(f"{pid}_barrier_post", S.box([0.16, 0.16, 1.1]), post, root, (bx, by, 0.55), outline=0.008, smooth=False)
        self.mesh(f"{pid}_barrier_box", S.box([0.3, 0.26, 0.3]), stripe, root, (bx, by, 1.05), outline=0.008, smooth=False)
        white, red = S.new_bm(), S.new_bm()
        for k in range(6):
            S.add_box(red if k % 2 else white, (0.1, 0.08, 0.5), (0, 0, 0.25 + k * 0.5))
        for name, bm, colour in (("barrier_arm", white, post), ("barrier_bands", red, stripe)):
            self.mesh(f"{pid}_{name}", bm, colour, root, (bx, by - 0.2, 1.1), (0, 8, 0), outline=0.008, smooth=False)
        sx, sy = out + 0.9, rh + 0.45
        self.mesh(f"{pid}_sign_post", S.box([0.1, 0.1, 2.2]), post, root, (sx, sy, 1.1), outline=0.008, smooth=False)
        cross, bands = S.new_bm(), S.new_bm()
        for a in (35, -35):
            S.add_box(cross, (1.1, 0.04, 0.2), (0, 0, 0), (0, a, 0))
            for t in (-0.3, 0.3):
                S.add_box(bands, (0.2, 0.05, 0.2), (t * math.cos(math.radians(a)), 0, -t * math.sin(math.radians(a))), (0, a, 0))
        self.mesh(f"{pid}_sign", cross, c("sign", "#f7f3ea"), root, (sx, sy - 0.07, 1.95), outline=0.008, smooth=False)
        self.mesh(f"{pid}_sign_bands", bands, stripe, root, (sx, sy - 0.075, 1.95), outline=0.0, smooth=False)
        self.crossings.append({"id": pid, "at": list(p["at"]), "rot": round(math.degrees(root.rotation_euler.z), 3) + 0.0, "top": round(top, 4),
                               "track": track and track[0], "road": road and road[0]})

    def _platform(self, pid, root, c):
        """A small station platform (3.2 x 1.6 m, 0.35 m high, long along local x) with edge stripes on both long sides and a roof on two posts."""
        self.mesh(f"{pid}_deck", S.box([3.2, 1.6, 0.35]), c("deck", "#c9bfae"), root, (0, 0, 0.175), shade=0.8, outline=0.015, smooth=False)
        edge = S.new_bm()
        for sy in (-0.72, 0.72):
            S.add_box(edge, (3.2, 0.14, 0.02), (0, sy, 0.355))
        self.mesh(f"{pid}_edge", edge, c("edge", "#f2c84b"), root, outline=0.0, unlit=True, smooth=False)
        posts = S.new_bm()
        for sx in (-1.1, 1.1):
            S.add_box(posts, (0.12, 0.12, 2.0), (sx, 0, 1.35))
        self.mesh(f"{pid}_posts", posts, c("post", "#5f6670"), root, outline=0.008, smooth=False)
        self.mesh(f"{pid}_roof", S.box([3.0, 1.9, 0.1]), c("roof", "#c4553d"), root, (0, 0, 2.4), shade=0.75, outline=0.02, smooth=False)
        self.mesh(f"{pid}_ridge", S.box([3.0, 0.5, 0.14]), c("roof", "#c4553d"), root, (0, 0, 2.5), shade=0.75, outline=0.012, smooth=False)

    def _signal(self, pid, root, c):
        """A colour-light signal facing -y: a post and a dark head with two lamps (the `lamp` colour on top, green below)."""
        self.mesh(f"{pid}_base", S.box([0.4, 0.4, 0.15]), "#8b8e94", root, (0, 0, 0.075), outline=0.008, smooth=False)
        self.mesh(f"{pid}_post", S.cylinder([0.06, 0.06, 2.4]), c("post", "#5f6670"), root, (0, 0, 1.2), outline=0.008)
        self.mesh(f"{pid}_head", S.box([0.42, 0.24, 0.8]), c("head", "#2f3236"), root, (0, 0, 2.55), outline=0.012, smooth=False)
        self.mesh(f"{pid}_lamp", S.cylinder([0.13, 0.13, 0.05]), c("lamp", "#ff4a3d"), root, (0, -0.13, 2.73), (90, 0, 0), outline=0.0, unlit=True)
        self.mesh(f"{pid}_lamp2", S.cylinder([0.13, 0.13, 0.05]), "#57d36a", root, (0, -0.13, 2.37), (90, 0, 0), outline=0.0, unlit=True)

    def _buffer_stop(self, pid, root, c):
        """The end of a line, facing -y: put it at a track's end, turned so -y looks along the track toward the train."""
        frame = S.new_bm()
        for sx in (-0.5, 0.5):
            S.add_box(frame, (0.14, 0.14, 0.75), (sx, 0, 0.375))
            S.add_box(frame, (0.12, 0.12, 0.95), (sx, 0.35, 0.36), (-38, 0, 0))
        self.mesh(f"{pid}_frame", frame, c("frame", "#5a4a3c"), root, outline=0.01, smooth=False)
        self.mesh(f"{pid}_beam", S.box([1.5, 0.22, 0.32]), c("beam", "#f2efe6"), root, (0, -0.05, 0.75), outline=0.012, smooth=False)
        stripes = S.new_bm()
        for k in range(4):
            S.add_box(stripes, (0.18, 0.02, 0.3), (-0.55 + k * 0.37, -0.165, 0.75), (0, 30, 0))
        self.mesh(f"{pid}_stripes", stripes, c("stripe", "#d8423a"), root, outline=0.0, smooth=False)

    def paths(self):
        """Each path as a poly curve `path:<id>` on the ground (z 0) along its centre line, tagged with its kind, width, length and running
        surface. Returns the `build.json` record of each."""
        out = {}
        for pid, path in sorted((self.spec.get("paths") or {}).items()):
            pts = [[float(x), float(y)] for x, y in path["points"]]
            cd = bpy.data.curves.new(f"path:{pid}", "CURVE")
            cd.dimensions = "3D"
            sp = cd.splines.new("POLY")
            sp.points.add(len(pts) - 1)
            for pt, (x, y) in zip(sp.points, pts):
                pt.co = (x, y, 0.0, 1.0)
            ob = bpy.data.objects.new(f"path:{pid}", cd)
            ob.hide_render = True
            self.coll.objects.link(ob)
            width, length = path_width(path), round(polyline_length(pts), 4)
            surface = RAIL_TOP if path["kind"] == "track" else ROAD_TOP
            self.tag(ob, cts_path=pid, cts_path_kind=path["kind"], cts_path_width=width, cts_path_length=length, cts_path_surface=surface)
            out[pid] = {"kind": path["kind"], "points": pts, "width": width, "length": length, "surface": surface}
            if path["kind"] == "track":
                out[pid]["gauge"] = round(gauge(width), 4)
        return out

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

# road and rail (CTS-33): heights in metres above the ground
ROAD_TOP = 0.012  # the asphalt top: above the ground patches (< 1 cm), below the blob shadows (1.5 cm)
KERB_TOP = 0.03
DASH = 1.0  # centre dashes 1 m long with 1 m gaps
BALLAST_TOP = 0.06
SLEEPER_TOP = 0.12
SLEEPER_STEP = 0.6
RAIL_W = 0.07
RAIL_TOP = 0.2  # where a train's wheel bottoms run (build.json `railTop`, `cts_path_surface` on a track curve)
PATH_WIDTH_DEFAULT = {"road": 3.0, "track": 1.6}  # = contracts.ts PATH_WIDTH_DEFAULT
PATH_PROPS = {"road": "road", "track": "track"}  # = contracts.ts PATH_PROP_KINDS


def path_width(path):
    return float(path.get("width") or PATH_WIDTH_DEFAULT[path["kind"]])


def gauge(width):
    """Rail centre to rail centre: 0.6 of the track's width (0.96 m at the default 1.6 m)."""
    return 0.6 * width


def polyline_length(pts):
    return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:]))


def point_at(pts, s):
    """The point at arc length `s` along a polyline and the yaw in degrees of its segment there."""
    for i, (a, b) in enumerate(zip(pts, pts[1:])):
        seg = math.hypot(b[0] - a[0], b[1] - a[1])
        if s <= seg or i == len(pts) - 2:
            u = 0.0 if seg == 0 else min(1.0, max(0.0, s / seg))
            return (a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])), math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))
        s -= seg
    return tuple(pts[-1]), 0.0


def nearest_path(spec, at, kind):
    """(id, distance, unit direction of the nearest segment) of the path of this kind nearest to a ground point, or None."""
    best = None
    for pid, path in sorted((spec.get("paths") or {}).items()):
        if path["kind"] != kind:
            continue
        pts = path["points"]
        for a, b in zip(pts, pts[1:]):
            dx, dy = b[0] - a[0], b[1] - a[1]
            l2 = dx * dx + dy * dy
            u = 0.0 if l2 == 0 else max(0.0, min(1.0, ((at[0] - a[0]) * dx + (at[1] - a[1]) * dy) / l2))
            d = math.hypot(at[0] - (a[0] + u * dx), at[1] - (a[1] + u * dy))
            if best is None or d < best[1]:
                n = math.sqrt(l2) or 1.0
                best = (pid, d, (dx / n, dy / n))
    return best


def ribbon(pts, lo, hi, z0, z1, bm=None, taper=0.0):
    """A closed strip along a polyline: the cross-section spans the offsets lo..hi (metres to the left of the direction of travel) and the
    heights z0..z1, with mitred corners; `taper` narrows the top on each side (a ballast bed). Added to `bm` when one is given."""
    import bmesh

    bm = bm if bm is not None else S.new_bm()
    n = len(pts)
    normals = []
    for i in range(n - 1):
        dx, dy = pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]
        ln = math.hypot(dx, dy) or 1.0
        normals.append((-dy / ln, dx / ln))
    rings = []
    for i in range(n):
        a, b = normals[max(0, i - 1)], normals[min(i, n - 2)]
        mx, my = a[0] + b[0], a[1] + b[1]
        ml = math.hypot(mx, my) or 1.0
        mx, my = mx / ml, my / ml
        k = 1.0 / max(0.3, mx * b[0] + my * b[1])
        x, y = pts[i]
        rings.append([bm.verts.new((x + mx * off * k, y + my * off * k, z)) for off, z in ((lo, z0), (hi, z0), (hi - taper, z1), (lo + taper, z1))])
    for r0, r1 in zip(rings, rings[1:]):
        for j in range(4):
            bm.faces.new((r0[j], r0[(j + 1) % 4], r1[(j + 1) % 4], r1[j]))
    bm.faces.new(tuple(reversed(rings[0])))
    bm.faces.new(tuple(rings[-1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


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
    paths = b.paths()
    b.marks()
    b.cameras()
    bpy.context.view_layer.update()
    return {"collection": b.coll, "objects": list(b.coll.objects), "warnings": warnings_for(spec), "paths": paths, "crossings": b.crossings}


PATH_LINE = {"road": (1.0, 0.62, 0.1), "track": (0.15, 0.45, 0.95)}


def add_plan_view(spec, out_dir, sheet):
    """When the set has paths: renders the set from straight above (clouds hidden) into `sheet/plan.png`, draws each path's centre line
    (orange road, blue track) with its id, and each mark as a dot with its name, and adds it to `sheet.png` as a third row."""
    if not spec.get("paths"):
        return sheet
    from . import sheets

    sc = bpy.context.scene
    w, d = spec["ground"]["size"]
    tw, th = 2048, 576
    scale = max(w, d * tw / th) * 1.04
    cd = bpy.data.cameras.new("sheet_cam_plan")
    cd.type, cd.ortho_scale, cd.clip_end = "ORTHO", scale, 200.0
    cam = bpy.data.objects.new("sheet_cam_plan", cd)
    sc.collection.objects.link(cam)
    cam.location, cam.rotation_euler = (0.0, 0.0, 60.0), (0.0, 0.0, 0.0)
    hidden = [o for o in bpy.data.objects if o.get("cts_kind") == "cloud" or (o.parent and o.parent.get("cts_kind") == "cloud")]
    for o in hidden:
        o.hide_render = True
    sc.camera = cam
    rx, ry = sc.render.resolution_x, sc.render.resolution_y
    sc.render.resolution_x, sc.render.resolution_y = tw, th
    path = os.path.join(out_dir, "sheet", "plan.png")
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    sc.render.resolution_x, sc.render.resolution_y = rx, ry
    for o in hidden:
        o.hide_render = False
    tile = sheets.load_pixels(path)

    def px(x, y):
        return int(round(tw / 2 + x / scale * tw)), int(round(th / 2 - y / scale * tw))

    def dot(x, y, r, colour):
        cx, cy = px(x, y)
        tile[max(0, cy - r) : max(0, cy + r + 1), max(0, cx - r) : max(0, cx + r + 1), :3] = colour

    def label(text, x, y, colour):
        cx, cy = px(x, y)
        cx, cy = min(max(2, cx + 8), tw - 2 - 12 * len(text)), min(max(2, cy - 7), th - 16)
        tile[cy - 2 : cy + 16, cx - 2 : cx + 12 * len(text), :3] = (1.0, 1.0, 1.0)
        sheets.draw_label(tile, text, cx, cy, scale=2, colour=colour)

    for pid, p in sorted(spec["paths"].items()):
        colour = PATH_LINE[p["kind"]]
        pts = p["points"]
        for a, b in zip(pts, pts[1:]):
            n = max(2, int(math.hypot(b[0] - a[0], b[1] - a[1]) / scale * tw))
            for k in range(n + 1):
                u = k / n
                dot(a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1]), 1, colour)
        (mx, my), yaw = point_at(pts, polyline_length(pts) * 0.35)
        off = path_width(p) / 2 + 0.6  # to the right of the strip, clear of the marks on its centre line
        label(f"{pid} {p['kind']}", mx + math.sin(math.radians(yaw)) * off, my - math.cos(math.radians(yaw)) * off, colour)
    for name, (x, y) in sorted(spec["marks"].items()):
        dot(x, y, 4, (0.85, 0.2, 0.15))
        label(name, x, y, (0.16, 0.13, 0.1))
    sheets.draw_label(tile, "PLAN - PATHS AND MARKS", 10, 10)
    sheets.save_pixels(path, tile)
    top = sheets.load_pixels(sheet["file"])
    canvas = np.ones((top.shape[0] + th, tw, 4), dtype=np.float32)
    canvas[: top.shape[0]] = top
    canvas[top.shape[0] :] = tile
    sheets.save_pixels(sheet["file"], canvas)
    sheet["tiles"] = list(sheet.get("tiles", [])) + ["plan"]
    return sheet


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
        "paths": built["paths"],
        "railTop": RAIL_TOP,
        "crossings": built["crossings"],
    }
    sheet = None
    if job.get("sheet", True):
        from . import sheets

        progress(1, 3, "sheet")
        sheet = add_plan_view(spec, out, sheets.set_sheet(spec, style, out))
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
    info = add_plan_view(spec, job["outDir"], sheets.set_sheet(spec, M.load_style(job.get("style")), job["outDir"]))
    return {"sheet": info["file"], "seconds": info["seconds"]}
