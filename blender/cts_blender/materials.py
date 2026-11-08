# SPDX-License-Identifier: GPL-3.0-or-later
"""The look (HUB-30 decision 8): one style file per series, the probe's clean look as the default.

- toon material: Diffuse -> Shader to RGB -> a constant two-stop ColorRamp (shadow shade, threshold) -> Emission
- view transform Standard, so the palette hexes come out exact
- inverted-hull outlines (Solidify, offset 1, flipped normals, a backface-culled dark emission material)
- a sun without shadows, a blob shadow under each character, a sky gradient in the world
- EEVEE with no raytracing and no shadows; TAA samples for the final and the preview
- optional post through the 5.x compositor: none | paper | posterize

Materials are found by name in `bpy.data`, so building twice gives the same data blocks, never copies.
"""
import json
import math

import bpy

from . import api5
from .io import CtsError

DEFAULT_STYLE = {
    "toon": {"shade": 0.74, "threshold": 0.36},
    "outline": {"colour": "#2b2118", "scale": 1.0},
    "world": {"sky": {"top": "#86cdf0", "horizon": "#e4f6fb"}},
    "sun": {"angle": [50, -10, -35], "energy": 3.2},
    "samples": {"final": 16, "preview": 4},
    "post": "none",
    "stepped": False,
}

POSTS = ("none", "paper", "posterize")
INK = "#3b1f17"  # the dark of faces (mouth line, lashes)


def lin(hexcol, alpha=1.0):
    """'#rrggbb' (sRGB) to the linear RGBA tuple Blender colours use."""
    h = hexcol.lstrip("#")
    if len(h) != 6:
        raise CtsError("E_STYLE_INVALID", f"{hexcol!r} is not a #rrggbb colour")
    c = [int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c) + (alpha,)


def _merge(base, over, path=""):
    out = dict(base)
    for k, v in (over or {}).items():
        if k == "schema":
            continue
        if k not in base:
            raise CtsError("E_STYLE_INVALID", f"style3d: unknown field {path}{k}")
        out[k] = _merge(base[k], v, f"{path}{k}.") if isinstance(base[k], dict) else v
    return out


def load_style(src=None):
    """The style as a plain dict with every default filled in. `src` is None (the defaults), a path to `style3d.json` or a dict."""
    if isinstance(src, str):
        with open(src, "r", encoding="utf-8") as f:
            src = json.load(f)
    style = _merge(DEFAULT_STYLE, src or {})
    if style["post"] not in POSTS:
        raise CtsError("E_STYLE_INVALID", f"style3d: post must be one of {', '.join(POSTS)}")
    if not 0 <= style["toon"]["shade"] <= 1 or not 0 <= style["toon"]["threshold"] <= 1:
        raise CtsError("E_STYLE_INVALID", "style3d: toon.shade and toon.threshold are between 0 and 1")
    return style


# ---------------------------------------------------------------- materials


def _fresh(name, setup):
    mat = bpy.data.materials.get(name)
    if mat:
        return mat
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.node_tree.nodes.clear()
    setup(mat, mat.node_tree)
    return mat


def toon(style, hexcol, shade=None):
    """The toon material of a palette colour: lit colour above the threshold, the same colour darker below it."""
    shade = style["toon"]["shade"] if shade is None else shade
    thr = style["toon"]["threshold"]

    def setup(mat, nt):
        d = nt.nodes.new("ShaderNodeBsdfDiffuse")
        d.inputs["Color"].default_value = (1, 1, 1, 1)
        s2r = nt.nodes.new("ShaderNodeShaderToRGB")
        ramp = nt.nodes.new("ShaderNodeValToRGB")
        cr = ramp.color_ramp
        cr.interpolation = "CONSTANT"
        base = lin(hexcol)
        cr.elements[0].position = 0.0
        cr.elements[0].color = (base[0] * shade * 0.95, base[1] * shade * 0.97, min(1, base[2] * shade * 1.12 + 0.01), 1)
        cr.elements[1].position = thr
        cr.elements[1].color = base
        em = nt.nodes.new("ShaderNodeEmission")
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(d.outputs[0], s2r.inputs[0])
        nt.links.new(s2r.outputs["Color"], ramp.inputs["Fac"])
        nt.links.new(ramp.outputs["Color"], em.inputs["Color"])
        nt.links.new(em.outputs[0], out.inputs["Surface"])
        mat.diffuse_color = base  # Workbench and the viewport

    return _fresh(f"toon_{hexcol.lstrip('#').lower()}_{shade:.2f}_{thr:.2f}", setup)


