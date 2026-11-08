# SPDX-License-Identifier: GPL-3.0-or-later
"""Primitive meshes for characters and sets. A part is a shape name and a `size` list (metres), centred on its own origin:

    ellipsoid  [rx, ry, rz]  (one number: a sphere; two: rx = ry, rz)
    cone       [radius, height, tip radius?]  (tip default 0.1 x radius; centred, the tip points +z)
    box        [x, y, z]  (one number: a cube; two: x = y, z)  with a small bevel
    capsule    [radius, length]  (length is end to end, along z)
    torus      [R, r, sx?]  (a ring around z; sx stretches x)
    arc        [R, r, sweep degrees?]  (a tube along an arc in the XZ plane, default 140, bulging down like a smile, centred on its middle)
    spines     [rx, ry, rz]  (the radii of the surface the spines grow from; see `spines_mesh`)

z is up, -y is the front of a character; `_L` parts sit at -x (the viewer's left when the character faces the camera).
"""
import math

import bmesh
import bpy
from mathutils import Matrix, Vector

from .io import CtsError

SHAPES = ("ellipsoid", "cone", "box", "capsule", "torus", "arc", "spines")


def _radii3(size):
    if len(size) == 1:
        return (size[0],) * 3
    if len(size) == 2:
        return (size[0], size[0], size[1])
    return tuple(size[:3])


def ellipsoid(size, seg=40):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=seg // 2, radius=1.0)
    bmesh.ops.scale(bm, vec=Vector(_radii3(size)), verts=bm.verts)
    return bm


def cone(size, seg=32):
    r1, depth = size[0], size[1]
    r2 = size[2] if len(size) > 2 else r1 * 0.1
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg, radius1=r1, radius2=r2, depth=depth)
    return bm


def box(size):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(_radii3(size)), verts=bm.verts)
    return bm


def capsule(size, seg=24):
    r, length = size[0], max(size[1], 2 * size[0])
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=seg // 2, radius=r)
    half = (length - 2 * r) / 2
    for v in bm.verts:
        if v.co.z > 1e-6:
            v.co.z += half
        elif v.co.z < -1e-6:
            v.co.z -= half
    return bm


def _tube(bm, centres, normals, radius_at, m=10, binormal=Vector((0, 1, 0)), closed=False):
    rings = []
    for i, (c, nrm) in enumerate(zip(centres, normals)):
        r = radius_at(i)
        ring = []
        for j in range(m):
            b = 2 * math.pi * j / m
            ring.append(bm.verts.new(c + (nrm * math.cos(b) + binormal * math.sin(b)) * r))
        rings.append(ring)
    n = len(rings)
    for i in range(n if closed else n - 1):
        a, b2 = rings[i], rings[(i + 1) % n]
        for j in range(m):
            bm.faces.new((a[j], a[(j + 1) % m], b2[(j + 1) % m], b2[j]))
    if not closed:
        for ring in (rings[0], rings[-1]):
            bm.faces.new(ring)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)


def arc(size, n=24, m=10):
    R, r = size[0], size[1]
    sweep = size[2] if len(size) > 2 else 140.0
    a0, a1 = math.radians(270 - sweep / 2), math.radians(270 + sweep / 2)
    mid = R * (math.sin(a0) + -1.0) / 2  # z of the middle of the arc, to centre it
    centres, normals = [], []
    for i in range(n + 1):
        a = a0 + (a1 - a0) * i / n
        centres.append(Vector((R * math.cos(a), 0, R * math.sin(a) - mid)))
        normals.append(Vector((math.cos(a), 0, math.sin(a))))
    bm = bmesh.new()
    _tube(bm, centres, normals, lambda i: r * (0.55 + 0.45 * math.sin(math.pi * i / n)), m=m)
    return bm


def torus(size, n=40, m=14):
    R, r = size[0], size[1]
    sx = size[2] if len(size) > 2 else 1.0
    centres, normals = [], []
    for i in range(n):
        a = 2 * math.pi * i / n
        centres.append(Vector((R * math.cos(a) * sx, R * math.sin(a), 0)))
        normals.append(Vector((math.cos(a), math.sin(a), 0)))
    bm = bmesh.new()
    _tube(bm, centres, normals, lambda i: r, m=m, binormal=Vector((0, 0, 1)), closed=True)
    return bm


