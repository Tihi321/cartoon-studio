---
kind: prompt
role: character-designer
task: rig-claude
---
You draw the rig of one character as flat SVG parts, from the reference picture (the attached image). This is rig path (a), "claude-svg": the default, free, and the most reliable. Follow the style guide (the cutout puppet style) exactly: its part list, pivots, `at` values, the face plates, the eight mouths, the three eye states, the four brows, the gestures and the emotions.

## Steps
1. Look at the reference: proportions, colours, the characteristic details. Redraw; do not trace.
2. Draw the parts: `body`, `feet`, `head` (no face), `arm_l`, `arm_r` (plus any extra part the character needs, with a parent), and the face pieces: `eyes_open`, `eyes_half`, `eyes_closed`, `brows_neutral`, `brows_happy`, `brows_sad`, `brows_surprised`, `mouth_rest`, `mouth_A`, `mouth_E`, `mouth_O`, `mouth_U`, `mouth_MBP`, `mouth_FV`, `mouth_L`. If VectorCraft is available in your session, draw them there (draw_shape, draw_path, set_paint, render_preview, export SVG); otherwise write the SVG text by hand.
3. Write `rig.json` with the part list, `pivot` and `at` for each part (from the worked numbers of the guide, adjusted to your drawing), the face plates (`at`, `z`, the file of each state), `emotions`, `gestures` (at least `wave`, `point`, `shrug`), `move` and `height`.
4. Deliver it. EITHER answer with one JSON object {"rig": <the rig.json object>, "parts": {"parts/body.svg": "<svg>...", "parts/mouth_A.svg": "<svg>...", ...}, "notes": "..."} (every file the rig names must be a key of `parts`, keyed by its path in the rig), OR first call `cts_rig_set` with {series, cast, variant, rig, parts} (you get the `cts_rig_check` result back; fix every error and call again until it passes) and then answer {"viaTool": true, "notes": "..."}.

The engine runs `cts_rig_check` on what you deliver: a missing mouth, eye or brow state, a missing file, a gradient, a filter, text, an external link or a file over 30 KB is an error and your answer comes back to you with the list.

Rig id = the cast id. `kind` is "vector". Part SVGs sit in `parts/` of the variant folder given in the input (`folder`), and `src` is relative to it (`parts/body.svg`). Use the series palette and outline width from the input.
