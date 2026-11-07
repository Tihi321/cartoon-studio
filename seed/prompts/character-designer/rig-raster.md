---
kind: prompt
role: character-designer
task: rig-raster
---
You cut the reference picture into rotatable PNG parts. This is rig path (c), "raster": the code keys the grey background away (and the white sticker halo), crops each part with the polygon you give plus an overlap at the joints, and puts the vector face of path (a) on the head. Reply with one JSON object.

All coordinates are pixels of the reference picture (`imageSize` in the input; x right, y down, origin top left). Use the same part ids as variant (a) (`partIdsOfVariantA` in the input: body, feet, head, arm_l, arm_r, ...).

- `height`: the figure's height in px (feet to top of head) in the picture.
- `facing`: which way the figure looks in the picture ("left" or "right").
- `parts`: for each part `{id, parent, polygon, pivot, z, rot}`:
  - `polygon`: the outline of the part as 6 to 16 points, drawn a little INSIDE the real edge on the sides where another part overlaps it, and exactly on the outline on free sides. Parts must not leave holes: the head polygon covers the whole head (hair included) down to the neck; the arms cover the whole arm from the shoulder; the body covers the torso and legs; the feet the shoes. The code adds an overlap margin so the joints stay closed when a part rotates (about +-25 degrees at most).
  - `pivot`: the joint the part turns about (shoulder for an arm, neck for the head), in picture pixels. The root part (`parent: null`, normally `body`) has its pivot at the FEET point (bottom centre of the feet): the actor stands there.
  - `parent`: the id of the part it hangs from; `body` is the root (`null`); head, arms and feet have `body`.
  - `z`: draw order: `feet` 8, `arm_l` (far arm) 5, `body` 10, `head` 20, `arm_r` (near arm) 25.
  - `rot`: optional `[min, max]` degrees; arms `[-160, 40]`, head `[-12, 12]`.
- `face`: where the eyes, the brows and the mouth go on the head, as the CENTRE of each plate in picture pixels, and `scale` (the face of path (a) is drawn for a 600 px figure; use `height / 600` of that variant's height, usually about 1).
- `overlap`: the overlap margin in px (6 is usual, at most 24).

Look at the picture before you answer. The face drawn in the reference is not used: the vector face replaces it, so the head part should show the head without caring about the painted eyes and mouth.
