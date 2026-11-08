# SPDX-License-Identifier: GPL-3.0-or-later
"""Cartoon Studio's Blender side. `run.py` starts a command; a command is a function `(job) -> dict` registered with `@command("name")`.

Later tickets add their commands by creating a module here that registers them, and listing the module name in COMMAND_MODULES:
build-character, build-set, sheet, assemble, render, still. A module that is not there yet is skipped.
"""
import importlib

COMMANDS = {}

# modules that register commands; the later tickets append to this list
COMMAND_MODULES = ["probe", "build_character", "build_set", "sheets"]


def command(name):
    """Registers a command: `@command("probe") def run(job): return {...}`. The returned dict becomes the `result` event."""

    def deco(fn):
        COMMANDS[name] = fn
        return fn

    return deco


def load_commands():
    for mod in COMMAND_MODULES:
        try:
            importlib.import_module(f"{__name__}.{mod}")
        except ModuleNotFoundError as e:
            if e.name != f"{__name__}.{mod}":
                raise
    return COMMANDS
