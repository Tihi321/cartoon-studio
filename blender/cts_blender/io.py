# SPDX-License-Identifier: GPL-3.0-or-later
"""Job file and the CTS stdout protocol (HUB-30 decision 13).

The engine writes a job JSON and starts Blender with it after `--`. This side prints one line per event:

    CTS {"type":"progress","done":n,"total":m,"stage":"..."}
    CTS {"type":"chunk","index":k,"from":f0,"to":f1,"dir":"..."}
    CTS {"type":"result", ...}
    CTS {"type":"error","code":"...","message":"..."}

Any other output (print, Blender's own lines) goes to the job log on the engine side.
"""
import json
import sys

PREFIX = "CTS "


class CtsError(Exception):
    """A failure with a code the engine shows (for example E_FACE_HIDDEN). Raised by commands, printed by run.py."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def emit(type_, **fields):
    """One protocol line on stdout, flushed at once so the engine sees progress while Blender works."""
    sys.stdout.write(PREFIX + json.dumps({"type": type_, **fields}, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def progress(done, total, stage=""):
    emit("progress", done=done, total=total, stage=stage)


def chunk(index, first, last, directory):
    emit("chunk", index=index, **{"from": first, "to": last}, dir=directory)


def result(**fields):
    emit("result", **fields)


def error(code, message):
    emit("error", code=code, message=message)


def job_path(argv=None):
    """The job file: the first argument after `--` on Blender's command line."""
    argv = sys.argv if argv is None else argv
    if "--" not in argv or argv.index("--") + 1 >= len(argv):
        raise CtsError("E_BLENDER_FAILED", "no job file after --")
    return argv[argv.index("--") + 1]


def read_job(path):
    with open(path, "r", encoding="utf-8") as f:
        job = json.load(f)
    if not isinstance(job, dict) or "command" not in job:
        raise CtsError("E_BLENDER_FAILED", "the job file has no command")
    return job
