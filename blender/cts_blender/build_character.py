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

Vehicles (HUB-31, `kind: "vehicle"`, decision 10): the same controls without arms or legs (an arm, hand or leg control is E_VEHICLE_LIMB), plus
- wheels: every `vehicle.wheels` control carries a cylinder tyre (the spec's, or a default one) with a hub and bolts on its outer face; a wheel spins
  about its control's local x (`rotation_euler[0]`; + is rolling forward, towards -y): build.json `vehicle.wheels[]` has the axis and radius;
- lamp eyes: a lens dome (the eyeball) in a rim, seated in a pod in the lid colour; the hood (the lid) works as a creature's lid; a dark pupil disc
  on `pupil_L/R`; a chrome visor on `brow_L/R`; the lens glows with `head["lamp_glow"]` (0..1, a driver feeds the lamp material);
- the bumper-mouth: the six slots `rest A E O U MBP` as rounded slots, swapped by scale exactly as a creature's mouth;
- a puff pool of 8 clouds on `chimney` and on `exhaust` (scale 0.0001 at rest; `cts_puff` index, `cts_puff_source` control);
- `antenna1..n` must be a chain (each the parent of the next).
"""
import hashlib
import json
import math
import os
import re
import time

import bpy
from mathutils import Euler, Vector

from . import command, materials as M, shapes as S
from .fingerprint import fingerprint
from .io import CtsError, progress

SLOTS = ("rest", "A", "E", "O", "U", "MBP")
MOUTH_BASE = 0.048  # the half width of the open `A` mouth at scale 1 (the probe's value); `face.mouth.scale` is that half width in metres
EYE_Y, EYE_Z, EYE_X = 0.6, 1.12, 0.9  # eyeball radii as fractions of the eye radius
MIN_PROTRUDE = 0.2  # a feature must stand at least this fraction of its depth in front of the surface
FLOAT_WARN = 0.008  # a feature this far (m) in front of the surface looks stuck on

# HUB-31 vehicles
LAMP_PROP = "lamp_glow"  # a custom property (0..1) on the `head` control: the glow of both lamp eyes, keyed by the acting library
PUFF_COUNT = 8  # cloud puffs in the pool of each puff source (`chimney`, `exhaust`), hidden (scale 0.0001) at rest
PUFF_SOURCES = ("chimney", "exhaust")
LIMB_RE = re.compile(r"^(arm|hand|leg)_")
ANTENNA_RE = re.compile(r"^antenna(\d+)$")
TYRE_HEX, HUB_HEX = "#3b302a", "#e8dcc0"  # when the spec gives no tyre part or no hub colour (palette `hub`, else `cream`, `chrome`, `brass`)
PUFF_HEX = "#f7f4ec"


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


def is_vehicle(spec):
    return spec.get("kind") == "vehicle"


def find_rig(cid):
    """The controls and mouth slots of a built character in the current file. A vehicle also has `puffs` ({source control: [8 cloud objects]}) and
    `lamp` (the control that carries the `lamp_glow` property, or None)."""
    coll = bpy.data.collections.get(f"char_{cid}")
    if coll is None:
        raise CtsError("E_SPEC_INVALID", f"no character {cid!r} in this file")
    controls = {ob["cts_control"]: ob for ob in coll.objects if "cts_control" in ob}
    slots = {ob["cts_mouth"]: ob for ob in coll.objects if "cts_mouth" in ob}
    puffs = {}
    for ob in sorted((o for o in coll.objects if "cts_puff" in o), key=lambda o: (o["cts_puff_source"], o["cts_puff"])):
        puffs.setdefault(ob["cts_puff_source"], []).append(ob)
    lamp = next((ob for ob in controls.values() if LAMP_PROP in ob), None)
    return {"id": cid, "collection": coll, "controls": controls, "slots": slots, "objects": list(coll.objects), "kind": coll.get("cts_kind", "creature"), "puffs": puffs, "lamp": lamp}


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
    vehicle_box = part["shape"] == "box" and is_vehicle(spec)
    if vehicle_box:  # HUB-31: a vehicle's boxes are rounded (a loaf, a flat rounded-rectangle nose): 30 % of the smallest side, up to 30 cm
        bevel = min(0.3, 0.3 * min(S._radii3(part["size"])))
    else:
        bevel = min(0.015, 0.35 * min(S.extent(part))) if part["shape"] == "box" else 0.0
    ob = S.make_object(f"{cid}_{label}_{part['id']}", bm, mat, ctl[part["control"]], tuple(part["at"]), tuple(part.get("rot", (0, 0, 0))), bevel=bevel, collection=coll)
    if vehicle_box:
        ob.modifiers["bevel"].segments = 5
        ob.modifiers["bevel"].harden_normals = True
    if part["shape"] == "cylinder":
        _crisp_cylinder(ob, S.extent(part))
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


# ---------------------------------------------------------------- vehicles (HUB-31)


def _crisp_cylinder(ob, ext):
    """A cylinder keeps its cap edges sharp (smooth sides, flat caps) with a small rounded rim."""
    ob.data.set_sharp_from_angle(angle=math.radians(40))
    w = min(0.03, 0.18 * min(ext[0], ext[2]))
    if w > 0.002:
        b = ob.modifiers.new("bevel", "BEVEL")
        b.width = w
        b.segments = 3
        b.limit_method = "ANGLE"
        b.harden_normals = True


def _mix_hex(a, b, t):
    ca = [int(a.lstrip("#")[i : i + 2], 16) for i in (0, 2, 4)]
    cb = [int(b.lstrip("#")[i : i + 2], 16) for i in (0, 2, 4)]
    return "#" + "".join(f"{round(x + (y - x) * t):02x}" for x, y in zip(ca, cb))


def lamp_material(style, cid, glow_hex, head):
    """The lens of the lamp eyes: a two-tone pale lens that turns into the glow colour, brighter, as `head["lamp_glow"]` goes from 0 to 1.
    A driver (type AVERAGE, no Python) copies the property into the material, so keying the property is enough."""
    name = f"lamp_{cid}"
    old = bpy.data.materials.get(name)
    if old is not None:
        bpy.data.materials.remove(old)
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    lens = M.lin(_mix_hex("#f4f1ea", glow_hex, 0.2))
    glow = M.lin(glow_hex)
    shade = 0.86
    d = nt.nodes.new("ShaderNodeBsdfDiffuse")
    s2r = nt.nodes.new("ShaderNodeShaderToRGB")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    cr = ramp.color_ramp
    cr.interpolation = "CONSTANT"
    cr.elements[0].position = 0.0
    cr.elements[0].color = (lens[0] * shade, lens[1] * shade, lens[2] * shade, 1)
    cr.elements[1].position = style["toon"]["threshold"]
    cr.elements[1].color = lens
    val = nt.nodes.new("ShaderNodeValue")
    val.name = val.label = LAMP_PROP
    val.outputs[0].default_value = 0.0
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs[7].default_value = glow
    strength = nt.nodes.new("ShaderNodeMath")
    strength.operation = "MULTIPLY_ADD"
    strength.inputs[1].default_value = 0.25
    strength.inputs[2].default_value = 1.0
    em = nt.nodes.new("ShaderNodeEmission")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(d.outputs[0], s2r.inputs[0])
    nt.links.new(s2r.outputs["Color"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], mix.inputs[6])
    nt.links.new(val.outputs[0], mix.inputs[0])
    nt.links.new(val.outputs[0], strength.inputs[0])
    nt.links.new(mix.outputs[2], em.inputs["Color"])
    nt.links.new(strength.outputs[0], em.inputs["Strength"])
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    mat.diffuse_color = lens
    fc = val.outputs[0].driver_add("default_value")
    drv = fc.driver
    drv.type = "AVERAGE"
    var = drv.variables.new()
    var.name = "glow"
    var.type = "SINGLE_PROP"
    var.targets[0].id_type = "OBJECT"
    var.targets[0].id = head
    var.targets[0].data_path = f'["{LAMP_PROP}"]'
    return mat


def check_vehicle(spec):
    """The builder's own guard (lint says the same earlier): no limbs, a vehicle block whose wheels are controls, an antenna that is a chain."""
    controls = spec["controls"]
    for name in controls:
        if LIMB_RE.match(name):
            raise CtsError("E_VEHICLE_LIMB", f"a vehicle has no arms, hands or legs: remove the control {name!r}")
    v = spec.get("vehicle")
    if not v:
        raise CtsError("E_SPEC_INVALID", "a vehicle needs the vehicle block {type, wheelRadius, wheels, track}")
    for w in v["wheels"]:
        if w not in controls:
            raise CtsError("E_SPEC_INVALID", f"vehicle.wheels names {w!r}, which is not a control")
    links = sorted((int(m.group(1)), n) for n in controls for m in [ANTENNA_RE.match(n)] if m)
    for k, (i, n) in enumerate(links):
        if i != k + 1:
            raise CtsError("E_SPEC_INVALID", f"the antenna chain is antenna1, antenna2 ..: {n!r} is out of order")
        if k and controls[n]["parent"] != links[k - 1][1]:
            raise CtsError("E_SPEC_INVALID", f"{n} hangs on {controls[n]['parent']!r}; an antenna link hangs on the one before it ({links[k - 1][1]})")
    return [n for _, n in links]


def _vehicle_face(cid, spec, style, ctl, coll):
    """Lamp eyes, hoods, pupils, visors and the bumper-mouth slots (decision 10). Returns {eyes, mouth} like `_face`."""
    f = spec["face"]
    eyes, mouth, pal = f["eyes"], f["mouth"], spec["palette"]
    r, ex, ey, ez = eyes["r"], eyes["x"], eyes["faceY"], eyes["z"]
    head = ctl["head"]
    for need in ("lid_L", "lid_R", "pupil_L", "pupil_R", "mouth"):
        if need not in ctl:
            raise CtsError("E_SPEC_INVALID", f"face needs the control {need!r}")
    if f["lids"]["colour"] not in pal:
        raise CtsError("E_SPEC_INVALID", f"lids colour {f['lids']['colour']!r} is not in the palette")
    lamp = eyes.get("lamp") or {}
    rim_hex = pal.get(lamp.get("rim"), "#c9c9c9")
    head[LAMP_PROP] = 0.0
    head.id_properties_ui(LAMP_PROP).update(min=0.0, max=1.0, soft_min=0.0, soft_max=1.0, description="glow of the lamp eyes (0..1)")
    lens = lamp_material(style, cid, lamp.get("glow", "#fff2b0"), head)
    hood = M.toon(style, pal[f["lids"]["colour"]])
    rim = M.toon(style, rim_hex)
    ink = M.flat(M.INK)
    thin = M.default_outline_width((r, r, r)) * 0.75
    objs = {"eyes": [], "mouth": []}

    def mk(name, bm, mat, parent, loc, rot=(0, 0, 0), outline=0.0, **props):
        ob = S.make_object(f"{cid}_f_{name}", bm, mat, parent, tuple(loc), rot, collection=coll)
        tag(ob, cid, cts_face=name, **props)
        ob["cts_outline"] = outline
        return ob

    for side, sx in (("L", -1), ("R", 1)):
        centre = Vector((sx * ex, ey, ez))
        lid, pupil = ctl[f"lid_{side}"], ctl[f"pupil_{side}"]
        mk(f"lamp_pod_{side}", S.ellipsoid([1.1 * r, 1.25 * r, 1.0 * r]), hood, head, centre + Vector((0, 1.0 * r, -0.35 * r)), outline=thin)
        lensob = mk(f"eyeball_{side}", S.ellipsoid([r, EYE_Y * r, r]), lens, head, centre, outline=thin, cts_lamp=side)
        objs["eyes"].append(lensob)
        mk(f"lamp_rim_{side}", S.torus([r, 0.13 * r]), rim, head, centre + Vector((0, -0.05 * r, 0)), (90, 0, 0), outline=thin * 0.6)
        ps = eyes["pupil"]["size"]
        front = centre + Vector((0, -EYE_Y * r - eyes["pupil"]["lead"] + 0.28 * ps, 0))
        mk(f"pupil_{side}", S.ellipsoid([ps, 0.28 * ps, ps]), M.flat("#2b1a14"), pupil, front - Vector(spec["controls"][f"pupil_{side}"]["at"]))
        mk(f"shine_{side}", S.ellipsoid([0.14 * r, 0.07 * r, 0.14 * r]), M.flat("#ffffff"), head, centre + Vector((-0.3 * r, -0.6 * r, 0.36 * r)))
        off = centre - Vector(spec["controls"][f"lid_{side}"]["at"])
        mk(f"lidskin_{side}", S.ellipsoid([1.14 * r, 0.74 * r, 1.2 * r]), hood, lid, off, outline=thin)
        mk(f"lash_{side}", S.arc([0.85 * r, 0.1 * r, 140]), ink, lid, off + Vector((0, -0.72 * r, -0.2 * r)))
        lid.scale = (0.001, 0.001, 0.001)
    if f.get("brows"):
        b = f["brows"]
        if b["colour"] not in pal:
            raise CtsError("E_SPEC_INVALID", f"brows colour {b['colour']!r} is not in the palette")
        length = b["length"]
        R = (length / 2) / math.sin(math.radians(75))
        for side, sx in (("L", -1), ("R", 1)):
            at = Vector((sx * abs(b["at"][0]), b["at"][1], b["at"][2]))
            name = f"brow_{side}"
            if name not in ctl:
                e = S.empty(f"{cid}_{name}", head, tuple(at), collection=coll)
                tag(e, cid, cts_control=name)
                ctl[name] = e
            off = at - Vector(ctl[name].location)
            mk(f"brow_{side}", S.arc([R, 0.11 * length, 150]), M.toon(style, pal[b["colour"]]), ctl[name], off, (0, 180, 0), outline=thin * 0.6)
    s = mouth["scale"] / MOUTH_BASE
    dy = max(0.004, 0.014 * s)
    mc = ctl["mouth"]
    off = Vector(mouth["at"]) - Vector(spec["controls"]["mouth"]["at"])
    inner = M.flat(mouth["inner"], "mouth_inner_" + mouth["inner"].lstrip("#").lower())
    tongue = M.toon(style, mouth["tongue"], 0.8) if mouth.get("tongue") else None
    sizes = {"A": (0.048, 0.03), "E": (0.058, 0.014), "O": (0.032, 0.03), "U": (0.02, 0.018)}
    for slot in SLOTS:
        if slot == "rest":
            bm, mat = S.arc([0.087 * s, 0.0085 * s, 70]), ink
        elif slot == "MBP":
            bm, mat = S.rounded_slab(0.05 * s, dy * 0.86, 0.006 * s, 0.006 * s), ink
        else:
            hw, hh = sizes[slot]
            bm, mat = S.rounded_slab(hw * s, dy, hh * s, 0.6 * min(hw, hh) * s), inner
        ob = mk(f"mouth_{slot}", bm, mat, mc, off, cts_mouth=slot)
        sc = 1.0 if slot == "rest" else 0.0001
        ob.scale = (sc, sc, sc)
        objs["mouth"].append(ob)
        if tongue and slot in ("A", "O"):
            hw, hh = sizes[slot]
            t = S.make_object(f"{cid}_f_mouth_{slot}_tongue", S.ellipsoid([hw * s * 0.6, 0.008 * s, hh * s * 0.4]), tongue, ob, (0, -dy - 0.002, -hh * s * 0.5), collection=coll)
            tag(t, cid, cts_face=f"mouth_{slot}_tongue")
            t["cts_outline"] = 0.0
    return objs


def _hub_hex(pal):
    for k in ("hub", "cream", "chrome", "brass"):
        if k in pal:
            return pal[k]
    return HUB_HEX


def _wheels(cid, spec, style, ctl, coll):
    """Tyres (the spec's cylinder on each wheel control, or a default one), hubs with bolts on the outer face. Returns (info, objects, warnings)."""
    v, pal = spec["vehicle"], spec["palette"]
    R = float(v["wheelRadius"])
    hub_mat, bolt_mat = M.toon(style, _hub_hex(pal)), M.flat(M.INK)
    info, objs, warnings = [], [], []
    bpy.context.view_layer.update()
    for w in v["wheels"]:
        wc = ctl[w]
        c = spec["controls"][w]
        if any(abs(a) > 1e-6 for a in c.get("rot", (0, 0, 0))):
            warnings.append(f"{w} has a rotation: a wheel control should have none (it spins about its own x)")
        mine = [p for p in spec["parts"] if p["control"] == w and p["shape"] == "cylinder"]
        if mine:
            tyre = mine[0]
            rx, _ry, length = S._cyl3(tyre["size"])
            axis = Euler([math.radians(a) for a in tyre.get("rot", (0, 0, 0))]).to_matrix() @ Vector((0, 0, 1))
            if abs(axis.x) < 0.9:
                raise CtsError("E_SPEC_INVALID", f"wheel {w}: its tyre (part {tyre['id']}) must turn about x: give the cylinder rot [0, 90, 0]")
            centre = Vector(tyre["at"])
            radius = rx
            if abs(radius - R) > 0.01:
                warnings.append(f"wheel {w}: the tyre radius {radius:.2f} m differs from vehicle.wheelRadius {R:.2f} m (the roll uses wheelRadius)")
        else:
            length, centre, radius = 0.75 * R, Vector((0, 0, 0)), R
            ob = S.make_object(f"{cid}_wheel_{w}", S.cylinder((R, R, length)), M.toon(style, pal.get("tyre", TYRE_HEX)), wc, (0, 0, 0), (0, 90, 0), collection=coll)
            _crisp_cylinder(ob, (R, R, length / 2))
            tag(ob, cid, cts_wheel=w)
            ob["cts_outline"] = M.default_outline_width((R, R, R))
            objs.append(ob)
        wx = wc.matrix_world.translation.x
        sgn = -1.0 if wx < 0 else 1.0
        hub_r, hub_t = 0.56 * radius, max(0.012, 0.08 * radius)
        hub_at = centre + Vector((sgn * (length / 2 + hub_t / 2 - 0.002), 0, 0))
        hub = S.make_object(f"{cid}_hub_{w}", S.cylinder((hub_r, hub_r, hub_t)), hub_mat, wc, tuple(hub_at), (0, 90, 0), collection=coll)
        _crisp_cylinder(hub, (hub_r, hub_r, hub_t / 2))
        tag(hub, cid, cts_wheel=w)
        hub["cts_outline"] = M.default_outline_width((hub_r, hub_r, hub_r)) * 0.6
        bm = S.new_bm()
        for k in range(3):
            a = math.radians(90 + 120 * k)
            S.add_ellipsoid(bm, (0.012 + 0.03 * radius, 0.012 + 0.03 * radius, 0.012 + 0.03 * radius), (0, 0.3 * radius * math.cos(a), 0.3 * radius * math.sin(a)), seg=12)
        bolts = S.make_object(f"{cid}_bolts_{w}", bm, bolt_mat, wc, tuple(hub_at + Vector((sgn * hub_t / 2, 0, 0))), collection=coll)
        tag(bolts, cid, cts_wheel=w)
        bolts["cts_outline"] = 0.0
        objs += [hub, bolts]
        ground = wc.matrix_world.translation.z
        if abs(ground - R) > 0.02:
            warnings.append(f"wheel {w}: its centre is {ground:.2f} m high but wheelRadius is {R:.2f} m, so it does not touch the ground")
        info.append({"control": w, "radius": round(R, 4), "axis": "x", "index": 0, "forward": 1, "side": "L" if sgn < 0 else "R", "at": [round(x, 4) for x in wc.matrix_world.translation]})
    return info, objs, warnings


def _control_bbox(ctl_obj, objs):
    """The bounding box of objects hanging on a control, in the control's space (None when there are none)."""
    lo, hi = None, None
    for ob in objs:
        if ob.parent is not ctl_obj or ob.type != "MESH":
            continue
        for corner in ob.bound_box:
            p = ob.matrix_basis @ Vector(corner)
            lo = p.copy() if lo is None else Vector(map(min, lo, p))
            hi = p.copy() if hi is None else Vector(map(max, hi, p))
    return lo, hi


def _puffs(cid, style, ctl, coll, parts):
    """The puff pool: 8 cloud objects on each of `chimney` and `exhaust`, at the outlet (the chimney top; the exhaust's rear end), hidden at rest."""
    mat = M.toon(style, PUFF_HEX, 0.88)
    info, objs = {}, []
    for src in PUFF_SOURCES:
        if src not in ctl:
            continue
        lo, hi = _control_bbox(ctl[src], parts)
        if lo is None:
            outlet, rp = Vector((0, 0, 0)), 0.1
        elif src == "chimney":
            outlet, rp = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, hi.z)), max(0.08, 0.8 * max(hi.x - lo.x, hi.y - lo.y))
        else:
            outlet, rp = Vector(((lo.x + hi.x) / 2, hi.y, (lo.z + hi.z) / 2)), max(0.06, 0.9 * max(hi.x - lo.x, hi.z - lo.z))
        names = []
        for i in range(PUFF_COUNT):
            bm = S.new_bm()
            S.add_ellipsoid(bm, (rp, rp * 0.9, rp * 0.85), (0, 0, 0))
            S.add_ellipsoid(bm, (rp * 0.7, rp * 0.65, rp * 0.6), (rp * 0.6, 0.1 * rp, -0.15 * rp))
            S.add_ellipsoid(bm, (rp * 0.65, rp * 0.6, rp * 0.6), (-0.55 * rp, -0.05 * rp, -0.1 * rp))
            ob = S.make_object(f"{cid}_puff_{src}_{i}", bm, mat, ctl[src], tuple(outlet), collection=coll)
            ob.scale = (0.0001, 0.0001, 0.0001)
            tag(ob, cid, cts_puff=i, cts_puff_source=src)
            ob["cts_outline"] = M.default_outline_width((rp, rp, rp)) * 0.5
            objs.append(ob)
            names.append(ob.name)
        info[src] = {"count": PUFF_COUNT, "outlet": [round(x, 4) for x in outlet], "radius": round(rp, 4), "objects": names}
    return info, objs


