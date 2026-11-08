---
kind: style
---
# The 3D toon style (ages 4 to 8)

This is the guide for the character-designer and the background-artist of a series that renders in Blender (`renderer: "blender"`). A character or a set is **data**: a JSON spec of simple shapes that a Python builder turns into a Blender file. No AI picture is an input. The same file is used in every shot and in both languages, so a character never drifts.

## The look (`style3d.json`, one per series)

Flat toon shading with a clean ink outline, close to a children's picture book:

- Each colour is a **two-tone**: its palette colour where lit, the same colour about 26 % darker in shade (`toon.shade` 0.74, `toon.threshold` 0.36). The palette hex is what you see in the light, exactly.
- A dark **outline** (`#2b2118`) of 3 % of the part's size, between 4 mm and 3 cm. A part has `outline: 0` for none (nose, eye patches, inner ear), or a width in metres.
- A sun with no cast shadows, a soft **blob shadow** under each character, a sky gradient, no raytracing. `post` is `none` (default), `paper` (grain) or `posterize` (flat bands, crushes dark spines: avoid).
- Choose palette colours with **clear value contrast** between neighbours (a light belly on a dark body, a pale muzzle). Avoid pure black and pure white in big areas.

## A character spec (`cast/<id>/character.json`, `cts.character3d/1`)

