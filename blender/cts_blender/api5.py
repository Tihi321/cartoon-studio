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
