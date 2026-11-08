---
kind: blender
# Blender renders the 3D episodes (series with renderer "blender"). Cartoon Studio never bundles or downloads it: install Blender 5.2 and set the path.
path: C:/Program Files/Blender Foundation/Blender 5.2/blender.exe
# Only this major.minor is accepted (any patch). Another version is refused with E_BLENDER_VERSION unless allowUntestedVersion is true.
version: "5.2"
allowUntestedVersion: false
# The render goes in chunks of this many frames; each finished chunk is encoded and its frames are deleted.
chunkFrames: 240
# Frame sizes and EEVEE samples (TAA): the preview is for looking, the final is the MP4 you keep.
preview: { width: 960, height: 540, samples: 4 }
final: { width: 1920, height: 1080, samples: 16 }
---
# Blender

Where Blender is and how the 3D render uses it (CTS-18 reads this file; `cts_blender_status` checks it, `cts_blender_config` changes it).

- `path`: the Blender executable. The default is the installer's folder on Windows. A missing file is `E_BLENDER_MISSING`.
- `version` and `allowUntestedVersion`: the scripts are written for one Blender major.minor (5.2). The runner reads `blender --version` once per engine start and refuses another major.minor with `E_BLENDER_VERSION`, unless `allowUntestedVersion` is true.
- `chunkFrames`: frames per render chunk (a 10 minute episode would otherwise need about 40 GB of PNG frames at once).
- `preview` and `final`: frame size and EEVEE samples.

Every run is `blender -b --factory-startup --python-exit-code 1 --python blender/run.py -- <job.json>` with `PYTHONNOUSERSITE=1`, so the user's preferences and add-ons never change a render.