def _world_pos(head, local):
    return head.matrix_world @ Vector(local)


def _front_hit(parts, origin, direction, inside=False):
    """The least distance along the ray at which any part's surface is hit, or None. With `inside`: (distance, True when the first surface
    hit is a back face, i.e. the origin is inside that part)."""
    best, back = None, False
    for ob in parts:
        inv = ob.matrix_world.inverted()
        o = inv @ origin
        d = (inv.to_3x3() @ direction).normalized()
        hit, loc, nrm, _i = ob.ray_cast(o, d)
        if hit:
            t = ((ob.matrix_world @ loc) - origin).dot(direction)
            if best is None or t < best:
                best = t
                back = (ob.matrix_world.inverted().transposed().to_3x3() @ nrm).dot(direction) > 0
    return (best, back) if inside else best


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
    vehicle = is_vehicle(spec)
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
        if vehicle and name.startswith("eye_"):
            continue  # a lamp stands in its pod; the pod must rest on the body (checked below)
        if gap > FLOAT_WARN:
            warnings.append(f"the {name.replace('_', ' ')} floats {gap * 1000:.0f} mm in front of the surface: move it back (less negative y) so it sits on the face")
    if vehicle:
        down = -(head.matrix_world.to_3x3() @ Vector((0, 0, 1))).normalized()
        for side, sx in (("L", -1), ("R", 1)):
            pod_low = _world_pos(head, Vector((sx * eyes["x"], eyes["faceY"] + r, eyes["z"] - 1.35 * r)))
            hit, inside = _front_hit(part_objs, pod_low - down * 0.2 * r, down, inside=True)
            if not inside and (hit is None or hit > 1.4 * r):
                warnings.append(f"the {side} lamp floats above the body: lower it (face.eyes.z) or raise the wing or nose under it")
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
    vehicle = is_vehicle(spec)
    antenna = check_vehicle(spec) if vehicle else []
    sc = bpy.context.scene
    coll = bpy.data.collections.new(f"char_{cid}")
    coll["cts_kind"] = "vehicle" if vehicle else "creature"
    sc.collection.children.link(coll)
    ctl = _controls(spec, cid, coll)
    parts = [_part(cid, p, spec, style, ctl, coll) for p in spec["parts"]]
    for p in spec.get("accessories") or []:
        parts.append(_part(cid, p, spec, style, ctl, coll, "acc"))
    face = (_vehicle_face if vehicle else _face)(cid, spec, style, ctl, coll)
    warnings = check_face(spec, ctl, parts)
    extras, vinfo = [], None
    if vehicle:
        wheels, extras, wwarn = _wheels(cid, spec, style, ctl, coll)
        puffs, puff_objs = _puffs(cid, style, ctl, coll, parts)
        warnings += wwarn
        if antenna and not any(p["control"] == antenna[-1] for p in spec["parts"] + list(spec.get("accessories") or [])):
            warnings.append(f"nothing hangs on {antenna[-1]}: the pennant belongs on the last antenna link")
        v = spec["vehicle"]
        vinfo = {"type": v["type"], "track": v["track"], "wheelRadius": v["wheelRadius"], "wheels": wheels, "lampGlow": {"control": "head", "prop": LAMP_PROP},
                 "puffs": puffs, "antenna": antenna}
        extras = extras + puff_objs
    for ob in parts + [o for o in coll.objects if "cts_face" in o] + extras:
        M.add_outline(ob, ob.get("cts_outline", 0.0), style)
    bpy.context.view_layer.update()
    lo, hi = _bbox(parts + [o for o in extras if "cts_wheel" in o])
    if vinfo is not None:
        vinfo["length"], vinfo["width"], vinfo["height"] = (round(hi.y - lo.y, 3), round(hi.x - lo.x, 3), round(hi.z - lo.z, 3))
    shadow = M.blob_shadow(f"{cid}_shadow", (max(0.05, (hi.x - lo.x) / 2 * 1.15 + 0.03), max(0.05, (hi.y - lo.y) / 2 * 1.15 + 0.03)), style, ctl["root"], collection=coll)
    shadow.location = ((hi.x + lo.x) / 2, (hi.y + lo.y) / 2, shadow.location.z)
    tag(shadow, cid, cts_shadow=True)
    bpy.context.view_layer.update()
    return {"rig": find_rig(cid), "warnings": warnings, "bbox": [list(lo), list(hi)], "face": face, "vehicle": vinfo}


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
    if built["vehicle"] is not None:
        info["kind"] = "vehicle"
        info["vehicle"] = built["vehicle"]
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
