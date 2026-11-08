# SPDX-License-Identifier: GPL-3.0-or-later
"""Every Blender 5.x API difference lives here and nowhere else (HUB-30 decision 12).

If Blender changes one of these again, `yarn test:blender` fails here first. Gotchas found by the probe:
- Action.fcurves is gone: curves live in a channelbag of the action slot.
- `keyframe_new_interpolation_type` is ignored in background mode: set the interpolation on the keyframes after keying.
- The compositor has no Composite node: the tree is a node group with a Group Output (`scene.compositing_node_group`), mixing uses ShaderNodeMix.
- Workbench shows an inverted-hull shell over everything unless backface culling is on in the shading.
- gpu.platform answers only after gpu.init() in a background run.
"""
import bpy


def gpu_info():
    """The GPU EEVEE would use, or None when no GL context can be made (a machine without a GPU)."""
    try:
        import gpu

        gpu.init()
        p = gpu.platform
        return {
            "renderer": p.renderer_get(),
            "vendor": p.vendor_get(),
            "version": p.version_get(),
            "backend": p.backend_type_get(),
            "deviceType": p.device_type_get(),
        }
    except Exception:
        return None


def channelbag(obj):
    """The channelbag of the object's action slot, or None when it has no animation."""
    from bpy_extras import anim_utils

    ad = obj.animation_data
    if not ad or not ad.action or not ad.action_slot:
        return None
    return anim_utils.action_get_channelbag_for_slot(ad.action, ad.action_slot)


def fcurves(obj):
    cb = channelbag(obj)
    return list(cb.fcurves) if cb else []


_INTERP = {"CONSTANT": 0, "LINEAR": 1, "BEZIER": 2}


def write_dense(idb, name, curves):
    """Writes dense channels in one go with the 5.x animation API (action slot + layer + keyframe strip + channelbag): `curves` maps (data_path, index)
    to (frames, values, interpolation). Keys are added with `keyframe_points.add` and set with `foreach_set`; the interpolation is set on the keys afterwards
    (CONSTANT for mouths and lids, LINEAR for dense motion), because `keyframe_new_interpolation_type` is ignored in background mode.
    `idb` is an Object or a datablock with animation_data (a Camera). Returns the number of keys written."""
    import numpy as np

    if not curves:
        return 0
    action = bpy.data.actions.new(name)
    slot = action.slots.new(id_type=idb.id_type, name=idb.name)
    ad = idb.animation_data_create()
    ad.action = action
    ad.action_slot = slot
    layer = action.layers.new("cts")
    strip = layer.strips.new(type="KEYFRAME")
    cb = strip.channelbag(slot, ensure=True)
    total = 0
    for (path, index) in sorted(curves):
        frames, values, interp = curves[(path, index)]
        n = len(frames)
        fc = cb.fcurves.new(path, index=index)
        fc.keyframe_points.add(n)
        co = np.empty(2 * n)
        co[0::2] = frames
        co[1::2] = values
        fc.keyframe_points.foreach_set("co", co)
        fc.keyframe_points.foreach_set("interpolation", [_INTERP[interp]] * n)
        fc.update()
        total += n
    return total


def set_interpolation(obj, interpolation, data_path_prefix=None):
    """Sets the interpolation of every key of the object (or of the curves whose data path starts with the prefix). Returns how many keys."""
    n = 0
    for fc in fcurves(obj):
        if data_path_prefix and not fc.data_path.startswith(data_path_prefix):
            continue
        for kp in fc.keyframe_points:
            kp.interpolation = interpolation
            n += 1
    return n


def new_compositor_group(scene, name):
    """A compositor node group with an Image output, set as the scene's compositing tree."""
    ng = bpy.data.node_groups.new(name, "CompositorNodeTree")
    scene.compositing_node_group = ng
    ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    return ng


def workbench_backface_culling(scene, on=True):
    scene.display.shading.show_backface_culling = on


def material_culled(mat):
    """Backface culling in EEVEE (the inverted-hull outline shows only the rim behind the body)."""
    mat.use_backface_culling = True


def material_blended(mat):
    """Real alpha (the blob shadow): the 5.x name of the old blend_method."""
    mat.surface_render_method = "BLENDED"
    mat.use_transparency_overlap = False


def light_no_shadow(light):
    light.use_shadow = False


def configure_eevee(scene, samples):
    """EEVEE as the look wants it: no raytracing, no shadows, TAA with the given samples."""
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = int(samples)
    scene.eevee.use_raytracing = False
    scene.eevee.use_shadows = False
