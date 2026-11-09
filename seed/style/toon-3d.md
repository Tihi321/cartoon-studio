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

`style3d.json` (`cts.style3d/1`) holds these numbers; the default (the file the bible step writes) is:

```jsonc
{"schema": "cts.style3d/1", "toon": {"shade": 0.74, "threshold": 0.36}, "outline": {"colour": "#2b2118", "scale": 1}, "world": {"sky": {"top": "#86cdf0", "horizon": "#e4f6fb"}}, "sun": {"angle": [50, -10, -35], "energy": 3.2}, "samples": {"final": 16, "preview": 4}, "post": "none", "stepped": false}
```

`outline.scale` multiplies every outline width; `sun.angle` is the sun's rotation in degrees; `samples` are the EEVEE (TAA) samples of the final and the preview; `stepped: true` holds poses on twos for a stop-motion feel (off by default). A character's sheet and the episode both use this file, so change it before the sheets are approved, not after.

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

## A set spec (`sets/<id>/set3d.json`, `cts.set3d/1`)

A set is a ground, a sky, props from a small kit (round and cone trees, bush, bench with a seat, rock, flowers, fence, house, cloud), marks (ground points actors stand on or walk to) and named cameras. Far away is a larger y. The prompt `set-spec` has the kit table. The park of Pip and Bruno:

```json
{
  "schema": "cts.set3d/1",
  "id": "park",
  "ground": {"size": [40, 30], "colour": "#7cc35a", "patches": [{"shape": "rect", "at": [0, 0.7], "size": [12, 1.8], "colour": "#efd9a4"}]},
  "sky": {"top": "#86cdf0", "horizon": "#e4f6fb"},
  "props": [
    {"id": "oak", "kind": "tree_round", "at": [-4, 4.2], "scale": 1.4},
    {"id": "bench", "kind": "bench", "at": [2.2, 2.6], "rot": -12, "seat": {"height": 0.45, "at": [0, -0.1]}},
    {"id": "pine1", "kind": "tree_cone", "at": [5.5, 9]},
    {"id": "pine2", "kind": "tree_cone", "at": [-4.5, 14]},
    {"id": "pine3", "kind": "tree_cone", "at": [12, 10]},
    {"id": "round1", "kind": "tree_round", "at": [-8, 11]},
    {"id": "round2", "kind": "tree_round", "at": [9, 13]},
    {"id": "bush1", "kind": "bush", "at": [4.6, 3.4], "scale": 0.9},
    {"id": "bush2", "kind": "bush", "at": [-1.8, 5]},
    {"id": "bush3", "kind": "bush", "at": [-6.5, 2.6], "scale": 1.1},
    {"id": "flowers1", "kind": "flowers", "at": [-1.2, 3.4], "scale": 1.2},
    {"id": "flowers2", "kind": "flowers", "at": [1.2, 5.2]},
    {"id": "rock1", "kind": "rock", "at": [-2.4, 2.0], "scale": 0.8},
    {"id": "cloud1", "kind": "cloud", "at": [-10, 30], "scale": 1.3},
    {"id": "cloud2", "kind": "cloud", "at": [8, 34], "scale": 1.3},
    {"id": "cloud3", "kind": "cloud", "at": [20, 28], "scale": 1.1}
  ],
  "marks": {
    "left": [-2.5, 0],
    "center": [0, 0],
    "right": [2.5, 0],
    "bench": [2.2, 1.8],
    "oak": [-3.0, 2.8]
  },
  "cameras": {
    "wide": {"loc": [0, -6, 1.4], "target": [0, 0, 0.8], "lens": 32},
    "bench": {"loc": [2.2, -3.2, 1.1], "target": [2.2, 2.5, 0.55], "lens": 40}
  }
}
```

## Vehicles (`kind: "vehicle"`)

A series about vehicles (a car, a train engine) uses the same spec with `"kind": "vehicle"`. A vehicle has **no arms, hands or legs**: an `arm_*`, `hand_*` or `leg_*` control is the error `E_VEHICLE_LIMB`.

