# SPDX-License-Identifier: GPL-3.0-or-later
"""A hash of what a build made: the objects (names, parents, transforms, mesh sizes, materials, modifiers), the controls (empties only) and every
animation key. Two builds of the same spec must give the same three hashes (test B1); `build.json` records them."""
import hashlib
import json

import bpy

from . import api5


def _r(values, n=5):
    return [round(float(v), n) for v in values]


def _matrix(m):
    return [_r(row) for row in m]


def _sha(obj):
    return hashlib.sha1(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def _object(ob):
    d = {"name": ob.name, "type": ob.type, "parent": ob.parent.name if ob.parent else None, "world": _matrix(ob.matrix_world)}
    if ob.type == "MESH":
        me = ob.data
        d["mesh"] = [len(me.vertices), len(me.polygons), round(sum(v.co.x + 2 * v.co.y + 3 * v.co.z for v in me.vertices), 4)]
        d["materials"] = [m.name if m else None for m in me.materials]
        d["modifiers"] = [[m.name, m.type, round(getattr(m, "thickness", 0.0), 5)] for m in ob.modifiers]
    return d


def _keys(ob):
    out = []
    for fc in api5.fcurves(ob):
        out.append([fc.data_path, fc.array_index, [[_r(k.co), k.interpolation] for k in fc.keyframe_points]])
    return sorted(out, key=lambda x: (x[0], x[1]))


def fingerprint(objects):
    objs = sorted(objects, key=lambda o: o.name)
    return {
        "objects": _sha([_object(o) for o in objs]),
        "controls": _sha([[o.name, o.parent.name if o.parent else None, _r(o.location), _r(o.rotation_euler), _r(o.scale)] for o in objs if o.type == "EMPTY"]),
        "keys": _sha([[o.name, _keys(o)] for o in objs if o.animation_data]),
        "count": len(objs),
    }
