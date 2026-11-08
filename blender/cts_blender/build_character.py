# SPDX-License-Identifier: GPL-3.0-or-later
"""The character builder (HUB-30 decisions 2, 3 and 6): `cast/<id>/character.json` (cts.character3d/1) -> `character.blend`.

A character is a collection `char_<id>` of parented empties (the controls) and rigid primitive parts hanging on them. No armature: every motion is
keyed on the empties by name (`rig["head"]`). The face (eyes, pupils, lids, brows, the six mouth slots) is built from `face` in the spec.

Conventions the sheets and the acting library share:
- A character faces -y at yaw 0 (the camera looks along +y). `_L` controls and parts sit at -x (the viewer's left), `_R` at +x.
- A lid control is scaled (0.001) when the eye is open and (1, 1, 1) when it is closed; `lid_pose` gives the in-between (half lid).
- A mouth slot is shown by scale 1 and hidden by scale 0.0001; the `rest` slot is a smile arc, scale z -1 turns it into a frown.
- A pupil control moves in the head's x and z (offset from its rest place).
- Objects carry `cts_character` (the id), controls `cts_control` (their name), mouth slots `cts_mouth` (the slot name).

E_FACE_HIDDEN: a ray from the front at each eye and the mouth must find the feature in front of the head, not buried in a part.
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

SLOTS = ("rest", "A", "E", "O", "U", "MBP")
MOUTH_BASE = 0.048  # the half width of the open `A` mouth at scale 1 (the probe's value); `face.mouth.scale` is that half width in metres
EYE_Y, EYE_Z, EYE_X = 0.6, 1.12, 0.9  # eyeball radii as fractions of the eye radius
MIN_PROTRUDE = 0.2  # a feature must stand at least this fraction of its depth in front of the surface
FLOAT_WARN = 0.008  # a feature this far (m) in front of the surface looks stuck on


def spec_hash(path):
    with open(path, "rb") as f:
        return hashlib.sha1(f.read()).hexdigest()


def read_spec(path):
    with open(path, "r", encoding="utf-8") as f:
        spec = json.load(f)
    if spec.get("schema") != "cts.character3d/1":
        raise CtsError("E_SPEC_INVALID", f"{path}: not a cts.character3d/1 file")
    return spec


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return bpy.context.scene


def tag(ob, cid, **props):
    ob["cts_character"] = cid
    for k, v in props.items():
        ob[k] = v
    return ob


def lid_pose(amount, eye_r):
    """(location z offset, scale) of a lid control: 0 is open, 1 is closed, between is a lid coming down from the top of the eye."""
    if amount <= 0.02:
        return 0.0, (0.001, 0.001, 0.001)
    a = min(1.0, amount)
    return 1.2 * eye_r * (1 - a), (1.0, 1.0, max(0.001, a))


def find_rig(cid):
    """The controls and mouth slots of a built character in the current file."""
    coll = bpy.data.collections.get(f"char_{cid}")
    if coll is None:
        raise CtsError("E_SPEC_INVALID", f"no character {cid!r} in this file")
    controls = {ob["cts_control"]: ob for ob in coll.objects if "cts_control" in ob}
    slots = {ob["cts_mouth"]: ob for ob in coll.objects if "cts_mouth" in ob}
    return {"id": cid, "collection": coll, "controls": controls, "slots": slots, "objects": list(coll.objects)}


def show_mouth(rig, slot, frown=False):
    """Shows one mouth slot and hides the others (`frown` turns the `rest` smile upside down)."""
    for k, ob in rig["slots"].items():
        if k == slot:
            ob.scale = (1.0, 1.0, -1.0 if (frown and k == "rest") else 1.0)
        else:
            ob.scale = (0.0001, 0.0001, 0.0001)


# ---------------------------------------------------------------- build


def _controls(spec, cid, coll):
    ctl = {}
    pending = dict(spec["controls"])
    depth = {}

    def d(name):
        if name not in depth:
            parent = pending[name]["parent"]
            depth[name] = 0 if parent is None else 1 + d(parent)
        return depth[name]

    for name in sorted(pending, key=lambda n: (d(n), n)):
        c = pending[name]
        parent = ctl[c["parent"]] if c["parent"] else None
        e = S.empty(f"{cid}_{name}", parent, tuple(c["at"]), tuple(c.get("rot", (0, 0, 0))), collection=coll)
        tag(e, cid, cts_control=name)
        ctl[name] = e
    return ctl


def _part(cid, part, spec, style, ctl, coll, label="part"):
    pal = spec["palette"]
    if part["colour"] not in pal:
        raise CtsError("E_SPEC_INVALID", f"part {part['id']}: colour {part['colour']!r} is not in the palette")
    if part["control"] not in ctl:
        raise CtsError("E_SPEC_INVALID", f"part {part['id']}: control {part['control']!r} does not exist")
    bm = S.mesh_for(part)
    mat = M.toon(style, pal[part["colour"]], 0.7 if part["shape"] == "spines" else None)
    ob = S.make_object(f"{cid}_{label}_{part['id']}", bm, mat, ctl[part["control"]], tuple(part["at"]), tuple(part.get("rot", (0, 0, 0))), bevel=min(0.015, 0.35 * min(S.extent(part))) if part["shape"] == "box" else 0.0, collection=coll)
    tag(ob, cid, cts_part=part["id"])
    ob["cts_outline"] = part["outline"] if "outline" in part else M.default_outline_width(S.extent(part))
    return ob


def _face(cid, spec, style, ctl, coll):
    f = spec["face"]
    eyes, mouth, pal = f["eyes"], f["mouth"], spec["palette"]
    r, ex, ey, ez = eyes["r"], eyes["x"], eyes["faceY"], eyes["z"]
    head = ctl["head"]
    for need in ("lid_L", "lid_R", "pupil_L", "pupil_R", "mouth"):
        if need not in ctl:
            raise CtsError("E_SPEC_INVALID", f"face needs the control {need!r}")
    if f["lids"]["colour"] not in pal:
        raise CtsError("E_SPEC_INVALID", f"lids colour {f['lids']['colour']!r} is not in the palette")
    white, ink = M.toon(style, "#ffffff", 0.86), M.flat(M.INK)
    objs = {"eyes": [], "mouth": []}

    def mk(name, bm, mat, parent, loc, rot=(0, 0, 0), outline=0.0, **props):
        ob = S.make_object(f"{cid}_f_{name}", bm, mat, parent, tuple(loc), rot, collection=coll)
        tag(ob, cid, cts_face=name, **props)
        ob["cts_outline"] = outline
        return ob

    for side, sx in (("L", -1), ("R", 1)):
        centre = Vector((sx * ex, ey, ez))
        lid, pupil = ctl[f"lid_{side}"], ctl[f"pupil_{side}"]
        eyeball = mk(f"eyeball_{side}", S.ellipsoid([EYE_X * r, EYE_Y * r, EYE_Z * r]), white, head, centre, outline=M.default_outline_width((r, r, r)) * 0.75)
        objs["eyes"].append(eyeball)
        ps = eyes["pupil"]["size"]
        front = centre + Vector((0, -EYE_Y * r - eyes["pupil"]["lead"] + 0.545 * ps, 0))
        mk(f"pupil_{side}", S.ellipsoid([ps, 0.545 * ps, 1.236 * ps]), M.flat("#2b1a14"), pupil, front - Vector(spec["controls"][f"pupil_{side}"]["at"]))
        shine = centre + Vector((-0.22 * r, -0.78 * r, 0.32 * r))
        mk(f"shine_{side}", S.ellipsoid([0.17 * r]), M.flat("#ffffff"), pupil, shine - Vector(spec["controls"][f"pupil_{side}"]["at"]))
        off = centre - Vector(spec["controls"][f"lid_{side}"]["at"])
        mk(f"lidskin_{side}", S.ellipsoid([0.98 * r, 0.95 * r, 1.2 * r]), M.toon(style, pal[f["lids"]["colour"]]), lid, off, outline=M.default_outline_width((r, r, r)) * 0.75)
        mk(f"lash_{side}", S.arc([0.75 * r, 0.12 * r, 140]), ink, lid, off + Vector((0, -0.9 * r, -0.2 * r)))
        lid.scale = (0.001, 0.001, 0.001)
    if f.get("brows"):
        b = f["brows"]
        if b["colour"] not in pal:
            raise CtsError("E_SPEC_INVALID", f"brows colour {b['colour']!r} is not in the palette")
        for side, sx in (("L", -1), ("R", 1)):
            at = Vector((sx * abs(b["at"][0]), b["at"][1], b["at"][2]))
            name = f"brow_{side}"
            if name not in ctl:
                e = S.empty(f"{cid}_{name}", head, tuple(at), collection=coll)
                tag(e, cid, cts_control=name)
                ctl[name] = e
            off = at - Vector(ctl[name].location)
            mk(f"brow_{side}", S.capsule([0.13 * b["length"], b["length"]]), M.toon(style, pal[b["colour"]]), ctl[name], off, (0, 90 - sx * 8, 0), outline=0.0)
    s = mouth["scale"] / MOUTH_BASE
    dy = max(0.004, 0.014 * s)
    mc = ctl["mouth"]
    off = Vector(mouth["at"]) - Vector(spec["controls"]["mouth"]["at"])
    inner = M.flat(mouth["inner"], "mouth_inner_" + mouth["inner"].lstrip("#").lower())
    tongue = M.toon(style, mouth["tongue"], 0.8) if mouth.get("tongue") else None
    for slot in SLOTS:
        if slot == "rest":
            bm, mat = S.arc([0.045 * s, 0.009 * s, 140]), ink
        elif slot == "MBP":
            bm, mat = S.ellipsoid([0.05 * s, dy * 0.86, 0.011 * s]), ink
        else:
            sx_, sz_ = {"A": (0.048, 0.055), "E": (0.062, 0.026), "O": (0.036, 0.046), "U": (0.022, 0.028)}[slot]
            bm, mat = S.ellipsoid([sx_ * s, dy, sz_ * s]), inner
        ob = mk(f"mouth_{slot}", bm, mat, mc, off, cts_mouth=slot)
        sc = 1.0 if slot == "rest" else 0.0001
        ob.scale = (sc, sc, sc)
        objs["mouth"].append(ob)
        if tongue and slot in ("A", "O"):
            sx_, sz_ = {"A": (0.048, 0.055), "O": (0.036, 0.046)}[slot]
            t = S.make_object(f"{cid}_f_mouth_{slot}_tongue", S.ellipsoid([sx_ * s * 0.6, 0.008 * s, sz_ * s * 0.35]), tongue, ob, (0, -0.008 * s, -sz_ * s * 0.55), collection=coll)
            tag(t, cid, cts_face=f"mouth_{slot}_tongue")
            t["cts_outline"] = 0.0
    return objs


def _world_pos(head, local):
    return head.matrix_world @ Vector(local)


def _front_hit(parts, origin, direction):
    """The least distance along the ray at which any part's surface is hit, or None."""
    best = None
    for ob in parts:
        inv = ob.matrix_world.inverted()
        o = inv @ origin
        d = (inv.to_3x3() @ direction).normalized()
        hit, loc, _n, _i = ob.ray_cast(o, d)
        if hit:
            t = ((ob.matrix_world @ loc) - origin).dot(direction)
            if best is None or t < best:
                best = t
    return best