- **Controls.** Required: `root`, `squash`, `body`, `head` (the front block with the face; it tilts and turns a little), `lid_L/R`, `pupil_L/R`, `mouth`, and one `wheel_<n>` per wheel (parent `root`, at the wheel centre, **no rotation**, `z` equal to `vehicle.wheelRadius` so the tyre touches the ground). Optional: `brow_L/R` (the lamp visors), `chimney` and `exhaust` (puff sources), `horn`, `antenna1..n` (a chain: each the parent of the next; the pennant hangs on the last link), `acc_<name>1..n`.
- **`vehicle`**: `{type: car | train, wheelRadius, wheels: [every wheel control], track}` (a train has `track: true`). **`motion`** has `drive {style: zip | chug, topSpeed, accel, suspension}` instead of `walk`.
- **Wheels.** Give each wheel control a `cylinder` part `[radius, width]` with `rot [0, 90, 0]` (the tyre turns about x). The builder adds a hub with three bolts on the outer face (palette `hub`, else `cream`, `chrome`, `brass`) so the spin reads, and records each wheel's axis and radius in `build.json`. Without a tyre part the builder makes a default one.
- **Shapes.** `cylinder` `[radius, length]` (along z, centred) for wheels, chimneys, buffers, a whip antenna. On a vehicle a `box` has well rounded corners (30 % of its smallest side, up to 30 cm): a loaf body, a flat rounded-rectangle nose.
- **Puffs.** A `chimney` or `exhaust` control gets a pool of 8 cloud puffs at its outlet (the chimney top, the exhaust's rear end), hidden at rest; the acting library releases them.

**The face: lamp-eyes and a bumper-mouth** (the series rule, decision 10 of HUB-31):

- **The eyes are the vehicle's own front lamps.** `face.eyes` places two round lamps on the `head`; `eyes.lamp {glow, rim}` gives the colour they flash with and the palette colour of the rim. The builder makes a pale lens dome in a rim, seated in a pod in the `lids` colour, a dark pupil disc that aims, a hood that is the lid (blink, half lid, squint) and a visor from `brows` (in chrome or brass). `head["lamp_glow"]` (0 to 1) makes both lamps glow.
- **The mouth is the bumper slot** (a car) or **the buffer-beam slot** (a train), under the lamps: `face.mouth` as for creatures; the six slots are rounded slots.
- **Not like this:** no eyes in the windscreen or a cab window (windows stay plain tinted glass), no face on a round smokebox door, no human nose, no cheeks, no sculpted face plate. Keep two round discs beside the mouth (buffers) dark and small so they do not read as cheeks.
- The ray test applies: a lamp or the mouth buried in the body or the front block is `E_FACE_HIDDEN`; a lamp whose pod does not rest on a wing or the nose is a warning.

Pip, a small zippy car: a round one-box "pebble" in orange with a cream lower front, the lamp-eyes raised on top of the front wings and close together (they read from the side and the three-quarter view too), four short fat wheels with cream hubs, a short bumper-mouth, a dark windscreen set back above the lamps, and a whip antenna with a green pennant (about 1.6 m long, 1.1 m to the roof):

```json
{
  "schema": "cts.character3d/1",
  "id": "pip",
  "units": "m",
  "kind": "vehicle",
  "height": 1.1,
  "palette": {"body": "#d9792b", "cream": "#f3dfb5", "tyre": "#3b302a", "glass": "#3a4a5a", "chrome": "#cfcfcf", "pennant": "#6fae4f"},
  "motion": {"tempo": 1.4, "energy": 1.1, "bounce": 0.8, "drive": {"style": "zip", "topSpeed": 3, "accel": 3, "suspension": 0.75}},
  "vehicle": {"type": "car", "wheelRadius": 0.2, "wheels": ["wheel_1", "wheel_2", "wheel_3", "wheel_4"], "track": false},
  "controls": {
    "root": {"parent": null, "at": [0, 0, 0]},
    "squash": {"parent": "root", "at": [0, 0, 0]},
    "body": {"parent": "squash", "at": [0, 0, 0.5]},
    "head": {"parent": "body", "at": [0, -0.5, 0]},
    "lid_L": {"parent": "head", "at": [-0.2, -0.1, 0.32]},
    "lid_R": {"parent": "head", "at": [0.2, -0.1, 0.32]},
    "pupil_L": {"parent": "head", "at": [-0.2, -0.1, 0.32]},
    "pupil_R": {"parent": "head", "at": [0.2, -0.1, 0.32]},
    "brow_L": {"parent": "head", "at": [-0.2, -0.13, 0.46]},
    "brow_R": {"parent": "head", "at": [0.2, -0.13, 0.46]},
    "mouth": {"parent": "head", "at": [0, -0.35, -0.14]},
    "exhaust": {"parent": "body", "at": [0.26, 0.74, -0.2]},
    "wheel_1": {"parent": "root", "at": [-0.5, -0.5, 0.2]},
    "wheel_2": {"parent": "root", "at": [0.5, -0.5, 0.2]},
    "wheel_3": {"parent": "root", "at": [-0.5, 0.5, 0.2]},
    "wheel_4": {"parent": "root", "at": [0.5, 0.5, 0.2]},
    "antenna1": {"parent": "body", "at": [0.32, 0.45, 0.22]},
    "antenna2": {"parent": "antenna1", "at": [0, 0, 0.28]},
    "antenna3": {"parent": "antenna2", "at": [0, 0, 0.28]}
  },
  "springs": {"antenna": {"stiffness": 40, "damping": 4}},
  "parts": [
    {"id": "body", "shape": "ellipsoid", "size": [0.6, 0.8, 0.32], "at": [0, 0, 0], "colour": "body", "control": "body", "outline": 0.012},
    {"id": "cabin", "shape": "ellipsoid", "size": [0.48, 0.5, 0.32], "at": [0, 0.12, 0.28], "colour": "body", "control": "body", "outline": 0.012},
    {"id": "windscreen", "shape": "ellipsoid", "size": [0.34, 0.06, 0.11], "at": [0, -0.23, 0.52], "rot": [-45, 0, 0], "colour": "glass", "control": "body", "outline": 0.006},
    {"id": "window_L", "shape": "ellipsoid", "size": [0.05, 0.26, 0.13], "at": [-0.43, 0.14, 0.33], "colour": "glass", "control": "body", "outline": 0.006},
    {"id": "window_R", "shape": "ellipsoid", "size": [0.05, 0.26, 0.13], "at": [0.43, 0.14, 0.33], "colour": "glass", "control": "body", "outline": 0.006},
    {"id": "front", "shape": "ellipsoid", "size": [0.5, 0.3, 0.2], "at": [0, -0.05, -0.1], "colour": "cream", "control": "head", "outline": 0.01},
    {"id": "wing_L", "shape": "ellipsoid", "size": [0.2, 0.3, 0.12], "at": [-0.27, 0.05, 0.2], "colour": "body", "control": "head", "outline": 0.01},
    {"id": "wing_R", "shape": "ellipsoid", "size": [0.2, 0.3, 0.12], "at": [0.27, 0.05, 0.2], "colour": "body", "control": "head", "outline": 0.01},
    {"id": "exhaust", "shape": "cylinder", "size": [0.035, 0.12], "at": [0, 0, 0], "rot": [90, 0, 0], "colour": "chrome", "control": "exhaust"},
    {"id": "wheel_1", "shape": "cylinder", "size": [0.2, 0.18], "at": [0, 0, 0], "rot": [0, 90, 0], "colour": "tyre", "control": "wheel_1"},
    {"id": "wheel_2", "shape": "cylinder", "size": [0.2, 0.18], "at": [0, 0, 0], "rot": [0, 90, 0], "colour": "tyre", "control": "wheel_2"},
    {"id": "wheel_3", "shape": "cylinder", "size": [0.2, 0.18], "at": [0, 0, 0], "rot": [0, 90, 0], "colour": "tyre", "control": "wheel_3"},
    {"id": "wheel_4", "shape": "cylinder", "size": [0.2, 0.18], "at": [0, 0, 0], "rot": [0, 90, 0], "colour": "tyre", "control": "wheel_4"},
    {"id": "antenna1", "shape": "cylinder", "size": [0.01, 0.28], "at": [0, 0, 0.14], "colour": "chrome", "control": "antenna1", "outline": 0.004},
    {"id": "antenna2", "shape": "cylinder", "size": [0.008, 0.28], "at": [0, 0, 0.14], "colour": "chrome", "control": "antenna2", "outline": 0.004},
    {"id": "pennant", "shape": "ellipsoid", "size": [0.006, 0.11, 0.05], "at": [0, 0.1, -0.03], "rot": [-12, 0, 0], "colour": "pennant", "control": "antenna3", "outline": 0.004}
  ],
  "face": {
    "control": "head",
    "eyes": {"x": 0.2, "z": 0.32, "r": 0.13, "faceY": -0.1, "pupil": {"size": 0.06, "lead": 0.008}, "lamp": {"glow": "#fff2b0", "rim": "chrome"}},
    "lids": {"colour": "body"},
    "brows": {"colour": "chrome", "at": [0.2, -0.13, 0.46], "length": 0.2},
    "mouth": {"at": [0, -0.35, -0.14], "scale": 0.09, "inner": "#3a2020"}
  }
}
```

Bruno, a big gentle train engine: a long rounded "loaf" in two browns on six wheels, a flat rounded-rectangle nose (no round smokebox front), two big cream lamp-eyes low on the nose on the buffer-beam line under heavy dark hoods (a sleepy, kind look), a wide buffer-beam mouth between two small dark buffers, a skirt in front of the wheels, a short chimney that puffs, a row of rounded roof vents (a nod to his hedgehog spines), a small brass bell and a whistle on the cab (about 4 m long, 2.2 m high):

```json
{
  "schema": "cts.character3d/1",
  "id": "bruno",
  "units": "m",
  "kind": "vehicle",
  "height": 2.2,
  "palette": {"body": "#8a5a35", "dark": "#4e3423", "cream": "#f3dfb5", "hub": "#c9a64a", "brass": "#c9a64a", "glass": "#3a4a5a"},
  "motion": {"tempo": 0.75, "energy": 0.8, "bounce": 0.2, "drive": {"style": "chug", "topSpeed": 2, "accel": 0.6, "suspension": 0.4}},
  "vehicle": {"type": "train", "wheelRadius": 0.32, "wheels": ["wheel_1", "wheel_2", "wheel_3", "wheel_4", "wheel_5", "wheel_6"], "track": true},
  "controls": {
    "root": {"parent": null, "at": [0, 0, 0]},
    "squash": {"parent": "root", "at": [0, 0, 0]},
    "body": {"parent": "squash", "at": [0, 0, 1.0]},
    "head": {"parent": "body", "at": [0, -1.95, 0]},
    "lid_L": {"parent": "head", "at": [-0.36, -0.17, 0]},
    "lid_R": {"parent": "head", "at": [0.36, -0.17, 0]},
    "pupil_L": {"parent": "head", "at": [-0.36, -0.17, 0]},
    "pupil_R": {"parent": "head", "at": [0.36, -0.17, 0]},
    "brow_L": {"parent": "head", "at": [-0.36, -0.22, 0.3]},
    "brow_R": {"parent": "head", "at": [0.36, -0.22, 0.3]},
    "mouth": {"parent": "head", "at": [0, -0.29, -0.28]},
    "chimney": {"parent": "body", "at": [0, -1.45, 0.8]},
    "wheel_1": {"parent": "root", "at": [-0.6, -1.25, 0.32]},
    "wheel_2": {"parent": "root", "at": [0.6, -1.25, 0.32]},
    "wheel_3": {"parent": "root", "at": [-0.6, 0, 0.32]},
    "wheel_4": {"parent": "root", "at": [0.6, 0, 0.32]},
    "wheel_5": {"parent": "root", "at": [-0.6, 1.25, 0.32]},
    "wheel_6": {"parent": "root", "at": [0.6, 1.25, 0.32]}
  },
  "parts": [
    {"id": "frame", "shape": "box", "size": [1.36, 3.7, 0.3], "at": [0, 0.05, -0.28], "colour": "dark", "control": "body", "outline": 0.015},
    {"id": "boiler", "shape": "box", "size": [1.2, 2.3, 0.95], "at": [0, -0.75, 0.33], "colour": "body", "control": "body", "outline": 0.018},
    {"id": "cab", "shape": "box", "size": [1.36, 1.3, 1.3], "at": [0, 1.2, 0.5], "colour": "body", "control": "body", "outline": 0.018},
    {"id": "roof", "shape": "box", "size": [1.5, 1.5, 0.14], "at": [0, 1.2, 1.17], "colour": "dark", "control": "body", "outline": 0.015},
    {"id": "window_L", "shape": "box", "size": [0.04, 0.55, 0.42], "at": [-0.69, 1.15, 0.72], "colour": "glass", "control": "body", "outline": 0.008},
    {"id": "window_R", "shape": "box", "size": [0.04, 0.55, 0.42], "at": [0.69, 1.15, 0.72], "colour": "glass", "control": "body", "outline": 0.008},
    {"id": "vent1", "shape": "ellipsoid", "size": [0.15, 0.12, 0.11], "at": [0, -1.05, 0.8], "colour": "dark", "control": "body", "outline": 0.01},
    {"id": "vent2", "shape": "ellipsoid", "size": [0.15, 0.12, 0.11], "at": [0, -0.7, 0.8], "colour": "dark", "control": "body", "outline": 0.01},
    {"id": "vent3", "shape": "ellipsoid", "size": [0.15, 0.12, 0.11], "at": [0, -0.35, 0.8], "colour": "dark", "control": "body", "outline": 0.01},
    {"id": "vent4", "shape": "ellipsoid", "size": [0.15, 0.12, 0.11], "at": [0, 0.0, 0.8], "colour": "dark", "control": "body", "outline": 0.01},
    {"id": "bell", "shape": "cone", "size": [0.08, 0.14, 0.035], "at": [0, 0.25, 0.88], "colour": "brass", "control": "body", "outline": 0.006},
    {"id": "bell_top", "shape": "ellipsoid", "size": [0.035], "at": [0, 0.25, 0.97], "colour": "brass", "control": "body", "outline": 0.004},
    {"id": "whistle", "shape": "cylinder", "size": [0.03, 0.12], "at": [0.45, 0.6, 1.29], "colour": "brass", "control": "body", "outline": 0.004},
    {"id": "nose", "shape": "box", "size": [1.3, 0.6, 1.1], "at": [0, 0.15, 0.25], "colour": "body", "control": "head", "outline": 0.018},
    {"id": "hood_L", "shape": "ellipsoid", "size": [0.25, 0.12, 0.1], "at": [-0.36, -0.17, 0.2], "colour": "dark", "control": "head", "outline": 0.008},
    {"id": "hood_R", "shape": "ellipsoid", "size": [0.25, 0.12, 0.1], "at": [0.36, -0.17, 0.2], "colour": "dark", "control": "head", "outline": 0.008},
    {"id": "skirt", "shape": "box", "size": [1.5, 0.12, 0.44], "at": [0, -0.1, -0.7], "colour": "dark", "control": "head", "outline": 0.012},
    {"id": "beam", "shape": "box", "size": [1.56, 0.22, 0.3], "at": [0, -0.17, -0.28], "colour": "cream", "control": "head", "outline": 0.012},
    {"id": "buffer_L", "shape": "cylinder", "size": [0.07, 0.2], "at": [-0.64, -0.35, -0.28], "rot": [90, 0, 0], "colour": "dark", "control": "head", "outline": 0.008},
    {"id": "buffer_R", "shape": "cylinder", "size": [0.07, 0.2], "at": [0.64, -0.35, -0.28], "rot": [90, 0, 0], "colour": "dark", "control": "head", "outline": 0.008},
    {"id": "bufferhead_L", "shape": "cylinder", "size": [0.11, 0.04], "at": [-0.64, -0.46, -0.28], "rot": [90, 0, 0], "colour": "dark", "control": "head", "outline": 0.006},
    {"id": "bufferhead_R", "shape": "cylinder", "size": [0.11, 0.04], "at": [0.64, -0.46, -0.28], "rot": [90, 0, 0], "colour": "dark", "control": "head", "outline": 0.006},
    {"id": "chimney", "shape": "cylinder", "size": [0.15, 0.34], "at": [0, 0, 0.12], "colour": "dark", "control": "chimney", "outline": 0.01},
    {"id": "chimney_cap", "shape": "cylinder", "size": [0.2, 0.07], "at": [0, 0, 0.3], "colour": "dark", "control": "chimney", "outline": 0.01},
    {"id": "wheel_1", "shape": "cylinder", "size": [0.32, 0.16], "at": [0, 0, 0], "rot": [0, 90, 0], "colour": "dark", "control": "wheel_1"},
    {"id": "wheel_2", "shape": "cylinder", "size": [0.32, 0.16], "at": [0, 0, 0], "rot": [0, 90, 0], "colour": "dark", "control": "wheel_2"},
    {"id": "wheel_3", "shape": "cylinder", "size": [0.32, 0.16], "at": [0, 0, 0], "rot": [0, 90, 0], "colour": "dark", "control": "wheel_3"},
    {"id": "wheel_4", "shape": "cylinder", "size": [0.32, 0.16], "at": [0, 0, 0], "rot": [0, 90, 0], "colour": "dark", "control": "wheel_4"},
    {"id": "wheel_5", "shape": "cylinder", "size": [0.32, 0.16], "at": [0, 0, 0], "rot": [0, 90, 0], "colour": "dark", "control": "wheel_5"},
    {"id": "wheel_6", "shape": "cylinder", "size": [0.32, 0.16], "at": [0, 0, 0], "rot": [0, 90, 0], "colour": "dark", "control": "wheel_6"}
  ],
  "face": {
    "control": "head",
    "eyes": {"x": 0.36, "z": 0, "r": 0.2, "faceY": -0.17, "pupil": {"size": 0.085, "lead": 0.01}, "lamp": {"glow": "#fff2b0", "rim": "brass"}},
    "lids": {"colour": "dark"},
    "brows": {"colour": "brass", "at": [0.36, -0.22, 0.3], "length": 0.42},
    "mouth": {"at": [0, -0.29, -0.28], "scale": 0.2, "inner": "#3a2020"}
  }
}
```

The two differ in silhouette (small and round against long and low), main colour and scale.

## The sheet

`cts_character_build` writes `cast/<id>/sheet.png` (2048 x 1024): row 1 front, three-quarter, side, back; row 2 the six mouths, blink, half lid; row 3 neutral, happy, sad, surprised, look left, look right. The pieces are in `cast/<id>/sheet/`. A vehicle's sheet is 2048 x 1280 with a fourth row, its motion strip: squash, stretch, lean left, lean right, nose up, and honk (a car, the lamps glowing) or puff (a train with a chimney). A set sheet (`sets/<id>/sheet.png`, 2048 x 1152) has four views: auto wide, two stand-ins on the first two marks, then the first two named cameras. Read it with your eyes (vision) and check: the colours match the bible's `look`, the silhouette reads, the eyes and mouth sit on the face, every mouth shape differs, the lids cover the eyes, no part floats or pokes through another, the back and side look finished. For a vehicle also: the eyes are the front lamps (not in a window), the mouth is the bumper or buffer-beam slot, no nose, cheeks or smokebox face, the wheels touch the ground line, and no limb anywhere. Fix the spec and build again, **at most two revisions**; then the user decides.
