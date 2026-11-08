---
kind: style
---
# The cutout puppet style (ages 4 to 8)

This is the guide for the character-designer. A character is a **paper cutout puppet**: a few flat shapes that slide and turn about pivots, with a face made of swappable pieces. The look is South Park-simple: solid colours, one thick dark outline, no gradients, no shading, no texture unless the series asks for it.

**You do not draw the character.** The default way (path c, raster) is: you describe the character and give a **body plan**, a rough sketch of flat coloured shapes that the app draws; Z-Image (a local image model) redraws the sketch as the finished cartoon; the user approves that sheet; then the master picture is cut into rotatable PNG parts and the face states are PNG patches. Drawing SVG parts yourself is path (a), optional, kept at the end of this guide.

## The image prompt (what the character is)

English, one or two sentences, the character only: body shape, main colours, clothes, face, one telling detail from the series palette and the bible's `look`. No background, floor, pose, camera or lighting: the code adds the pose (arms held away from the body), the flat #808080 grey, the flat solid colours, the thick dark outline and "no text".

## The body plan (the sketch the app draws)

- A list of primitives (`ellipse`, `circle`, `capsule`, `polygon`) in palette colours on a 1024 x 1536 canvas of `#808080`, back to front, each named for the limb that moves it (`body`, `head`, `arm-l`, `arm-r`, `leg-l`, `leg-r`, `tail` ...) with a joint point per limb, plus three pose angle sets: `wave`, `point`, `shrug`. The prompt `body-plan` has the exact schema and the silhouette rules.
- Z-Image keeps the silhouette and the colours of the sketch and invents the details, so the shapes you draw are the shapes you get: a big round head with no gap to the body, thick arms held clear of the torso, two legs apart with both feet visible, a tail that does not cross an arm, a belly or ear in a second palette colour.
- Palette: only the series palette, never the grey. The two leads differ in silhouette and in main colour, so they are told apart in a thumbnail.
- The body plan is a throwaway sketch: nothing in it is a rig part, and no SVG is written.

## What a good master looks like (what you check on the pictures)

One character, full body, standing, arms away from the body, flat solid colours, thick dark outline, clean grey background, no white halo, no extra limbs, the face readable with an open and a closed mouth possible. The three sheet poses (wave, point, shrug) must be the same character: same colours, markings and proportions.

## The raster cut (path c)

Polygons in `ref.png` pixels for each part (`body`, `head`, `arm_l`, `arm_r`, `feet` plus any tail or ear), a pivot for each, and three face boxes (mouth, eyes, brows) that enclose the feature at its widest. The prompt `rig-raster` has the rules. Cut a little past each joint so no gap shows when a part turns.

# Path (a), optional: Claude draws SVG parts

Used only when the run asks for it (`options.rigPaths`: `claude-svg`), for example when Z-Image cannot hold a character. The rules below are for SVG parts and the SVG face plates. Pilot 1's characters were made this way.

## How a part is drawn

- **Flat shapes only.** Every shape has a solid `fill` and, if it has an outline, a `stroke` of the series outline width (`outlinePx` in the bible, normally 6) in the series' near-black. Round `stroke-linejoin` and `stroke-linecap`. No gradients, filters, text, masks, scripts, external links, or embedded pictures (an optional single `<pattern>` is allowed only if the series asks for a painted texture).
- **Palette.** Use only the series palette (4 to 6 colours) plus white for eyes and teeth and one dark red for the inside of the mouth. Skin, clothes and hair are three different palette colours. The two leads differ in silhouette (round vs. tall, hat vs. hair, ...) and in main colour, so they are told apart in a thumbnail.
- **Few paths.** A part is 3 to 15 elements (`path`, `ellipse`, `rect`, `circle`, `polygon`, `line`). Under 30 KB.
- **Redraw, do not trace.** The reference picture is a guide for proportions, colours and the characteristic details. Redraw every shape cleanly from scratch; do not trace its outline, its white sticker halo or its soft shading. Simplify: fewer folds, no fingers (a mitten or a round hand), no toes.
- **Coordinates.** Every SVG has a pixel `viewBox="0 0 W H"` (and `width`/`height` equal to it) in **rig pixels**: the whole figure is about 600 px tall, so the body is about 300x420, the head about 320x300, an arm about 60x200. Keep a margin of at least half the stroke width inside the viewBox so the outline is not clipped.
- **Overlap at the joints.** A part that rotates must hide its joint: the arm's top end is a round shape that overlaps the torso (draw it 20 px past the shoulder), the head's bottom (neck) overlaps the body, the feet overlap the leg ends. Never leave a visible gap or a hard cut edge at a joint at the rotation limits.
- **Facing.** Draw the figure facing **right** (or tell `drawnFacing`): a three-quarter or front view that still reads when the whole actor is flipped horizontally. No text, no one-sided details that become wrong when mirrored (a number, a letter).