Units are metres, z is up, a character faces **-y** at rest, `_L` parts sit at **-x** (the viewer's left when the character faces the camera) and `_R` at +x. Rotations are degrees.

**Controls** are parented empties; parts hang on them and the animation moves them. Required: `root` (the ground point, parent null), `squash` (parent root, scale about the feet), `body` (the hips: lean), `head`, `arm_L`, `arm_R` (shoulder pivots), `lid_L`, `lid_R`, `pupil_L`, `pupil_R` (both at the eye), `mouth`. Optional: `leg_L`, `leg_R` (hip pivots; a character without legs hops or slides), `hand_L/R`, `brow_L/R`, `ear_L1..n` / `ear_R1..n` (a chain: each the parent of the next), `tail1..n`, `acc_<name>1..n` (a scarf end, a hat feather). Put a control where the part should **turn**: the shoulder, the hip, the base of an ear, the root of a tail.

**Parts** (`parts` and `accessories`): `shape` + `size` + `at` (relative to the control) + `rot` + `colour` (a palette name) + `control`.

| shape | size | notes |
|---|---|---|
| `ellipsoid` | `[rx, ry, rz]` | the workhorse: bodies, heads, hands, feet |
| `cone` | `[radius, height, tip radius?]` | centred, tip up (+z); ears, trunks, a party hat |
| `capsule` | `[radius, length]` | length end to end along z; thin arms, legs |
| `box` | `[x, y, z]` | rounded edges; a book |
| `torus` | `[R, r, stretch x?]` | a ring around z: a scarf, a collar |
| `arc` | `[R, r, sweep]` | a tube along an arc: a smile, an eyebrow line |
| `spines` | `[rx, ry, rz]` and `spines {count, length, radius, keep, lean}` | many cones on an ellipsoid: a hedgehog's back. `keep` back, top or all; `lean` 0..1 tilts them backwards |

**Face** (`face`): `eyes {x, z, r, faceY, pupil {size, lead}}` (`x` the half distance between the eyes, `z` their height in the head, `r` the eye radius, `faceY` the y of the eye centre, `pupil.size` the pupil radius, `lead` how far the pupil stands in front of the eyeball); `lids {colour}`; optional `brows {colour, at, length}`; `mouth {at, scale, inner, tongue?}` (`scale` is the half width of the open `A` mouth: 0.06 for a head about 0.5 m wide; `inner` the colour inside). The builder makes the six mouth shapes `rest A E O U MBP` from it, and a blink and a half lid from the lids.

**The face must be on the face.** The builder shoots a ray from the front at each eye and the mouth: a feature buried in the head is the error `E_FACE_HIDDEN` (move it forward, i.e. more negative y, or shrink the part in front of it); one that floats more than 8 mm off the surface is a warning. Work out the head surface at the eye (for an ellipsoid skull centred at (cx, cy, cz): y = cy - ry * sqrt(1 - ((x-cx)/rx)^2 - ((z-cz)/rz)^2)) and put `faceY` so the eyeball (0.6 r deep) stands out of it.

**Motion profile** (`motion`): `tempo` (gesture speed: a quick character 1.4, a slow one 0.75), `energy` (amplitude), `bounce` (hop and idle bob), `walk {style: walk | hop | waddle, stride, cadence}`. `springs` gives stiffness and damping of the secondary chains (`ear_L`, `tail`, `acc_scarf`): soft and slow for a tail, stiffer for small ears.

**Design for the silhouette.** A big round head (a third of the height), clear arms away from the body, an unmistakable tail or ears, one telling accessory. Two characters must differ in silhouette and main colour.

## Examples: Pip and Bruno, the probe characters as specs

Pip, a quick orange squirrel with a green scarf (hop-walk, three-joint tail, tempo 1.4):

```json
{
  "schema": "cts.character3d/1",
  "id": "pip",
  "units": "m",
  "height": 1.05,
  "palette": {
    "orange": "#e8843a",
    "cream": "#f6e2b8",
    "brown": "#8a5a35",
    "green": "#6fbf5a",
    "nose": "#4a2a1e"
  },
  "motion": {"tempo": 1.4, "energy": 1.1, "bounce": 1, "walk": {"style": "hop", "stride": 0.85, "cadence": 2.4}},
  "controls": {
    "root": {"parent": null, "at": [0, 0, 0]},
    "squash": {"parent": "root", "at": [0, 0, 0]},
    "body": {"parent": "squash", "at": [0, 0, 0.2]},
    "head": {"parent": "body", "at": [0, 0, 0.42]},
    "arm_L": {"parent": "body", "at": [-0.16, -0.02, 0.3]},
    "arm_R": {"parent": "body", "at": [0.16, -0.02, 0.3]},
    "leg_L": {"parent": "squash", "at": [-0.09, 0, 0.2]},
    "leg_R": {"parent": "squash", "at": [0.09, 0, 0.2]},
    "ear_L1": {"parent": "head", "at": [-0.15, 0, 0.38], "rot": [0, 18, 0]},
    "ear_R1": {"parent": "head", "at": [0.15, 0, 0.38], "rot": [0, -18, 0]},
    "tail1": {"parent": "body", "at": [0.08, 0.13, 0], "rot": [-20, 35, 0]},
    "tail2": {"parent": "tail1", "at": [0, 0.04, 0.24]},
    "tail3": {"parent": "tail2", "at": [0, 0, 0.28], "rot": [35, 0, 0]},
    "acc_scarf1": {"parent": "body", "at": [0.1, -0.1, 0.32], "rot": [17, 23, 17]},
    "lid_L": {"parent": "head", "at": [-0.095, -0.19, 0.27]},
    "lid_R": {"parent": "head", "at": [0.095, -0.19, 0.27]},
    "pupil_L": {"parent": "head", "at": [-0.095, -0.19, 0.27]},
    "pupil_R": {"parent": "head", "at": [0.095, -0.19, 0.27]},
    "brow_L": {"parent": "head", "at": [-0.095, -0.178, 0.35]},
    "brow_R": {"parent": "head", "at": [0.095, -0.178, 0.35]},
    "mouth": {"parent": "head", "at": [0, -0.25, 0.095]}
  },
  "springs": {
    "ear_L": {"stiffness": 70, "damping": 6},
    "ear_R": {"stiffness": 70, "damping": 6},
    "tail": {"stiffness": 45, "damping": 4},
    "acc_scarf": {"stiffness": 35, "damping": 5}
  },
  "parts": [
    {"id": "body", "shape": "ellipsoid", "size": [0.19, 0.16, 0.24], "at": [0, 0, 0.16], "colour": "orange", "control": "body"},
    {"id": "belly", "shape": "ellipsoid", "size": [0.12, 0.05, 0.16], "at": [0, -0.125, 0.14], "colour": "cream", "control": "body", "outline": 0.005},
    {"id": "leg_L", "shape": "ellipsoid", "size": [0.065, 0.065, 0.1], "at": [0, 0, -0.08], "colour": "orange", "control": "leg_L"},
    {"id": "foot_L", "shape": "ellipsoid", "size": [0.07, 0.1, 0.04], "at": [-0.01, -0.04, -0.17], "colour": "brown", "control": "leg_L"},
    {"id": "leg_R", "shape": "ellipsoid", "size": [0.065, 0.065, 0.1], "at": [0, 0, -0.08], "colour": "orange", "control": "leg_R"},
    {"id": "foot_R", "shape": "ellipsoid", "size": [0.07, 0.1, 0.04], "at": [0.01, -0.04, -0.17], "colour": "brown", "control": "leg_R"},
    {"id": "armmesh_L", "shape": "ellipsoid", "size": [0.045, 0.045, 0.13], "at": [0, 0, -0.11], "colour": "orange", "control": "arm_L"},
    {"id": "hand_L", "shape": "ellipsoid", "size": [0.055, 0.05, 0.055], "at": [0, 0, -0.24], "colour": "cream", "control": "arm_L"},
    {"id": "armmesh_R", "shape": "ellipsoid", "size": [0.045, 0.045, 0.13], "at": [0, 0, -0.11], "colour": "orange", "control": "arm_R"},
    {"id": "hand_R", "shape": "ellipsoid", "size": [0.055, 0.05, 0.055], "at": [0, 0, -0.24], "colour": "cream", "control": "arm_R"},
    {"id": "scarf", "shape": "torus", "size": [0.13, 0.045, 1.05], "at": [0, 0, 0.4], "colour": "green", "control": "body"},
    {"id": "scarf_tail", "shape": "ellipsoid", "size": [0.05, 0.03, 0.1], "at": [0, 0, 0], "colour": "green", "control": "acc_scarf1"},
    {"id": "skull", "shape": "ellipsoid", "size": [0.25, 0.23, 0.23], "at": [0, 0, 0.22], "colour": "orange", "control": "head"},
    {"id": "muzzle", "shape": "ellipsoid", "size": [0.14, 0.09, 0.09], "at": [0, -0.17, 0.14], "colour": "cream", "control": "head", "outline": 0.005},
    {"id": "nose", "shape": "ellipsoid", "size": [0.035, 0.03, 0.026], "at": [0, -0.255, 0.19], "colour": "nose", "control": "head", "outline": 0},
    {"id": "eyepatch_L", "shape": "ellipsoid", "size": [0.085, 0.04, 0.095], "at": [-0.095, -0.17, 0.27], "colour": "cream", "control": "head", "outline": 0},
    {"id": "eyepatch_R", "shape": "ellipsoid", "size": [0.085, 0.04, 0.095], "at": [0.095, -0.17, 0.27], "colour": "cream", "control": "head", "outline": 0},
    {"id": "ear_L", "shape": "cone", "size": [0.075, 0.2, 0.008], "at": [0, 0, 0.08], "colour": "orange", "control": "ear_L1"},
    {"id": "earin_L", "shape": "cone", "size": [0.045, 0.13, 0.004], "at": [0, -0.035, 0.07], "rot": [-8, 0, 0], "colour": "cream", "control": "ear_L1", "outline": 0},
    {"id": "ear_R", "shape": "cone", "size": [0.075, 0.2, 0.008], "at": [0, 0, 0.08], "colour": "orange", "control": "ear_R1"},
    {"id": "earin_R", "shape": "cone", "size": [0.045, 0.13, 0.004], "at": [0, -0.035, 0.07], "rot": [-8, 0, 0], "colour": "cream", "control": "ear_R1", "outline": 0},
    {"id": "tail_a", "shape": "ellipsoid", "size": [0.11, 0.11, 0.15], "at": [0, 0.03, 0.12], "colour": "orange", "control": "tail1"},
    {"id": "tail_b", "shape": "ellipsoid", "size": [0.17, 0.15, 0.19], "at": [0, 0.02, 0.14], "colour": "orange", "control": "tail2"},
    {"id": "tail_c", "shape": "ellipsoid", "size": [0.15, 0.13, 0.15], "at": [0, -0.02, 0.1], "colour": "orange", "control": "tail3"}
  ],
  "face": {"control": "head", "eyes": {"x": 0.095, "z": 0.27, "r": 0.07, "faceY": -0.19, "pupil": {"size": 0.0385, "lead": 0.014}}, "lids": {"colour": "orange"}, "brows": {"colour": "brown", "at": [0.095, -0.178, 0.35], "length": 0.07}, "mouth": {"at": [0, -0.25, 0.095], "scale": 0.06, "inner": "#5a231d", "tongue": "#e98a8a"}}
}
```

Bruno, a slow stocky hedgehog (waddle, spines on the back and the head, tempo 0.75):

```json
{
  "schema": "cts.character3d/1",
  "id": "bruno",
  "units": "m",
  "height": 1.2,
  "palette": {
    "brown": "#9a6a42",
    "spine": "#5a3a25",
    "cream": "#f2deb6",
    "foot": "#5e3b24",
    "ear": "#c9a07a",
    "nose": "#3a2218"
  },
  "motion": {"tempo": 0.75, "energy": 0.8, "bounce": 0.3, "walk": {"style": "waddle", "stride": 0.3, "cadence": 1.4}},
  "controls": {
    "root": {"parent": null, "at": [0, 0, 0]},
    "squash": {"parent": "root", "at": [0, 0, 0]},
    "body": {"parent": "squash", "at": [0, 0, 0.2]},
    "head": {"parent": "body", "at": [0, 0, 0.52]},
    "arm_L": {"parent": "body", "at": [-0.26, -0.03, 0.35]},
    "arm_R": {"parent": "body", "at": [0.26, -0.03, 0.35]},
    "leg_L": {"parent": "squash", "at": [-0.12, 0, 0.19]},
    "leg_R": {"parent": "squash", "at": [0.12, 0, 0.19]},
    "ear_L1": {"parent": "head", "at": [-0.19, -0.08, 0.36]},
    "ear_R1": {"parent": "head", "at": [0.19, -0.08, 0.36]},
    "lid_L": {"parent": "head", "at": [-0.085, -0.235, 0.27]},
    "lid_R": {"parent": "head", "at": [0.085, -0.235, 0.27]},
    "pupil_L": {"parent": "head", "at": [-0.085, -0.235, 0.27]},
    "pupil_R": {"parent": "head", "at": [0.085, -0.235, 0.27]},
    "mouth": {"parent": "head", "at": [0, -0.239, 0.115]}
  },
  "springs": {
    "ear_L": {"stiffness": 90, "damping": 9},
    "ear_R": {"stiffness": 90, "damping": 9}
  },
  "parts": [
    {"id": "body", "shape": "ellipsoid", "size": [0.29, 0.25, 0.33], "at": [0, 0, 0.22], "colour": "brown", "control": "body", "outline": 0.01},
    {"id": "belly", "shape": "ellipsoid", "size": [0.19, 0.07, 0.22], "at": [0, -0.2, 0.2], "colour": "cream", "control": "body", "outline": 0.006},
    {"id": "spines_body", "shape": "spines", "size": [0.27, 0.24, 0.31], "at": [0, 0.02, 0.24], "colour": "spine", "control": "body", "outline": 0.005, "spines": {"count": 260, "length": 0.16, "radius": 0.05, "keep": "back", "lean": 0.6}},
    {"id": "leg_L", "shape": "ellipsoid", "size": [0.075, 0.075, 0.09], "at": [0, 0, -0.09], "colour": "brown", "control": "leg_L"},
    {"id": "foot_L", "shape": "ellipsoid", "size": [0.085, 0.11, 0.045], "at": [-0.01, -0.04, -0.155], "colour": "foot", "control": "leg_L"},
    {"id": "leg_R", "shape": "ellipsoid", "size": [0.075, 0.075, 0.09], "at": [0, 0, -0.09], "colour": "brown", "control": "leg_R"},
    {"id": "foot_R", "shape": "ellipsoid", "size": [0.085, 0.11, 0.045], "at": [0.01, -0.04, -0.155], "colour": "foot", "control": "leg_R"},
    {"id": "armmesh_L", "shape": "ellipsoid", "size": [0.055, 0.055, 0.12], "at": [0, 0, -0.1], "colour": "brown", "control": "arm_L"},
    {"id": "hand_L", "shape": "ellipsoid", "size": [0.06, 0.055, 0.055], "at": [0, 0, -0.22], "colour": "cream", "control": "arm_L"},
    {"id": "armmesh_R", "shape": "ellipsoid", "size": [0.055, 0.055, 0.12], "at": [0, 0, -0.1], "colour": "brown", "control": "arm_R"},
    {"id": "hand_R", "shape": "ellipsoid", "size": [0.06, 0.055, 0.055], "at": [0, 0, -0.22], "colour": "cream", "control": "arm_R"},
    {"id": "skull", "shape": "ellipsoid", "size": [0.26, 0.24, 0.24], "at": [0, 0, 0.22], "colour": "brown", "control": "head", "outline": 0.009},
    {"id": "face", "shape": "ellipsoid", "size": [0.2, 0.1, 0.18], "at": [0, -0.15, 0.2], "colour": "cream", "control": "head", "outline": 0.006},
    {"id": "spines_head", "shape": "spines", "size": [0.24, 0.22, 0.22], "at": [0, 0.03, 0.24], "colour": "spine", "control": "head", "outline": 0.005, "spines": {"count": 160, "length": 0.15, "radius": 0.045, "keep": "top", "lean": 0.35}},
    {"id": "ear_L", "shape": "ellipsoid", "size": [0.05, 0.03, 0.05], "at": [0, 0, 0], "colour": "ear", "control": "ear_L1"},
    {"id": "ear_R", "shape": "ellipsoid", "size": [0.05, 0.03, 0.05], "at": [0, 0, 0], "colour": "ear", "control": "ear_R1"},
    {"id": "nose", "shape": "ellipsoid", "size": [0.045, 0.04, 0.038], "at": [0, -0.255, 0.2], "colour": "nose", "control": "head", "outline": 0}
  ],
  "face": {"control": "head", "eyes": {"x": 0.085, "z": 0.27, "r": 0.058, "faceY": -0.235, "pupil": {"size": 0.032, "lead": 0.012}}, "lids": {"colour": "cream"}, "mouth": {"at": [0, -0.239, 0.115], "scale": 0.065, "inner": "#5a231d"}}
}
```

## The sheet

`cts_character_build` writes `cast/<id>/sheet.png` (2048 x 1024): row 1 front, three-quarter, side, back; row 2 the six mouths, blink, half lid; row 3 neutral, happy, sad, surprised, look left, look right. The pieces are in `cast/<id>/sheet/`. Read it with your eyes (vision) and check: the colours match the bible's `look`, the silhouette reads, the eyes and mouth sit on the face, every mouth shape differs, the lids cover the eyes, no part floats or pokes through another, the back and side look finished. Fix the spec and build again, **at most two revisions**; then the user decides.
