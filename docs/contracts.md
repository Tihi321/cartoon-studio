# Data contracts

The only definition of a series' files is `src/shared/contracts.ts` (zod). This page explains each file in prose and gives an example that
validates: `yarn docs:check` parses every `json` block below with the schema named in its `schema` field and fails on a mismatch.
Other code imports the schemas and types; it never redefines them.

## Conventions

- Every file carries `schema: "cts.<kind>/1"`. Objects are strict: an unknown key is an error (`E_SCHEMA` in `cts_lint`).
- Ids are `[a-z0-9-]+` (series slug, cast, set, episode, scene, beat, line, clip ids). Code words may also use letters in any case,
  digits, `_` and `-`: rig part ids (`arm_l`), marks (`offL`), shots (`cuLeft`), gestures, cues, emotions.
- Times are seconds (float). Coordinates are pixels, y down. Text is never stored outside `text/<lang>.json` or the bible's `{hr, en}` maps.
- Paths inside a file are relative to the folder the file is in: a rig's `src` to the rig's folder, a set layer to the set's folder, a
  voice manifest's `file` to the episode folder, a timeline's and a bible's paths to the series folder. Every path is resolved through
  `SeriesPaths.resolve`, which refuses an absolute path or a `..` that leaves `series/<slug>`.
- Files are written atomically (`SeriesStore.writeJson`), validated before they are written and after they are read.

## Layout of a series

```
series/<slug>/
  bible.json
  cast/<id>/            sketch.png (the app's rough sketch)  ref.png (master)  sheet/<pose>.png  sheet.png (character sheet)  parts/*.svg|*.png  rig.json  rig-sheet.png (rig pose sheet)   (variants/<a|c>/{parts/, rig.json, rig-sheet.png})
  sets/<id>/            layers/*.png  set.json
  (Blender series)      style3d.json  cast/<id>/character.json  sets/<id>/set3d.json  -- see "3D series"
  music/                theme.ogg  sfx-<cue>.ogg (ComfyUI)
  clips/                intro.mp4  outro.mp4  clips.json  keyframes/<id>.png
  episodes/<ep>/        budget.json  spend.json  pipeline.json  script.json  text/<lang>.json
                        clips/  reviews/  voice/<lang>/  lipsync/<lang>/  timeline.<lang>.json  render/<lang>/{levels.json,mix-check.json}  out/
```

## Series bible `bible.json`

The series: title and logline in both languages, audience, tone, style (palette, outline width, the reference prompt), cast, sets, music, rules, episodes. `pitches` holds the showrunner's three premises; the pipeline
waits (state `waiting-on-user`) until `chosenPitch` is the id of one of them, set by the user (`cts_pitch_choose` or the studio). A cast
member's `voice` has one entry per language: `provider` (`auto` follows the allocation rule), a Gemini voice name, a VibeTTS voice, and for
the local OmniVoice engine `comfy`: `engine`, `instruct` (attribute tags such as "female, child, high pitch", not free style words),
an optional reference clip `ref` with its transcript `refText`, and a `seed`. A cast member's optional `sheet` (CTS-12) is set by `cts_sheet_approve` when the user approved
the character sheet `cast/<id>/sheet.png`: `approvedAt` (local ISO time) and the `seed`, `denoise` and image `model` the master `cast/<id>/ref.png` was made with. It is absent until the approval
(and for characters made before the sheet step); the pipeline stops at the gate `sheet_review` until every cast member has one. For a 3D character the approval holds `approvedAt` and `specHash` (see below) instead.

