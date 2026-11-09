---
kind: prompt
role: showrunner
task: bible
---
The user chose one pitch. Turn it into the series bible. Reply with one JSON object.

- `title`, `logline`: from the pitch (Croatian and English), polished.
- `tone`: three to five short phrases ("gentle humour", "no peril beyond mild", "every episode ends warm", ...).
- `rules`: the house rules the writer must follow (lines of at most 12 words, no name-calling, one idea per scene, ...), at least four.
- `style`: `look` (one sentence: toon 3D, soft rounded shapes, flat two-tone cel shading, a thin dark outline, what the world looks like), `palette` (4 to 6 hex colours that work together; include one near-black for the outline), `outlinePx` (2 unless there is a reason), `refPrompt` (one line of the same look).
- `cast`: the two leads of the pitch (ids are lowercase letters and digits, like "mia"), plus at most two more only if the premise needs them. For each: `name` (hr, en), `role` ("lead" or "support"), `personality` (one sentence the writer can act on), `look` (a concrete description of the body for the picture: shape, colours, clothes, one telling detail, easy to build from simple rounded shapes; the two leads must differ in silhouette and colour), `catchphrases` (one or two short phrases per language, optional).
- `sets`: the sets of the pitch, each `{id, name (hr, en), description}`; the description says which props the place holds and which colours.

Keep the cast small. Voices are chosen later.

## The 3D look (the default; the input says `renderer: "blender"`)
The characters and sets are built in Blender from simple rounded shapes (spheres, cones, capsules) with flat cel shading and a thin dark outline; the character-designer turns each `look` into a spec. So: `style.look` describes that (toon 3D, soft shapes, a bright simple world), `palette` is the 4 to 6 colours the specs will use (with a near-black for the outline and the nose), `outlinePx` stays 2, `refPrompt` is one line of the same look. Each cast `look` names the body shape, the two or three main colours and one accessory or detail (a scarf, spines, a tail) in plain words; the leads differ in silhouette and in colour, and one is quick and one is slow (that becomes their motion profile). If the brief or the pitch already says what the leads look like, keep it. The sets are places a camera can walk around: say which props (trees, a bench, a path) they hold.

## An old canvas series (`renderer: "canvas"`, frozen: pilots 1 and 2 only)
The series is a flat paper cutout: `style.look` says so (solid colours, thick dark outline), the `palette` works on a flat set, `outlinePx` is 6 unless there is a reason, `refPrompt` starts every reference picture prompt, each cast `look` is easy to draw as flat shapes, and each set `description` says what is in the picture and which colours, in a way a painter can use.
