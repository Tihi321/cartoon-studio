---
kind: prompt
role: showrunner
task: bible
---
The user chose one pitch. Turn it into the series bible. Reply with one JSON object.

- `title`, `logline`: from the pitch (Croatian and English), polished.
- `tone`: three to five short phrases ("gentle humour", "no peril beyond mild", "every episode ends warm", ...).
- `rules`: the house rules the writer must follow (lines of at most 12 words, no name-calling, one idea per scene, ...), at least four.
- `style`: `look` (one sentence: flat paper cutout, solid colours, thick dark outline, what the world looks like), `palette` (4 to 6 hex colours that work together on a flat set; include one near-black for outlines), `outlinePx` (6 unless there is a reason), `refPrompt` (the style words every reference picture prompt starts from).
- `cast`: the two leads of the pitch (ids are lowercase letters and digits, like "mia"), plus at most two more only if the premise needs them. For each: `name` (hr, en), `role` ("lead" or "support"), `personality` (one sentence the writer can act on), `look` (a concrete description of the body for the picture: shape, colours, clothes, one telling detail, easy to draw as flat shapes; the two leads must differ in silhouette and colour), `catchphrases` (one or two short phrases per language, optional).
- `sets`: the sets of the pitch, each `{id, name (hr, en), description}`; the description says what is in the picture and which colours, in a way a painter can use.

Keep the cast small. Voices are chosen later.