`renderer` (HUB-30) is `canvas` (default: the frozen cutout player; a cast member has `rig`) or `blender` (3D: a cast member has `character`, the bible's optional `style3d` names the look file); see "3D series" below.

```json
{
  "schema": "cts.bible/1",
  "slug": "pilot",
  "title": { "hr": "Pilot", "en": "Pilot" },
  "audience": { "ageMin": 4, "ageMax": 8 },
  "logline": { "hr": "Mia i Bobo otkrivaju park.", "en": "Mia and Bobo discover a park." },
  "tone": ["gentle humour", "no peril beyond mild", "every episode ends warm"],
  "style": {
    "look": "flat paper cutout, solid colours, 6 px black outline",
    "palette": ["#f4d35e", "#ee964b", "#0d3b66", "#faf0ca", "#222222"],
    "outlinePx": 6,
    "refPrompt": "a child in a flat paper cutout style, arms held away from the body"
  },
  "languages": ["hr", "en"],
  "cast": [
    {
      "id": "mia", "name": { "hr": "Mia", "en": "Mia" }, "role": "lead",
      "personality": "curious, talks fast, a bit bossy",
      "catchphrases": { "hr": ["Hajde!"], "en": ["Come on!"] },
      "rig": "cast/mia/rig.json",
      "sheet": { "approvedAt": "2026-11-07T21:30:00+01:00", "seed": 412345, "denoise": 0.8, "model": "z-image-turbo" },
      "voice": {
        "hr": { "provider": "auto", "gemini": "Leda", "comfy": { "engine": "omnivoice", "instruct": "female, child, high pitch", "ref": null, "refText": null, "seed": 7 }, "vibetts": "supertonic:F3", "speed": 1.0 },
        "en": { "provider": "auto", "gemini": "Leda", "vibetts": "af_bella", "speed": 1.0, "style": "bright child-like" }
      }
    }
  ],
  "sets": [ { "id": "park", "name": { "hr": "Park", "en": "Park" }, "description": "a green park with a bench", "file": "sets/park/set.json" } ],
  "music": { "theme": "music/theme.ogg", "stings": ["music/sting-happy.ogg"] },
  "rules": ["lines of at most 12 words", "no name-calling"],
  "episodes": [ { "id": "ep00-pilot", "title": { "hr": "Pilot", "en": "Pilot" }, "status": "draft" } ],
  "pitches": [
    {
      "id": "p1", "title": { "hr": "Park", "en": "The Park" }, "logline": { "hr": "Dvoje prijatelja u parku.", "en": "Two friends in a park." },
      "leads": [ { "name": "Mia", "what": "curious and bossy" }, { "name": "Bobo", "what": "calm and kind" } ],
      "sets": ["park"], "why": "a small world a four-year-old knows"
    }
  ],
  "chosenPitch": "p1"
}
```

## Rig `cast/<id>/rig.json`

A puppet. Each part is its own file (SVG with a px `viewBox`, or PNG). `pivot` is in the part's own pixel coordinates; `at` is where that
pivot sits in the parent part's pixel coordinates; the root part (`parent: null`, exactly one) has `at: [0, 0]` and its pivot is the feet
point: the actor's stage position. `rot` is the rotation limit in degrees. `z` orders parts (higher is in front). The face is a plate on
`face.parent` (the head): `eyes` (3 states), `brows` (4), `mouth` (8 shapes), each file placed at `at` in the head's coordinates. A face state file may be an SVG or a PNG with alpha (at most 512 KB), drawn centred on `at`; several keys may name the same file (the raster rig points `U` at `O`, `FV` and `L` at `E`).
`emotions` pick a brows state and an eyes state. A gesture rotates one part: `keys` are `[fraction of seconds from 0 to 1, degrees]`.
Pose images (optional, CTS-14): `poses: { <name>: { src, pivot, face?: { at, scale } } }` holds full-body PNGs (with alpha) of the character at a gesture's peak, made from the rig by image-to-image (`cts_pose_make`, `cast/<id>/poses/<gesture>.png`); `pivot` is the feet point in the image's pixels, `face.at` is where the head part's image top-left sits in the pose image and `face.scale` the head's scale there (1 = the rig's). A gesture with `pose: "<name>"` shows that image instead of the parts for the middle 60 % of its `seconds` (the timeline's `pose` track); the face plates are drawn on it only when `face` is given, otherwise the painted face shows and the mouth does not move, so the timeline never puts such a pose over a line of that actor (the gesture stays a part rotation there). A rig without `poses` works as before.
`move.bobPx` is the bounce while walking. Facing the other way is a horizontal flip of the whole actor. `kind: "vector"` rigs have SVG parts.

Part rules (checked by `cts_rig_check`, code `E_RIG_PART`): SVG has a px `viewBox`, only flat fills and strokes (no gradients, no `<text>`, no
filters, no `<script>`, no external `href`; data-URI images only inside one `<pattern>`), at most 30 KB (200 KB with a pattern); PNG parts
have an alpha channel; all 8 mouth shapes, the 3 eye states and the 4 brow states exist; every file exists; parents, gesture parts and emotion
states refer to things that exist.

```json
{
  "schema": "cts.rig/1", "id": "mia", "kind": "vector", "drawnFacing": "right", "height": 600,
  "parts": [
    { "id": "body",  "src": "parts/body.svg",  "parent": null,   "pivot": [150, 420], "at": [0, 0],     "z": 10 },
    { "id": "feet",  "src": "parts/feet.svg",  "parent": "body", "pivot": [90, 10],   "at": [150, 400], "z": 8 },
    { "id": "head",  "src": "parts/head.svg",  "parent": "body", "pivot": [160, 300], "at": [150, 60],  "z": 20, "rot": [-12, 12] },
    { "id": "arm_l", "src": "parts/arm_l.svg", "parent": "body", "pivot": [20, 15],   "at": [45, 130],  "z": 5,  "rot": [-160, 40] },
    { "id": "arm_r", "src": "parts/arm_r.svg", "parent": "body", "pivot": [20, 15],   "at": [255, 130], "z": 25, "rot": [-160, 40] }
  ],
  "face": {
    "parent": "head",
    "eyes":  { "at": [160, 170], "z": 30, "states": { "open": "parts/eyes_open.svg", "half": "parts/eyes_half.svg", "closed": "parts/eyes_closed.svg" } },
    "brows": { "at": [160, 120], "z": 31, "states": { "neutral": "parts/brows_neutral.svg", "happy": "parts/brows_happy.svg", "sad": "parts/brows_sad.svg", "surprised": "parts/brows_surprised.svg" } },
    "mouth": { "at": [160, 245], "z": 32, "shapes": { "rest": "parts/mouth_rest.svg", "A": "parts/mouth_A.svg", "E": "parts/mouth_E.svg", "O": "parts/mouth_O.svg", "U": "parts/mouth_U.svg", "MBP": "parts/mouth_MBP.svg", "FV": "parts/mouth_FV.svg", "L": "parts/mouth_L.svg" } }
  },
  "emotions": {
    "neutral": { "brows": "neutral", "eyes": "open" }, "happy": { "brows": "happy", "eyes": "open" },
    "sad": { "brows": "sad", "eyes": "half" }, "surprised": { "brows": "surprised", "eyes": "open" }
  },
  "gestures": {
    "wave":  { "part": "arm_r", "seconds": 1.0, "keys": [[0, -10], [0.25, -150], [0.5, -120], [0.75, -150], [1, -10]], "pose": "wave" },
    "point": { "part": "arm_r", "seconds": 0.8, "keys": [[0, -10], [0.3, -85], [1, -85]] },
    "shrug": { "part": "arm_l", "seconds": 0.8, "keys": [[0, -10], [0.4, -40], [1, -10]] }
  },
  "poses": { "wave": { "src": "poses/wave.png", "pivot": [412, 1186], "face": { "at": [236, 8], "scale": 1 } } },
  "move": { "bobPx": 8, "stepSeconds": 0.33 }
}
```

## Set `sets/<id>/set.json`

A background with marks (where actors stand) and shots (camera framings). `layers` are drawn in `z` order; `parallax` scales how far a
layer moves with the camera; `at` and `anchor` (`topleft` | `center` | `bottom`) place a prop. `zoom` is relative to fitting the set's
height into the frame (1 = the whole height). Backgrounds are made at 1920x1080 and upscaled 1.5x so a 1.5 close-up stays sharp.

```json
{
  "schema": "cts.set/1", "id": "park", "size": [2880, 1620], "groundY": 1380, "actorScale": 1.0,
  "layers": [
    { "id": "bg", "src": "layers/bg.png", "z": 0, "parallax": 1.0 },
    { "id": "bench", "src": "layers/bench.png", "z": 100, "at": [2200, 1420], "anchor": "bottom", "parallax": 1.1 }
  ],
  "marks": { "offL": [-300, 1380], "left": [1000, 1380], "center": [1440, 1380], "right": [1880, 1380], "offR": [3180, 1380] },
  "shots": {
    "wide": { "center": [1440, 810], "zoom": 1.0 }, "two": { "center": [1440, 900], "zoom": 1.25 },
    "cuLeft": { "center": [1000, 760], "zoom": 1.5 }, "cuRight": { "center": [1880, 760], "zoom": 1.5 }
  }
}
```

## Episode script `episodes/<ep>/script.json` and text catalog

The script is language-independent: scenes of beats with line ids; the words live in `text/<lang>.json`. Beats run one after another;
`"with": "prev"` starts a beat together with the previous one. A `line` beat lasts its audio length plus `pauseAfter` (default 0.25).
`scene.start` places each actor on a mark; `scene.shot` is the opening camera.

| Beat | Fields |
|---|---|
| `line` | `line` (id in the text catalog), `speaker`, `emotion?`, `gesture?`, `look?` (cast id), `pauseAfter?` |
| `move` | `who`, `to` (a mark; `offL`/`offR` for enter and exit), `seconds`, `style?` (Blender series: `walk`, `hop`, `run` or `tiptoe`; default from the character's motion profile) |
| `turn` | `who`, `facing` |
| `emote` | `who`, `emotion` |
| `gesture` | `who`, `gesture` (one of the rig's gestures; in a Blender series an action of the acting library), `target?` (Blender series: a cast id, a prop id of the set or a mark: point at, sit on, look at) |
| `look` | `who`, `target` |
| `camera` | `shot` (a set shot), `transition` (`cut` or `pan`), `seconds?` (pan) |
| `pause` | `seconds` |
| `sfx` | `cue` (a key of `sfx`) |
| `music` | `cue`, `action` (`start` or `stop`), `gain?`, `fade?` |
| `title` | `key` (a string in the catalog), `seconds` (a static card) |
| `clip` | `clip` (id), `seconds`, `audio` (`keep` mixes the clip's sound at 0.3, `mute` drops it). Looked up in the episode's `clips/` first, then the series' `clips/`. No beat runs `with: "prev"` over a clip. |

```json
{
  "schema": "cts.episode/1", "series": "pilot", "id": "ep00-pilot", "titleKey": "title",
  "cast": ["mia", "bobo"],
  "scenes": [
    {
      "id": "s1", "set": "park",
      "start": { "mia": { "mark": "left", "facing": "right", "emotion": "happy" }, "bobo": { "mark": "offR", "facing": "left" } },
      "shot": "wide",
      "beats": [
        { "id": "b00", "type": "clip", "clip": "intro", "seconds": 8, "audio": "keep" },
        { "id": "b01", "type": "music", "cue": "theme", "action": "start", "gain": 0.35 },
        { "id": "b02", "type": "move", "who": "bobo", "to": "right", "seconds": 2.0 },
        { "id": "b03", "type": "line", "line": "l01", "speaker": "mia", "emotion": "happy", "gesture": "wave", "look": "bobo", "pauseAfter": 0.3 },
        { "id": "b04", "type": "camera", "shot": "cuLeft", "transition": "cut" },
        { "id": "b05", "type": "line", "line": "l02", "speaker": "bobo", "emotion": "surprised", "with": "prev" },
        { "id": "b06", "type": "emote", "who": "mia", "emotion": "sad" },
        { "id": "b07", "type": "gesture", "who": "bobo", "gesture": "shrug" },
        { "id": "b08", "type": "camera", "shot": "two", "transition": "pan", "seconds": 1.5 },
        { "id": "b09", "type": "turn", "who": "mia", "facing": "left" },
        { "id": "b10", "type": "sfx", "cue": "boing" },
        { "id": "b11", "type": "pause", "seconds": 0.8 },
        { "id": "b12", "type": "title", "key": "title", "seconds": 2 },
        { "id": "b13", "type": "music", "cue": "theme", "action": "stop", "fade": 1.5 }
      ]
    }
  ],
  "music": { "theme": "music/theme.ogg" },
  "sfx": { "boing": "music/sfx-boing.ogg" }
}
```

`text/<lang>.json`: every `line` id of the script must exist in every language of the bible, and every `titleKey` / `title` key in `strings`.

```json
{
  "schema": "cts.text/1", "lang": "hr",
  "strings": { "title": "Pilot" },
  "lines": { "l01": { "text": "Bok! Ja sam Mia.", "delivery": "cheerful" }, "l02": { "text": "Vau, kakav park!" } }
}
```

## Voice manifest `episodes/<ep>/voice/<lang>/manifest.json`

One entry per line. `status`: `ok`, `placeholder` (silence of the estimated length, 2.5 words/s, so timing still builds; lint warns
`W_PLACEHOLDER`) or `failed`. `words` is `[{ "w": "...", "t0": 0.1, "t1": 0.4 }]` when a provider or whisper gives them, else `null`. A Blender series fills it after voicing from `flow_transcribe` (whisper.cpp, language always passed): the script words that whisper heard, in the script's spelling with whisper's times, and `wordsCoverage` (0..1, aligned words / script words; under 0.7 the lip-sync uses the text method).
`file` is relative to the episode folder. A clip is re-made only when its `hash` changes.

```json
{
  "schema": "cts.voice/1", "episode": "ep00-pilot", "lang": "hr",
  "allocation": { "provider": "comfy", "reason": "14 clips > 10 left of the Gemini quota (Croatian first)" },
  "lines": {
    "l01": { "file": "voice/hr/l01.wav", "seconds": 2.31, "provider": "comfy", "engine": "omnivoice", "voice": "female, child, high pitch", "speed": 1.0,
             "hash": "3f2a9c", "words": null, "status": "ok" }
  },
  "costUsd": 0
}
```

## Lip-sync track `episodes/<ep>/lipsync/<lang>/<lineId>.json`

One mouth shape per animation frame from the clip start. Phase 1 uses `rest`, `E` (half open) and `A` (open) from the amplitude; phase 2 adds
`method: "words-hr"` or `"words-en"` with the same output. A Blender series uses the six visemes `rest A E O U MBP` at 24 fps with
`method` `words-<lang>` (whisper word times) or `text-<lang>` (text and voiced segments).

```json
{ "schema": "cts.lipsync/1", "method": "amplitude", "fps": 12, "shapes": ["rest", "E", "A", "A", "E", "rest"] }
```

## Timeline `episodes/<ep>/timeline.<lang>.json`

Built by code, never hand-written. `scriptHash` is the sha1 of the bytes of `script.json` (`hashScript`, `SeriesStore.scriptHash`): a
different hash means the timeline is stale (`E_TIMELINE_STALE`). Paths are relative to the series folder (a voice line is
`episodes/<ep>/voice/<lang>/<line>.wav`; the example shortens it). `beats` lists the beats in the order they ran with their start and end;
the lint compares it between languages (`E_LANG_ORDER`). `titles` (optional) lists the `title` beats as `{ id, text, t0, t1 }` with the text already in the timeline's language: a static card
the player draws from t0 to t1.

Numeric tracks are `[t, value, ease?]` and are sampled by `sampleNumber` in `src/shared/sample.ts`: before the first key the first value
holds, after the last the last; between two keys the ease of the first decides: `step` holds until the next key's time and then jumps,
`linear` (default) interpolates, `inOut` is a smoothstep. Actors are sampled on the 12 fps grid (`gridFps`), the camera at 24 fps.
Discrete tracks (`facing`, `eyes`, `mouth`, `emotion`, `visible`, and the optional `pose`: a pose image name, or `null` for the parts) are `[t, value]` and hold until the next key (`sampleStep`). A camera key's
`ease` is how the camera leaves that key: `cut` holds and then jumps, `linear`, `inOut`. A pan from A to B is a key at A with `inOut` and a
key at B. `clips` are the `clip` beats: the cutout segments between them are rendered separately and the clip file is spliced in; with
`fallback: true` the title card and a bounce of the leads are rendered there instead.

```json
{
  "schema": "cts.timeline/1", "series": "pilot", "episode": "ep00-pilot", "lang": "hr", "scriptHash": "9a1c0e5d2b7f4a3c8e6d1f0b2a4c6e8d0f1a2b3c",
  "size": [1920, 1080], "fps": { "anim": 12, "out": 24 }, "duration": 61.4, "seed": 29,
  "scenes": [ { "id": "s1", "set": "park", "t0": 0, "t1": 61.4 } ],
  "camera": [ { "t": 0, "center": [1440, 810], "zoom": 1.0, "ease": "cut" }, { "t": 20.5, "center": [1440, 900], "zoom": 1.25, "ease": "inOut" } ],
  "actors": {
    "mia": {
      "x": [[0, 1000, "step"]], "y": [[0, 1380, "step"]], "facing": [[0, "right"]], "visible": [[0, true]],
      "emotion": [[0, "happy"]], "eyes": [[0, "open"], [2.9, "closed"], [3.05, "open"]],
      "mouth": [[1.2, "E"], [1.283, "A"], [3.5, "rest"]],
      "rot": { "head": [[0, 0, "step"]], "arm_r": [[1.2, -10, "inOut"], [1.45, -150, "inOut"]] },
      "bob": [[0, 0]]
    }
  },
  "audio": [
    { "kind": "voice", "line": "l01", "file": "voice/hr/l01.wav", "t": 1.2, "gain": 1.0 },
    { "kind": "music", "file": "music/theme.ogg", "t": 0, "until": 61.4, "gain": 0.35, "duckTo": 0.12, "fadeOut": 1.5 },
    { "kind": "sfx", "file": "music/sfx-boing.ogg", "t": 40.2, "gain": 0.8 }
  ],
  "lines": [ { "id": "l01", "speaker": "mia", "t0": 1.2, "t1": 3.5 } ],
  "clips": [ { "id": "intro", "file": "clips/intro.mp4", "t0": 0, "t1": 8, "audio": "keep", "fallback": false } ],
  "beats": [ { "id": "b00", "t0": 0, "t1": 8 }, { "id": "b03", "t0": 8, "t1": 10.5 } ]
}
```

The mix is not in the timeline: `music` `gain` is only a trim (at most 0 dB, never a boost) and `duckTo` is kept for the schema. The levels come from `config/render.md` `mix` (voices to `voiceLufs` -20 LUFS, music `musicUnderVoiceDb` 18 dB under the voice while someone speaks and `musicGapUnderVoiceDb` 8 dB under in the gaps, sfx and clip audio at their own offsets, then `loudness` -16 LUFS on the sum). A final render measures each input once (`render/<lang>/levels.json`, cached by file hash) and writes `render/<lang>/mix-check.json` `{ lines: [{ id, voice, music, underDb }], minUnderDb, medianUnderDb, gapMusicUnderVoiceDb }`; lint gives `W_MIX_MUSIC_LOUD` when `minUnderDb` is below `mix.minUnderVoiceDb` (15).

## 3D series (`renderer: "blender"`)

A series whose bible says `"renderer": "blender"` (default `canvas`, so older series parse and render as before) is drawn in Blender: characters and sets are data built by code, there is no AI image in them. The script and the text catalog are shared with canvas series (with the optional fields in the beat table above). Units are metres, z is up, rotations are degrees. The bible's `style3d` names the look file (default `style3d.json`); a cast member has `character` (default `cast/<id>/character.json`) instead of `rig`; a set file is `sets/<id>/set3d.json`.

```
series/<slug>/
  style3d.json                       cts.style3d/1
  cast/<id>/character.json           cts.character3d/1 (the spec)    character.blend  sheet.png  build.json (built)
  sets/<id>/set3d.json               cts.set3d/1                     set.blend  sheet.png (built)
  episodes/<ep>/timeline.<lang>.json cts.timeline3d/1                lipsync/<lang>/<line>.json  render/<lang>/  out/
```

A cast member's `sheet` (the approval of the 3D sheet) holds `approvedAt` and `specHash`, the sha1 of `character.json` when the user approved it; a changed spec is then no longer approved.

### Character `cast/<id>/character.json`

A character is parts (primitives) hung on **controls**, named empties. Standard controls: `root`, `squash`, `body`, `head`, `arm_L`, `arm_R`, `lid_L`, `lid_R`, `pupil_L`, `pupil_R` and `mouth` are required; `hand_L/R`, `leg_L/R` (a character without legs hops or slides), `brow_L/R`, `ear_L1..`, `ear_R1..`, `tail1..` and `acc_<name>1..` (chains such as a scarf) are optional. `root` has no parent; every other control names one. Every part names a control and a palette colour. `motion` is the profile the acting library scales with (`tempo` is the gesture speed factor, `energy` the amplitude, `bounce` the hop and idle bob, `walk.style` is `walk`, `hop` or `waddle`). `springs` sets the damped spring of a secondary chain. `face` puts eyes, lids, optional brows and the mouth (six slots `rest A E O U MBP`) on the head; the builder refuses a face that is buried in the head (`E_FACE_HIDDEN`).

```json
{
  "schema": "cts.character3d/1",
  "id": "tilly",
  "units": "m",
  "height": 0.55,
  "palette": { "fur": "#f6e7cf", "ear": "#e8a0a0", "dark": "#2b2118" },
  "motion": { "tempo": 1.4, "energy": 1, "bounce": 0.5, "walk": { "style": "walk", "stride": 0.22, "cadence": 2.2 } },
  "controls": {
    "root": { "parent": null, "at": [0, 0, 0] },
    "squash": { "parent": "root", "at": [0, 0, 0] },
    "body": { "parent": "squash", "at": [0, 0, 0.14] },
    "head": { "parent": "body", "at": [0, 0, 0.16] },
    "arm_L": { "parent": "body", "at": [-0.09, 0, 0.1] },
    "arm_R": { "parent": "body", "at": [0.09, 0, 0.1] },
    "leg_L": { "parent": "squash", "at": [-0.05, 0, 0.12] },
    "leg_R": { "parent": "squash", "at": [0.05, 0, 0.12] },
    "ear_L1": { "parent": "head", "at": [-0.05, 0, 0.12] },
    "ear_R1": { "parent": "head", "at": [0.05, 0, 0.12] },
    "lid_L": { "parent": "head", "at": [-0.04, -0.085, 0.03] },
    "lid_R": { "parent": "head", "at": [0.04, -0.085, 0.03] },
    "pupil_L": { "parent": "head", "at": [-0.04, -0.09, 0.03] },
    "pupil_R": { "parent": "head", "at": [0.04, -0.09, 0.03] },
    "mouth": { "parent": "head", "at": [0, -0.095, -0.03] }
  },
  "springs": { "ear_L": { "stiffness": 60, "damping": 6 }, "ear_R": { "stiffness": 60, "damping": 6 } },
  "parts": [
    { "id": "body", "shape": "ellipsoid", "size": [0.11, 0.09, 0.14], "at": [0, 0, 0], "colour": "fur", "control": "body", "outline": 0.006 },
    { "id": "head", "shape": "ellipsoid", "size": [0.1, 0.09, 0.09], "at": [0, 0, 0.02], "colour": "fur", "control": "head", "outline": 0.006 },
    { "id": "arm_L", "shape": "capsule", "size": [0.025, 0.08], "at": [0, 0, -0.04], "colour": "fur", "control": "arm_L" },
    { "id": "arm_R", "shape": "capsule", "size": [0.025, 0.08], "at": [0, 0, -0.04], "colour": "fur", "control": "arm_R" },
    { "id": "leg_L", "shape": "capsule", "size": [0.03, 0.1], "at": [0, 0, -0.05], "colour": "fur", "control": "leg_L" },
    { "id": "leg_R", "shape": "capsule", "size": [0.03, 0.1], "at": [0, 0, -0.05], "colour": "fur", "control": "leg_R" },
    { "id": "ear_L1", "shape": "cone", "size": [0.03, 0.14], "at": [0, 0, 0.07], "colour": "ear", "control": "ear_L1" },
    { "id": "ear_R1", "shape": "cone", "size": [0.03, 0.14], "at": [0, 0, 0.07], "colour": "ear", "control": "ear_R1" }
  ],
  "face": {
    "control": "head",
    "eyes": { "x": 0.04, "z": 0.03, "r": 0.022, "faceY": -0.085, "pupil": { "size": 0.012, "lead": 0.003 } },
    "lids": { "colour": "fur" },
    "mouth": { "at": [0, -0.095, -0.03], "scale": 0.03, "inner": "#7a2e2e" }
  }
}
```

A part's `shape` is `ellipsoid`, `cone`, `box`, `capsule`, `torus`, `arc` or `spines` (a part with a `spines` block: `count`, `length`, `radius`, `keep` `back|top|all`, `lean`). `accessories` (optional) is a list of parts with the same shape.

### Set `sets/<id>/set3d.json`

Ground, sky, props from the kit (`tree_round`, `tree_cone`, `bush`, `bench`, `rock`, `flowers`, `fence`, `house`, `cloud`), **marks** (ground points `[x, y]` that actors start on and walk to) and named **cameras** (`loc`, `target`, `lens`). A prop that can be sat on has a `seat`. Besides the set's cameras a script may use the computed shots `wide`, `two`, `cu-<cast id>` and `ots-<a>-<b>`.

```json
{
  "schema": "cts.set3d/1",
  "id": "park",
  "ground": { "size": [20, 14], "colour": "#7cc576", "patches": [{ "shape": "rect", "at": [0, 1], "size": [10, 1.6], "colour": "#e6d3a3" }] },
  "sky": { "top": "#86cdf0", "horizon": "#e4f6fb" },
  "props": [
    { "id": "oak", "kind": "tree_round", "at": [-4, 3], "scale": 1.4 },
    { "id": "bench", "kind": "bench", "at": [3, 2.2], "rot": 180, "seat": { "height": 0.45, "at": [0, 0] } }
  ],
  "marks": { "left": [-2.5, 0], "center": [0, 0], "right": [2.5, 0], "bench": [3, 1.4] },
  "cameras": { "bench": { "loc": [3, -2.5, 1.1], "target": [3, 2, 0.5], "lens": 40 } }
}
```

### Look `style3d.json`

The look of a series. Every field has a default (the clean toon look: a two-tone ramp at `shade` 0.74 and `threshold` 0.36, dark inverted-hull outlines, a sun without shadows, EEVEE with 16 final and 4 preview samples), so `{ "schema": "cts.style3d/1" }` is a complete file. `post` is `none`, `paper` or `posterize`; `stepped: true` holds poses on twos.

```json
{
  "schema": "cts.style3d/1",
  "toon": { "shade": 0.74, "threshold": 0.36 },
  "outline": { "colour": "#2b2118", "scale": 1 },
  "world": { "sky": { "top": "#86cdf0", "horizon": "#e4f6fb" } },
  "sun": { "angle": [50, -10, -35], "energy": 3.2 },
  "samples": { "final": 16, "preview": 4 },
  "post": "none",
  "stepped": false
}
```

### Timeline `episodes/<ep>/timeline.<lang>.json` (3D)

Built by code. Node owns the timing (from each language's audio lengths); the Python assembler turns it into a Blender scene. It holds the beats as semantic actions with times, so the two languages have the same actions in the same order, stretched to their own line lengths. `audio`, `lines`, `clips`, `titles` and `beats` have exactly the shapes of the canvas timeline, so the mix, the clip splice and `E_LANG_ORDER` are shared. Per actor: `start` (mark and facing, `left`, `right` or a yaw in degrees), `actions` (`action` is a name of the acting library, `params` its options), `look` (`[t, target]`, null looks ahead), `emotion`, `mouth` (`[t, viseme]`, the six visemes `rest A E O U MBP` at 24 fps), `blinks`, `speaking` (the intervals of the actor's own lines) and `accents` (word onsets: small head and hand beats). `shots` are the camera cuts and moves (`transition` is `cut`, `pan` or `push`).

```json
{
  "schema": "cts.timeline3d/1",
  "series": "mini3d",
  "episode": "ep00-mini3d",
  "lang": "en",
  "scriptHash": "0000000000000000000000000000000000000000",
  "fps": 24,
  "size": [1920, 1080],
  "duration": 2.5,
  "seed": 7,
  "scenes": [{ "id": "s1", "set": "park", "t0": 0, "t1": 2.5 }],
  "actors": {
    "tilly": {
      "start": { "mark": "left", "facing": "right" },
      "actions": [
        { "beat": "b01", "action": "wave", "t0": 0, "t1": 1.2, "params": { "arm": "R" } },
        { "beat": "b03", "action": "point", "t0": 1.3, "t1": 2.5, "params": {} }
      ],
      "look": [[0, "blobby"], [1.3, "oak"]],
      "emotion": [[0, "happy"]],
      "mouth": [[0, "rest"], [0.1, "A"], [0.3, "E"], [0.5, "MBP"], [0.7, "rest"]],
      "blinks": [2.1],
      "speaking": [[0, 1]],
      "accents": [0.1, 0.5]
    },
    "blobby": {
      "start": { "mark": "right", "facing": "left" },
      "actions": [],
      "look": [[0, "tilly"]],
      "emotion": [],
      "mouth": [],
      "blinks": [],
      "speaking": [[1.3, 2.1]],
      "accents": []
    }
  },
  "shots": [{ "t": 0, "shot": "wide", "transition": "cut" }, { "t": 1.3, "shot": "cu-blobby", "transition": "pan", "seconds": 0.8 }],
  "audio": [{ "kind": "voice", "line": "l01", "file": "episodes/ep00-mini3d/voice/en/l01.wav", "t": 0, "gain": 1 }],
  "lines": [{ "id": "l01", "speaker": "tilly", "t0": 0, "t1": 1 }, { "id": "l02", "speaker": "blobby", "t0": 1.3, "t1": 2.1 }],
  "clips": [],
  "beats": [{ "id": "b01", "t0": 0, "t1": 1.3 }, { "id": "b02", "t0": 1.3, "t1": 2.5 }, { "id": "b03", "t0": 1.3, "t1": 2.5 }]
}
```

### Acting library `blender/cts_blender/acting/library.json`

Not a series file: the single source for the action names (`src/engine/blender/library.ts` reads it; the Python registry must list the same names). Per action: `name`, `kind` (`gesture`, `locomotion`, `react`, `camera`), `parts` (the controls it moves), `seconds` (`min`, `default`, `max`: the timeline never stretches a gesture past `max`), `overLine` (may run while the actor speaks; `W_GESTURE_OVER_LINE` when not), `needsTarget`, `params`, and `auto: true` for what the assembler makes by itself (`idle`, `blink`). A `gesture` beat or a line's `gesture` must name a non-automatic gesture or reaction.

```text
{ "name": "point", "kind": "gesture", "parts": ["arm_R", "hand_R", "body", "head"],
  "seconds": { "min": 0.8, "default": 1.4, "max": 3 }, "overLine": true, "needsTarget": true, "params": { "arm": "L|R" } }
```

## Clips `clips/clips.json` (series) and `episodes/<ep>/clips/clips.json`

The Flow video clips: the series `intro` and `outro` (series level, `clips/<id>.mp4`; no other id can be made). An older series may still hold an
episode-level `hero` entry; it keeps resolving. `file` is relative to the series folder (series clips) or to the episode
folder (episode clips). `credits` is what the clip cost; `review` is the frame
critic's verdict; `fallback: true` drops the clip (the beat renders the cutout fallback). A missing `.mp4` for a `clip` beat is
`E_CLIP_MISSING` unless the clip is marked `fallback`.

```json
{
  "schema": "cts.clips/1",
  "clips": [ { "id": "intro", "file": "clips/intro.mp4", "seconds": 8, "credits": 12, "flowMediaId": "abc123", "prompt": "flat 2D cutout motion, no 3D, no shading, no speech", "review": "pass" } ]
}
```

## Budget and spend `episodes/<ep>/budget.json`, `spend.json`

No `budget.json` means both caps are 0, so nothing paid runs. `capUsd` caps money, `flowCreditsCap` caps Flow credits. `spend.json` is
the ledger, one entry per paid call, appended after it (`currency` `usd` or `credits`).

```json
{ "schema": "cts.budget/1", "capUsd": 0, "flowCreditsCap": 50, "approvedBy": "user", "approvedAt": "2026-11-07T10:00:00Z", "note": "pilot: no paid images, 50 Flow credits" }
```

```json
{
  "schema": "cts.spend/1",
  "entries": [ { "t": "2026-11-07T11:30:00Z", "provider": "flow", "model": "veo-3-fast", "what": "intro clip", "currency": "credits", "amount": 12 } ]
}
```

## Review `episodes/<ep>/reviews/*.json`

Edu's review shape: `verdict` is `pass` or `revise`, `scores` are named numbers, `problems` say where, what and the fix.

```json
{
  "schema": "cts.review/1", "verdict": "revise", "scores": { "safety": 9, "tone": 8 }, "notes": "One line is a little scary.",
  "problems": [ { "where": "l07", "what": "mentions being lost in the dark", "fix": "make it a sunny hide-and-seek" } ]
}
```

## Pipeline state `episodes/<ep>/pipeline.json`

The resumable pipeline. `state` is `idle`, `running`, `waiting-on-user` (the pitch pick), `waiting-on-client` (a model call is parked for
Claude), `failed` or `done`; `steps` maps a step name to its state.

```json
{
  "schema": "cts.pipeline/1", "series": "pilot", "episode": "ep00-pilot", "state": "waiting-on-user",
  "steps": { "pitch": { "state": "done", "startedAt": "2026-11-07T10:00:00Z", "endedAt": "2026-11-07T10:03:00Z" }, "bible": { "state": "pending" } },
  "updatedAt": "2026-11-07T10:03:00Z"
}
```

## Lint codes (`cts_lint`)

Errors fail a step; warnings are listed. Every issue has `code`, `message`, `file`, `where` and `lang`.

| Code | Meaning |
|---|---|
| `E_SCHEMA` | a file is missing, not JSON, or fails its schema |
| `E_CAST_UNKNOWN` | a cast id in the script is not in the bible or the episode's cast |
| `E_SET_UNKNOWN` | a scene's set is not in the bible, or a set file or layer is missing |
| `E_MARK_UNKNOWN` / `E_SHOT_UNKNOWN` | a mark or shot is not in the set (Blender series: a shot is a camera of the set or a computed shot; a gesture `target` is a cast id, a prop or a mark, and `sit` needs a prop with a `seat`) |
| `E_GESTURE_UNKNOWN` | a gesture is not in the actor's rig (canvas series) |
| `E_ACTION_UNKNOWN` | a gesture is not an action of the acting library (Blender series) |
| `E_LINE_NO_TEXT` | a line (or title string) has no text in a language |
| `E_LINE_NO_AUDIO` | a line has no audio in a language (checked when a voice manifest exists, or with `requireAudio`) |
| `E_RIG_PART` | a rig file is missing, breaks the part rules, or lacks a mouth, eye or brow state |
| `E_TIMELINE_STALE` | the timeline's `scriptHash` differs from `script.json` |
| `E_MOUTH_SILENT` | canvas: an actor's mouth is not `rest` outside its own line intervals. Blender series: a spoken line has no six-viseme lip-sync file (or only `rest`, or no `MBP` where the text has a labial) |
| `E_LANG_ORDER` | the languages' timelines run different beat sequences |
| `E_CLIP_MISSING` | a `clip` beat's file is missing and the clip is not marked `fallback` |
| `W_LINE_LONG` | more than 12 words or more than 5 s |
| `W_GESTURE_OVER_LINE` | a gesture the acting library says may not overlap a line runs while that actor speaks |
| `W_VISEME_FLAT` | a Blender series' lip-sync has fewer than 60 % non-`rest` frames or fewer than 3 distinct visemes |
| `W_OFF_FRAME` | a speaking actor's feet point is outside the camera rectangle |
| `W_LANG_DRIFT` | the languages' durations differ by more than 25 % |
| `W_PLACEHOLDER` | a voice line is a silent placeholder |

The result also carries `rigs` (one `cts_rig_check` result per cast member of the episode) and `stats.lines`: per line and language the
share of animation frames whose mouth is not `rest` (acceptance A9: at least 0.6).