## The parts and their pivots

A rig is these parts (`rig.json`, `parts/*.svg`), all ids lowercase:

| id | what | pivot (in the part's own pixels) | `at` (where the pivot sits in the parent's pixels) | z |
|---|---|---|---|---|
| `body` | torso and legs to the feet line | bottom centre, the feet point | `[0, 0]` (root) | 10 |
| `feet` | the two shoes | centre of the pair | on the body's feet line | 8 |
| `head` | head with hair/hat, no face | the neck, bottom centre | the neck joint on the body | 20 |
| `arm_l` | the arm on the far side, hanging down | the shoulder (centre of the round top) | the shoulder on the body | 5 |
| `arm_r` | the arm on the near side, hanging down | the shoulder | the shoulder on the body | 25 |

- The root part is `body` with `parent: null`, `at: [0, 0]` and its `pivot` at the feet point: the actor's stage position is that point. Every other part names `parent: "body"` (arms and feet and head all hang off the body; you may add a `hand` or `tail`, `ear`, `hat` part with a parent if the character needs one, ids in lowercase).
- `rot` is the rotation limit in degrees `[min, max]`: head `[-12, 12]`, arms `[-160, 40]` (0 = hanging down, negative = lifted forward/up).
- `height` is the whole figure in px (feet point to top of head), about 600.
- A part is rotated about its `pivot`, which is placed at `at` in the parent: so for the arm, `at` is where the shoulder is on the torso, and the arm hangs down from there.

### Worked numbers (a 630 px figure)

- body.svg `viewBox 0 0 300 420`: pivot `[150, 420]`, at `[0, 0]`.
- feet.svg `viewBox 0 0 180 40`: pivot `[90, 20]`, at `[150, 405]`, z 8.
- head.svg `viewBox 0 0 320 300`: pivot `[160, 285]`, at `[150, 75]`, z 20, rot `[-12, 12]`.
- arm_l.svg `viewBox 0 0 60 200`: pivot `[30, 24]`, at `[40, 105]`, z 5, rot `[-160, 40]`. arm_r.svg: pivot `[30, 24]`, at `[260, 105]`, z 25.
- `height`: 630. `move`: `{"bobPx": 8, "stepSeconds": 0.33}`.

## The face: swappable pieces

