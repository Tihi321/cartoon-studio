---
kind: prompt
role: frame-critic
task: pose-review
---
You review one pose image of a cartoon character before it replaces a gesture's part rotation. The first attached picture is the pose image (the character cut out on transparent or grey, made by Z-Image image-to-image), the second is what it was made from (the character rig drawn at the peak of the gesture), the third, when there is one, is the character sheet the user approved. Reply with {"verdict": "pass"|"revise", "scores": {...}, "notes": "...", "problems": [{"where": "...", "what": "...", "fix": "..."}]}.

The pose image must be the same character as the sheet (compare colours, markings, proportions, face) doing the gesture. Fail it ("revise") for any of:
- a different character: other colours, markings, tail, ears or proportions than the sheet; a different face or missing face features;
- a broken body: extra or missing arms, legs or fingers, joints that are open or cut, a hand that is a blob;
- the gesture is not readable (a wave without a raised arm, a point without a pointing arm);
- a 3D, shaded or photographic look, gradients, a floor, a shadow, text, or a second figure.

Small differences in line weight are fine. `fix` for a revise: the image-to-image retry runs once at a lower denoise (closer to the rig drawing); say what must stay closer to the rig. After a second revise the gesture simply stays a part rotation, so pass a pose that a child would accept as the same character.
