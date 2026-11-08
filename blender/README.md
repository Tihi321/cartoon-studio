# blender/

The Blender side of Cartoon Studio: Python scripts that the engine runs in a headless Blender 5.2 to build characters and sets, assemble an episode and render it.

- `run.py <job.json>` is the entry point (`blender -b --factory-startup --python-exit-code 1 --python blender/run.py -- <job.json>`); a command is registered with `@command("name")` in `cts_blender/`. The outcome goes to stdout as `CTS {...}` lines (`cts_blender/io.py`).
- Commands (`cts_blender/COMMAND_MODULES`): `probe`, `build-character`, `build-set`, `sheet`, `reel` (the acting library's own proof), `assemble` (timeline + assets -> `scene.blend`, `assembly.json`), `still`, `render` (chunks of PNG frames and the frame times) and `contact` (a labelled contact sheet).
- `cts_blender/api5.py` is the only place that knows about Blender 5.x API differences.
- `yarn test:blender` runs `tests/` in Blender's own Python (it fails, not skips, when Blender is missing).

**Licence.** Scripts that `import bpy` are generally treated as covered by Blender's GPL when distributed, so this folder is under **GPL-3.0-or-later** (see `LICENSE` here). The rest of the repository stays MIT. The engine only starts Blender as a separate program and talks to it through a JSON file and stdout lines.