def spines_mesh(size, count, length, rad, keep, lean):
    """Many soft cones on an ellipsoid surface, joined into one mesh. `keep`: back (all but the front and the underside), top (the upper half and
    the back), all. `lean` tilts them backwards (+y) and a little up."""
    bm = bmesh.new()
    golden = math.pi * (3 - math.sqrt(5))
    radii = _radii3(size)
    lean_v = Vector((0, lean, lean * 0.45))
    for i in range(count):
        z = 1 - 2 * (i + 0.5) / count
        rr = math.sqrt(1 - z * z)
        a = golden * i
        u = Vector((rr * math.cos(a), rr * math.sin(a), z))
        if keep == "back" and not (u.y > -0.15 and u.z > -0.55):
            continue
        if keep == "top" and not (u.y > -0.25 and u.z > -0.2):
            continue
        p = Vector((u.x * radii[0], u.y * radii[1], u.z * radii[2]))
        nrm = Vector((u.x / radii[0], u.y / radii[1], u.z / radii[2])).normalized()
        d = (nrm + lean_v).normalized()
        q = d.to_track_quat("Z", "Y").to_matrix().to_4x4()
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=10, radius1=rad, radius2=rad * 0.12, depth=length, matrix=Matrix.Translation(p + d * length * 0.25) @ q)
    return bm


def mesh_for(part):
    """The bmesh of a character part dict (`shape`, `size`, `spines`)."""
    shape, size = part["shape"], part["size"]
    if shape == "ellipsoid":
        return ellipsoid(size)
    if shape == "cone":
        return cone(size)
    if shape == "box":
        return box(size)
    if shape == "capsule":
        return capsule(size)
    if shape == "torus":
        return torus(size)
    if shape == "arc":
        return arc(size)
    if shape == "spines":
        sp = part.get("spines")
        if not sp:
            raise CtsError("E_SPEC_INVALID", f"part {part['id']}: a spines part needs a spines block")
        return spines_mesh(size, sp["count"], sp["length"], sp["radius"], sp["keep"], sp["lean"])
    raise CtsError("E_SPEC_INVALID", f"part {part['id']}: unknown shape {shape!r}")


def extent(part):
    """Half-extents of a part (used for outline width and footprints)."""
    shape, size = part["shape"], part["size"]
    if shape in ("ellipsoid", "box", "spines"):
        return _radii3(size)
    if shape == "cone":
        return (size[0], size[0], size[1] / 2)
    if shape == "capsule":
        return (size[0], size[0], max(size[1], 2 * size[0]) / 2)
    if shape == "torus":
        sx = size[2] if len(size) > 2 else 1.0
        return (size[0] * sx + size[1], size[0] + size[1], size[1])
    return (size[0], size[1], size[0])


def make_object(name, bm, material, parent=None, loc=(0, 0, 0), rot_deg=(0, 0, 0), smooth=True, bevel=0.0, collection=None):
    """Turns a bmesh into an object (consumes the bmesh), linked to the scene collection or the given one."""
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if smooth:
        me.shade_smooth()
    ob = bpy.data.objects.new(name, me)
    (collection or bpy.context.scene.collection).objects.link(ob)
    if material is not None:
        ob.data.materials.append(material)
    if parent is not None:
        ob.parent = parent
    ob.location = loc
    ob.rotation_euler = tuple(math.radians(a) for a in rot_deg)
    if bevel:
        b = ob.modifiers.new("bevel", "BEVEL")
        b.width = bevel
        b.segments = 2
    return ob


def empty(name, parent=None, loc=(0, 0, 0), rot_deg=(0, 0, 0), size=0.05, collection=None):
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = size
    (collection or bpy.context.scene.collection).objects.link(e)
    if parent is not None:
        e.parent = parent
    e.location = loc
    e.rotation_euler = tuple(math.radians(a) for a in rot_deg)
    return e
