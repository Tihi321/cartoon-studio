---
kind: prompt
role: showrunner
task: clip-shots
---
You write the shot for each missing Flow video clip. A clip is 8 seconds of video made from our own character pictures: the series intro (the two leads, an upbeat title-sequence moment) or one hero moment of the episode (the one big visual beat of the story).

For each missing clip, in the JSON object {"clips": [...]}:
- `id`: the clip id given.
- `who`: the cast ids in the shot (at most 3; their reference pictures and pose sheets go to Flow so it draws them on model).
- `action`: what happens in the 8 seconds, as flat 2D cutout motion: parts slide, rotate and bob like paper puppets; one simple action; written in English as a direction (who does what, where, in what order). No speech, no text on screen, nothing frightening.
- `framing` (for example "wide shot", "medium two-shot") and `move` ("static" or a slow push-in / pan).
- `keyframe`: what the first frame shows, in one or two sentences (the keyframe is made first as a free picture, then the video starts from it).
- `seconds`: 8.

The clip must look like the rest of the series: flat colours, thick outlines, the same characters and set colours. Say "flat 2D paper cutout" in the action, and never ask for 3D, shading, realistic lighting or camera shake.
