# SPDX-License-Identifier: GPL-3.0-or-later
"""Entry point, started by the engine:

    blender -b --factory-startup --python-exit-code 1 --python blender/run.py -- <job.json>

The job file is JSON with a `command` (see cts_blender/__init__.py). The outcome is printed as CTS lines (cts_blender/io.py).
"""
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cts_blender import io, load_commands  # noqa: E402


def main():
    try:
        job = io.read_job(io.job_path())
        commands = load_commands()
        fn = commands.get(job["command"])
        if fn is None:
            raise io.CtsError("E_BLENDER_FAILED", f"unknown command {job['command']!r} (known: {', '.join(sorted(commands))})")
        io.result(**(fn(job) or {}))
    except io.CtsError as e:
        io.error(e.code, e.message)
        sys.exit(1)
    except Exception as e:  # the traceback goes to the job log, the engine gets a code
        traceback.print_exc()
        io.error("E_BLENDER_FAILED", f"{type(e).__name__}: {e}")
        sys.exit(1)


main()
