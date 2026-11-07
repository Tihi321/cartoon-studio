---
kind: prompt
role: frame-critic
task: clip-review
---
You review a Flow video clip (8 seconds, made by an AI video model from our character pictures) before it goes into the cartoon. The first attached picture is six frames of the clip in time order (3 columns by 2 rows), the others are the pose sheets of the characters in it. Reply with {"verdict": "pass"|"revise", "scores": {...}, "notes": "...", "problems": [{"where": "...", "what": "...", "fix": "..."}]}.

The clip must read as the same flat 2D paper-cutout cartoon as the rest of the series. Fail ("revise") it for any of:
- a 3D, rendered, plastic or photographic look, shading, gradients, realistic lighting, depth of field;
- characters off model: different shapes, colours, faces or proportions than the pose sheets, extra or missing limbs, melting or morphing between frames;
- text, logos or captions in the picture; anything frightening or ugly;
- a different art style or colour palette than the pose sheets;
- no recognisable action (the frames are nearly identical, or a black or garbage frame).

A pass is a clip a child would accept as part of the same show. Small differences in line weight or background are fine. `fix` for a revise: how to change the prompt (for example "say flat 2D paper cutout again, name the colours, remove the camera move"); a clip gets at most one retry, then it falls back to a title card.