def flat(hexcol, name=None):
    """An unlit colour (pupils, mouth insides, the ink line)."""

    def setup(mat, nt):
        em = nt.nodes.new("ShaderNodeEmission")
        em.inputs["Color"].default_value = lin(hexcol)
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(em.outputs[0], out.inputs["Surface"])
        mat.diffuse_color = lin(hexcol)

    return _fresh(name or f"flat_{hexcol.lstrip('#').lower()}", setup)


def outline_material(style):
    """The dark backface-culled emission the inverted hull wears."""
    colour = style["outline"]["colour"]

    def setup(mat, nt):
        em = nt.nodes.new("ShaderNodeEmission")
        em.inputs["Color"].default_value = lin(colour)
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(em.outputs[0], out.inputs["Surface"])
        mat.diffuse_color = lin(colour)
        api5.material_culled(mat)

    return _fresh(f"outline_{colour.lstrip('#').lower()}", setup)


def default_outline_width(size):
    """Outline width in metres for a part: 3 % of its largest extent, between 4 mm and 3 cm."""
    return min(0.03, max(0.004, 0.03 * max(size)))


def add_outline(ob, width, style):
    """Inverted hull on a mesh object: a second material slot and a Solidify that pushes the flipped shell outwards."""
    if not width or width <= 0 or ob.type != "MESH":
        return
    width *= style["outline"]["scale"]
    ob.data.materials.append(outline_material(style))
    s = ob.modifiers.new("outline", "SOLIDIFY")
    s.thickness = width
    s.offset = 1.0
    s.use_flip_normals = True
    s.material_offset = len(ob.data.materials) - 1
    s.use_rim = False
    s.use_even_offset = True


def blob_shadow(name, radii, style, parent=None, alpha=0.42, collection=None):
    """A soft dark disc on the ground under a character or prop (the sun casts no shadows, so the hull is not shadowed by itself)."""
    import bmesh

    mat = bpy.data.materials.get("blob_shadow")
    if not mat:
        mat = bpy.data.materials.new("blob_shadow")
        mat.use_nodes = True
        nt = mat.node_tree
        nt.nodes.clear()
        em = nt.nodes.new("ShaderNodeEmission")
        em.inputs["Color"].default_value = lin("#1c2a12")
        tr = nt.nodes.new("ShaderNodeBsdfTransparent")
        tc = nt.nodes.new("ShaderNodeTexCoord")
        # the disc's UV (0..1) to -1..1, so a spherical gradient is 1 in the middle and 0 at the rim
        mapping = nt.nodes.new("ShaderNodeMapping")
        mapping.inputs["Location"].default_value = (-1.0, -1.0, 0.0)
        mapping.inputs["Scale"].default_value = (2.0, 2.0, 1.0)
        grad = nt.nodes.new("ShaderNodeTexGradient")
        grad.gradient_type = "SPHERICAL"
        plateau = nt.nodes.new("ShaderNodeMath")  # twice the gradient, clamped: a dark middle with a soft rim
        plateau.operation = "MULTIPLY"
        plateau.use_clamp = True
        plateau.inputs[1].default_value = 2.0
        mul = nt.nodes.new("ShaderNodeMath")
        mul.operation = "MULTIPLY"
        mul.inputs[1].default_value = alpha
        mixsh = nt.nodes.new("ShaderNodeMixShader")
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(tc.outputs["UV"], mapping.inputs["Vector"])
        nt.links.new(mapping.outputs["Vector"], grad.inputs["Vector"])
        nt.links.new(grad.outputs["Fac"], plateau.inputs[0])
        nt.links.new(plateau.outputs[0], mul.inputs[0])
        nt.links.new(mul.outputs[0], mixsh.inputs["Fac"])
        nt.links.new(tr.outputs[0], mixsh.inputs[1])
        nt.links.new(em.outputs[0], mixsh.inputs[2])
        nt.links.new(mixsh.outputs[0], out.inputs["Surface"])
        api5.material_blended(mat)
        mat.diffuse_color = (0.1, 0.15, 0.07, alpha)
    bm = bmesh.new()
    bm.loops.layers.uv.verify()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=1.0, calc_uvs=True)
    for v in bm.verts:
        v.co.x *= radii[0]
        v.co.y *= radii[1]
        v.co.z = 0.0
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    (collection or bpy.context.scene.collection).objects.link(ob)
    ob.data.materials.append(mat)
    if parent:
        ob.parent = parent
    ob.location = (0, 0, 0.015)  # above the ground patches of the set (up to 1 cm)
    ob.visible_shadow = False
    return ob