def check_face(spec, ctl, part_objs):
    """Ray test (E_FACE_HIDDEN): at each eye and the mouth, how far in front of the first part surface the feature stands. Returns warnings."""
    bpy.context.view_layer.update()
    f = spec["face"]
    eyes, mouth = f["eyes"], f["mouth"]
    head = ctl["head"]
    direction = (head.matrix_world.to_3x3() @ Vector((0, 1, 0))).normalized()
    s = mouth["scale"] / MOUTH_BASE
    dy = max(0.004, 0.014 * s)
    r = eyes["r"]
    features = [
        (f"eye_{side}", Vector((sx * eyes["x"], eyes["faceY"], eyes["z"])), EYE_Y * r) for side, sx in (("L", -1), ("R", 1))
    ] + [("mouth", Vector(mouth["at"]), dy)]
    warnings = []
    for name, local, half_depth in features:
        centre = _world_pos(head, local)
        origin = centre - direction * 5.0
        t_centre = 5.0
        t_front = t_centre - half_depth
        hit = _front_hit(part_objs, origin, direction)
        if hit is None:
            continue
        protrude = hit - t_front  # how far the feature's front is ahead of the surface
        if protrude < MIN_PROTRUDE * 2 * half_depth:
            raise CtsError("E_FACE_HIDDEN", f"the {name.replace('_', ' ')} is buried in the head: its front is {protrude * 1000:.1f} mm in front of the surface (needs {MIN_PROTRUDE * 2 * half_depth * 1000:.1f} mm). Move it forward (more negative y) or shrink the part in front of it.")
        gap = hit - (t_centre + half_depth)  # how far the feature's back is in front of the surface
        if gap > FLOAT_WARN:
            warnings.append(f"the {name.replace('_', ' ')} floats {gap * 1000:.0f} mm in front of the surface: move it back (less negative y) so it sits on the face")
    return warnings


