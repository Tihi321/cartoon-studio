# SPDX-License-Identifier: GPL-3.0-or-later
"""The `probe` command: which Blender this is and which GPU EEVEE would use."""
import bpy

from . import api5, command


@command("probe")
def probe(job):
    return {
        "version": bpy.app.version_string,
        "versionTuple": list(bpy.app.version),
        "gpu": api5.gpu_info(),
    }