# ---------------------------------------------------------------- world, sun, render settings


def apply_sky(scene, top, horizon):
    """A vertical gradient in the world shader: `horizon` at and below the horizon, `top` overhead."""
    world = bpy.data.worlds.get("cts_world") or bpy.data.worlds.new("cts_world")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    bg = nt.nodes.new("ShaderNodeBackground")
    out = nt.nodes.new("ShaderNodeOutputWorld")
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = lin(horizon)
    ramp.color_ramp.elements[1].position = 0.55
    ramp.color_ramp.elements[1].color = lin(top)
    nt.links.new(tc.outputs["Object"], sep.inputs[0])  # in a world shader: the view direction
    nt.links.new(sep.outputs["Z"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs[0], out.inputs["Surface"])
    return world


def apply_sun(scene, style):
    sun = bpy.data.objects.get("sun")
    if sun is None:
        light = bpy.data.lights.new("sun", "SUN")
        sun = bpy.data.objects.new("sun", light)
        scene.collection.objects.link(sun)
    sun.data.energy = style["sun"]["energy"]
    api5.light_no_shadow(sun.data)
    sun.rotation_euler = tuple(math.radians(a) for a in style["sun"]["angle"])
    return sun


def apply_look(scene, style, quality="final", sky=None):
    """Render settings, view transform, sun and sky of the style. `sky` ({top, horizon}) overrides the style's, a set brings its own."""
    api5.configure_eevee(scene, style["samples"]["preview" if quality == "preview" else "final"])
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    apply_sun(scene, style)
    s = sky or style["world"]["sky"]
    apply_sky(scene, s["top"], s["horizon"])
    apply_post(scene, style["post"])


# ---------------------------------------------------------------- post (5.x compositor)


def _paper_image(width, height):
    """Paper grain as an image: coarse blotches and fine fibres, warm white around 0.93, the same for the same size."""
    import numpy as np

    name = f"paper_{width}x{height}"
    img = bpy.data.images.get(name)
    if img:
        return img
    rng = np.random.default_rng(3)
    coarse = rng.normal(0, 1, (-(-height // 4), -(-width // 4))).astype(np.float32)
    coarse = np.kron(coarse, np.ones((4, 4), np.float32))[:height, :width]
    fine = rng.normal(0, 1, (height, width)).astype(np.float32)
    g = 0.93 + 0.035 * coarse / 3 + 0.03 * fine / 3
    px = np.dstack([g * 1.0, g * 0.975, g * 0.92, np.ones_like(g)]).clip(0, 1)
    img = bpy.data.images.new(name, width, height, alpha=False)
    img.pixels.foreach_set(px.ravel())
    img.pack()
    return img


def apply_post(scene, post):
    """`none`: no compositor. `paper`: the frame multiplied by paper grain. `posterize`: Kuwahara smoothing, 7 colour steps and the paper grain."""
    if post == "none":
        scene.compositing_node_group = None
        scene.render.use_compositing = False
        return
    scene.render.use_compositing = True
    ng = api5.new_compositor_group(scene, f"post_{post}")
    rl = ng.nodes.new("CompositorNodeRLayers")
    last = rl.outputs["Image"]
    if post == "posterize":
        kuw = ng.nodes.new("CompositorNodeKuwahara")
        kuw.inputs["Size"].default_value = 5
        ps = ng.nodes.new("CompositorNodePosterize")
        ps.inputs["Steps"].default_value = 7
        ng.links.new(last, kuw.inputs["Image"])
        ng.links.new(kuw.outputs["Image"], ps.inputs["Image"])
        last = ps.outputs["Image"]
    scale = scene.render.resolution_percentage / 100
    paper = ng.nodes.new("CompositorNodeImage")
    paper.image = _paper_image(max(1, round(scene.render.resolution_x * scale)), max(1, round(scene.render.resolution_y * scale)))
    mix = ng.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs[0].default_value = 1.0
    out = ng.nodes.new("NodeGroupOutput")
    ng.links.new(last, mix.inputs[6])
    ng.links.new(paper.outputs["Image"], mix.inputs[7])
    ng.links.new(mix.outputs[2], out.inputs[0])
    return ng