def _bbox(objs):
    lo, hi = Vector((1e9,) * 3), Vector((-1e9,) * 3)
    for ob in objs:
        if ob.type != "MESH":
            continue
        for c in ob.bound_box:
            w = ob.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    return lo, hi


def build_character(spec, style):
    """Builds the character in the current scene. Returns {rig, warnings, bbox}."""
    cid = spec["id"]
    sc = bpy.context.scene
    coll = bpy.data.collections.new(f"char_{cid}")
    sc.collection.children.link(coll)
    ctl = _controls(spec, cid, coll)
    parts = [_part(cid, p, spec, style, ctl, coll) for p in spec["parts"]]
    for p in spec.get("accessories") or []:
        parts.append(_part(cid, p, spec, style, ctl, coll, "acc"))
    face = _face(cid, spec, style, ctl, coll)
    warnings = check_face(spec, ctl, parts)
    for ob in parts + [o for o in coll.objects if "cts_face" in o]:
        M.add_outline(ob, ob.get("cts_outline", 0.0), style)
    bpy.context.view_layer.update()
    lo, hi = _bbox(parts)
    shadow = M.blob_shadow(f"{cid}_shadow", (max(0.05, (hi.x - lo.x) / 2 * 1.15 + 0.03), max(0.05, (hi.y - lo.y) / 2 * 1.15 + 0.03)), style, ctl["root"], collection=coll)
    shadow.location = ((hi.x + lo.x) / 2, (hi.y + lo.y) / 2, shadow.location.z)
    tag(shadow, cid, cts_shadow=True)
    bpy.context.view_layer.update()
    return {"rig": find_rig(cid), "warnings": warnings, "bbox": [list(lo), list(hi)], "face": face}


