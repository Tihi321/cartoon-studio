---
kind: prompt
role: showrunner
task: clip-shots
---
You write the shot for each missing Flow video clip. A clip is 8 seconds of video made from our own character pictures: the series intro (the two leads, an upbeat title-sequence moment) or the series outro (the two leads waving goodbye, a calm closing moment). There is no other clip id.

For each missing clip, in the JSON object {"clips": [...]}:
- `id`: the clip id given.
- `who`: the cast ids in the shot (at most 3; the still shows them on model).
- `action`: what happens in the 8 seconds, as gentle toon 3D character motion (a wave, a hop, a nod); one simple action; written in English as a direction (who does what, where, in what order). No speech, no text on screen, nothing frightening.
- `framing` (for example "wide shot", "medium two-shot") and `move` ("static" or a slow push-in / pan).
- `keyframe`: what the first frame shows, in one or two sentences (the keyframe is a still that Blender renders from `staging`, then the video starts from it).
- `staging`: what the player draws for that still: `set` (a set id), `shot` (a camera shot of that set), and `actors`, one per character in `who`: `who`, `mark` (a mark of that set), `facing` ("left"|"right"), `emotion` and optional `gesture` (the player shows the gesture at its peak). Use only the marks, shots, emotions and gestures listed for that set and character in the input.
- `seconds`: 8.

The clip must sit next to our Blender render, so it keeps the stylised toon 3D look of the first frame: the same characters and set colours, flat cel shading, a thin dark outline; never ask for photoreal textures, realistic lighting or camera shake. The keyframe is a still that Blender renders from `staging` with our own characters and set (the input has `emotions` and `gestures`): `shot` is one of the set's `shots`, `mark` one of its `marks`, `emotion` one of `emotions`, `gesture` one of `gestures` (they need no target). `facing` is "left" or "right".

## An old canvas series (the input has no `emotions` and `gestures`; frozen)
The clip must look like the rest of that flat series: flat colours, thick outlines. Write the `action` as flat 2D cutout motion (parts slide, rotate and bob like paper puppets), say "flat 2D paper cutout" in it, and never ask for 3D, shading, realistic lighting or camera shake. The keyframe is a still that the app's own player draws from `staging`.