The face is three plates on the head, each file centred at its `at` (in the head's pixels): `face.eyes` (z 30), `face.brows` (z 31), `face.mouth` (z 32). Draw them with the same stroke width and colours as the head. `face.parent` is `head`.

### Three eye states (`face.eyes.states`: `open`, `half`, `closed`), viewBox about `0 0 150 60`
- `open`: two big white ellipses with a thick outline and a round dark pupil each (`<ellipse cx="38" cy="30" rx="26" ry="24" fill="#fff" stroke="#222" stroke-width="6"/><circle cx="44" cy="32" r="9" fill="#222"/>` and the same at cx 112).
- `half`: the same eyes with a flat lid that covers the upper half (a skin-coloured `rect` over the top half, with a straight stroke along the lid): sleepy or sad.
- `closed`: no eyeballs, two downward-curved lines (`<path d="M12 30 Q38 46 64 30" fill="none" stroke="#222" stroke-width="6" stroke-linecap="round"/>` and the same shifted): a blink and a smile-eye.

### Four brow states (`face.brows.states`: `neutral`, `happy`, `sad`, `surprised`), viewBox about `0 0 160 40`
Two short thick strokes (same colour as the outline, round caps). `neutral`: nearly flat, slightly arched. `happy`: raised high arches. `sad`: slanted so the inner ends are higher than the outer ones. `surprised`: very high round arches. The emotions of the rig map to these: `neutral`, `happy`, `sad`, `surprised` (brows) with eyes `open`, `open`, `half`, `open`.

### Eight mouth shapes (`face.mouth.shapes`), viewBox `0 0 100 60`, centred
The mouth must read at a glance when it flaps. Phase 1 plays `rest`, `E` and `A`; the other five are drawn now so the lip-sync can use them later without a redraw. The inside of an open mouth is the dark red `#8a2b2b` with a pink tongue `#e57f84` at the bottom; teeth are a white strip at the top (optional).
- `rest`: a closed, gently smiling line: `<path d="M22 28 Q50 42 78 28" fill="none" stroke="#222" stroke-width="6" stroke-linecap="round"/>`.
- `E` (half open, wide): `<path d="M16 26 Q50 22 84 26 Q50 52 16 26 Z" fill="#8a2b2b" stroke="#222" stroke-width="6" stroke-linejoin="round"/>`.
- `A` (open, round): `<ellipse cx="50" cy="31" rx="27" ry="23" fill="#8a2b2b" stroke="#222" stroke-width="6"/>` with a tongue `<ellipse cx="50" cy="44" rx="16" ry="8" fill="#e57f84"/>`.
- `O`: a rounded small opening: `<ellipse cx="50" cy="31" rx="15" ry="19" fill="#8a2b2b" stroke="#222" stroke-width="6"/>`.
- `U`: smaller and rounder: `<ellipse cx="50" cy="31" rx="10" ry="12" fill="#8a2b2b" stroke="#222" stroke-width="6"/>`.
- `MBP` (lips pressed): a short flat line with the ends slightly down: `<path d="M26 32 H74" stroke="#222" stroke-width="7" stroke-linecap="round"/>`.
- `FV` (teeth on the lower lip): `<path d="M20 22 Q50 18 80 22 L76 32 Q50 38 24 32 Z" fill="#8a2b2b" stroke="#222" stroke-width="6" stroke-linejoin="round"/>` with a white upper-teeth strip `<path d="M28 23 Q50 20 72 23 L70 30 Q50 34 30 30 Z" fill="#fff"/>` and the lower lip line `<path d="M30 40 Q50 48 70 40" fill="none" stroke="#222" stroke-width="6" stroke-linecap="round"/>`.
- `L` (tongue up): an open mouth like `E` with the pink tongue touching the top: `<ellipse cx="50" cy="26" rx="14" ry="8" fill="#e57f84"/>` inside it.

## Gestures and emotions (in `rig.json`)

Gestures animate one part about its pivot over `seconds`; keys are `[fraction 0..1, degrees]`. Give at least `wave` and `point` on `arm_r` and `shrug` on `arm_l`:
- `wave`: `{"part":"arm_r","seconds":1.0,"keys":[[0,-10],[0.25,-150],[0.5,-120],[0.75,-150],[1,-10]]}`
- `point`: `{"part":"arm_r","seconds":0.8,"keys":[[0,-10],[0.3,-85],[1,-85]]}`
- `shrug`: `{"part":"arm_l","seconds":0.8,"keys":[[0,-10],[0.4,-40],[1,-10]]}`
Emotions: `{"neutral":{"brows":"neutral","eyes":"open"},"happy":{"brows":"happy","eyes":"open"},"sad":{"brows":"sad","eyes":"half"},"surprised":{"brows":"surprised","eyes":"open"}}`.

## `rig.json` checklist (`cts_rig_check` enforces it)

`schema: "cts.rig/1"`, `id` = the cast id, `kind: "vector"`, `drawnFacing`, `height`, `parts` (src `parts/<id>.svg`), `face` (`parent: "head"`, `eyes`/`brows`/`mouth` each with `at`, `z` and their `states`/`shapes` files, e.g. `parts/eyes_open.svg`, `parts/brows_happy.svg`, `parts/mouth_A.svg`), `emotions`, `gestures`, `move`. All 8 mouth shapes, 3 eye states and 4 brow states must exist, every file must exist, SVGs must follow the rules above.

## Reference pictures (for the image prompt)

The reference is made by ComfyUI on a flat `#808080` grey: one character, full body, standing, **both arms held out away from the body** so each arm is clearly separate from the torso, legs slightly apart, a slight three-quarter view, flat solid colours, thick dark outline, no shadow, no floor, no other objects. Describe only the character (body shape, colours, clothes, face, one telling detail); the code adds the pose and the background. The picture will have a white sticker halo and soft edges: that is why you redraw it instead of tracing it.

## Drawing tools

If VectorCraft (the `vectorcraft` MCP server) is available in your session, it is the preferred way to draw the parts: `draw_shape`, `draw_path`, `set_paint`, `pathfinder`, check each part with `render_preview`, export SVG, then give the files to `cts_rig_set`. Otherwise write the SVG by hand following this guide. Either way finish with `cts_rig_set` (or the answer's `rig` and `parts`) and fix every error `cts_rig_check` reports.