@command("build-character")
def build_character_command(job):
    """job: {spec, style?, outDir, sheet?: bool}. Writes outDir/character.blend and outDir/build.json (and the sheet when `sheet` is not false)."""
    t0 = time.perf_counter()
    spec_path, out = job["spec"], job["outDir"]
    os.makedirs(out, exist_ok=True)
    spec = read_spec(spec_path)
    style = M.load_style(job.get("style"))
    progress(0, 3, "build")
    reset_scene()
    built = build_character(spec, style)
    rig = built["rig"]
    blend = os.path.join(out, "character.blend")
    fp = fingerprint(rig["objects"])
    bpy.ops.wm.save_as_mainfile(filepath=blend, compress=True)
    info = {
        "schema": "cts.character-build/1",
        "id": spec["id"],
        "specHash": spec_hash(spec_path),
        "blender": bpy.app.version_string,
        "controls": sorted(rig["controls"]),
        "mouthSlots": [s for s in SLOTS if s in rig["slots"]],
        "objects": fp["count"],
        "hash": {"objects": fp["objects"], "controls": fp["controls"], "keys": fp["keys"]},
        "height": round(built["bbox"][1][2] - built["bbox"][0][2], 3),
        "warnings": built["warnings"],
        "buildSeconds": round(time.perf_counter() - t0, 2),
    }
    sheet_info = None
    if job.get("sheet", True):
        from . import sheets

        progress(1, 3, "sheet")
        sheet_info = sheets.character_sheet(rig, spec, style, out)
        info["sheet"] = sheet_info
        info["buildSeconds"] = round(time.perf_counter() - t0, 2)
    with open(os.path.join(out, "build.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(info, f, indent=2)
        f.write("\n")
    progress(3, 3, "done")
    return {"blend": blend, "build": os.path.join(out, "build.json"), "sheet": sheet_info and sheet_info["file"], "warnings": built["warnings"], "buildSeconds": info["buildSeconds"], "specHash": info["specHash"], "hash": info["hash"]}
