---
kind: prompt
role: character-designer
task: rig-raster
---
You cut the master picture (`ref.png`, the character sheet picture the user approved) into rotatable PNG parts. This is rig path (c), "raster": the code keys the grey background away (and the white sticker halo), crops each part with the polygon you give plus an overlap at the joints, and makes the face states (mouths, eyes, brows) as image patches of the boxes you give. No SVG is drawn. Reply with one JSON object.

All coordinates are pixels of the master (`imageSize` in the input; x right, y down, origin top left). Use these part ids: `body` (the root), `head`, `arm_l` and `arm_r` (and `feet` or `tail` only when they must move on their own).

- `height`: the figure's height in px (feet to top of head) in the picture.
- `facing`: which way the figure looks in the picture ("left" or "right"); a front view looking at the camera is "right".
- `parts`: for each part `{id, parent, polygon, pivot, z, rot}`:
  - `polygon`: the outline of the part as 6 to 30 points, drawn a little INSIDE the real edge on the sides where another part overlaps it, and exactly on the outline on free sides. Parts must not leave holes: the head polygon covers the whole head (ears and fur included) down to the neck; the arms cover the whole arm from the shoulder to the hand; the body covers the torso, the legs, the feet and the tail. The code adds an overlap margin so the joints stay closed when a part rotates (about +-25 degrees at most).
  - `pivot`: the joint the part turns about (shoulder for an arm, neck for the head), in picture pixels. The root part (`parent: null`, normally `body`) has its pivot at the FEET point (bottom centre of the feet): the actor stands there.
  - `parent`: the id of the part it hangs from; `body` is the root (`null`); head and arms have `body`.
  - `z`: draw order: `arm_l` (far arm) 5, `body` 10, `head` 20, `arm_r` (near arm) 25.
  - `rot`: optional `[min, max]` degrees; arms `[-160, 40]`, head `[-12, 12]`.
- `face`: three boxes `[x, y, width, height]` in picture pixels:
  - `mouth`: the muzzle area around the painted mouth, large enough to hold the mouth WIDE OPEN (a big "ah" with the jaw dropped) and stretched in a grin, with about 15 px to spare on every side. The painted mouth is covered by the patch, so the box must hold all of it.
  - `eyes`: ONE box over both eyes (and the cheek rings or lids round them), with margin for closed lids.
  - `brows`: ONE box over both brows, just above the eyes (draw it where brows belong even when the master has none), tall enough for brows raised high.
  - Every box lies inside the head polygon, and the boxes do not overlap the nose.
- `overlap`: the overlap margin in px (6 is usual, at most 24).

Look at the picture before you answer. The face drawn in the master stays under the patches: the `rest`, `open` and `neutral` patches are cut from it and the other states are redrawn from it by Z-Image, so the boxes decide how well the mouths read.
