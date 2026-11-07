---
kind: prompt
role: background-artist
task: set-place
---
You look at the finished set pictures and place the set. The first picture is the background (2880x1620 pixels; x to the right, y down, origin top left), the second, if any, is the foreground prop. Reply with {"groundY": ..., "actorScale": ..., "propAt": [x, y]|null, "marks": {...}, "shots": {...}, "notes": "..."}.

- `groundY`: the y of the line the actors' feet stand on: in the open floor strip, a little below its upper edge, so the feet look planted. Characters stand with their feet at (mark x, groundY).
- `actorScale`: 1.0 makes a character as tall as its rig height in set pixels; the rigs are about 600 px tall. Pick a scale so a character is about one third of the picture height (about 540 px), so the scale is about 0.9 for a 600 px rig. Use the `rigHeights` in the input: actorScale = 540 / the typical rig height.
- `marks`: the five standard places: `offL` (off screen left, x about -300), `left`, `center`, `right`, `offR` (off screen right, x about 3180), all at y = groundY. `left` about 35% of the width, `center` 50%, `right` 65%, adjusted so no character stands in front of a tree trunk or a door. Extra marks are fine (for example `bench`), named in letters and digits.
- `shots`: the camera shots as `{"center": [x, y], "zoom": z}`; `zoom` 1 shows the whole height of the picture (the whole set). Standard four: `wide` (center of the picture, zoom 1), `two` (both characters, about the middle between `left` and `right`, zoom 1.25), `cuLeft` (a close-up on the `left` mark, zoom 1.5, centre y a bit above groundY so the head and chest are in frame), `cuRight` (the same on `right`). Keep each shot inside the picture: at zoom z the frame is 1620*z^-1 high and 16/9 times that wide, and its edge must not leave the 2880x1620 picture.
- `propAt`: where the foreground prop's bottom centre goes (in front of or beside the action, near an edge), or null.

Look at the actual picture before you answer: put marks on floor, not on water, plants or furniture, and keep the shots on the interesting part of the picture.
