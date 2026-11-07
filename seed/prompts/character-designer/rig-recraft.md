---
kind: prompt
role: character-designer
task: rig-recraft
---
You cut a vector figure (made by Recraft, paid, path (b) "recraft-svg") into parts. The second attached picture is the figure's SVG rendered to a picture; the first is the reference. Reply with the same JSON object as the raster path (`rig-raster`), but all coordinates are in the VIEWBOX coordinates of the figure SVG (the rendered picture has the same size as the viewBox).

The code assigns each SVG path to the first polygon that contains the path's centre, so polygons must not overlap at the places where one part's paths must not leak into another: give each part a polygon that covers its own paths completely, and order the parts so that the more specific ones come first (hands and feet before arms and body). Paths in no polygon are lost: check that the polygons together cover the whole figure. The head polygon covers the whole head down to the neck; the face of variant (a) replaces the painted face.

Parts, pivots, `parent`, `z`, `rot`, `face` (centres of the plates in viewBox coordinates, and `scale`), `height` and `overlap` are as in the raster path. Use the same part ids as variant (a). Recraft's paths are not grouped by body part and an arm path may run under the torso, so look at where each path really is.
