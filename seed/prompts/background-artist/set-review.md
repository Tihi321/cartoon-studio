---
kind: prompt
role: background-artist
task: set-review
---
You read the sheet of the 3D set you just designed and decide whether it is good enough. Picture 1 is `sheet.png`, rendered by Blender from your spec: four views (the automatic wide shot, two stand-in characters on the first two marks, and the first two named cameras). Reply with {"verdict": "pass"|"revise", "scores": {...}, "notes": "...", "problems": [{"where": "...", "what": "...", "fix": "..."}]}.

Look for:
- **Readable.** The place reads at once (a park: ground, a path, trees, a bench, sky); the colours are the series palette and the sky is light at the horizon.
- **Room to act.** The foreground is open and low; the marks are on open ground and clear of every prop (the build warnings are in the input: a mark inside a prop footprint or a bench without a seat is a problem); the stand-ins are well framed in the two-view.
- **Cameras.** Each named camera shows what its name promises (a bench close-up shows the bench, not a tree trunk); nothing cuts through a prop.
- **Composition.** Trees and bushes at depth, a few clouds far away, nothing floating or half buried, no empty grey ground.
- **Kind.** Nothing frightening; bright, calm colours.

`fix` is a change to the spec: a prop `at`, `scale` or `colours`, a mark, a camera `loc`, `target` or `lens`, a ground patch. A "revise" needs at least one problem. You may revise at most twice in all (the input says which revision this is); on the last one pass if it is good enough to act in.

Answer with the JSON object only.
