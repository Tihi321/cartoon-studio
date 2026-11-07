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
  cast/<id>/            ref.png  parts/*.svg|*.png  rig.json  sheet.png   (variants/<a|b|c>/{parts/, rig.json, sheet.png})
  sets/<id>/            layers/*.png  set.json
  music/                <cue>.ogg
  clips/                <id>.mp4  clips.json
  episodes/<ep>/        budget.json  spend.json  pipeline.json  script.json  text/<lang>.json
                        clips/  reviews/  voice/<lang>/  lipsync/<lang>/  timeline.<lang>.json  render/  out/
```

## Series bible `bible.json`

The series: title and logline in both languages, audience, tone, style (palette, outline width, the reference prompt; `recraftStyleId` is
set once if the Recraft path is used), cast, sets, music, rules, episodes. `pitches` holds the showrunner's three premises; the pipeline
waits (state `waiting-on-user`) until `chosenPitch` is the id of one of them, set by the user (`cts_pitch_choose` or the studio). A cast
member's `voice` has one entry per language: `provider` (`auto` follows the allocation rule), a Gemini voice name, a VibeTTS voice, and for
the local OmniVoice engine `comfy`: `engine`, `instruct` (attribute tags such as "female, child, high pitch", not free style words),
an optional reference clip `ref` with its transcript `refText`, and a `seed`.

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
`face.parent` (the head): `eyes` (3 states), `brows` (4), `mouth` (8 shapes), each file placed at `at` in the head's coordinates.
`emotions` pick a brows state and an eyes state. A gesture rotates one part: `keys` are `[fraction of seconds from 0 to 1, degrees]`.
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
    "wave":  { "part": "arm_r", "seconds": 1.0, "keys": [[0, -10], [0.25, -150], [0.5, -120], [0.75, -150], [1, -10]] },
    "point": { "part": "arm_r", "seconds": 0.8, "keys": [[0, -10], [0.3, -85], [1, -85]] },
    "shrug": { "part": "arm_l", "seconds": 0.8, "keys": [[0, -10], [0.4, -40], [1, -10]] }
  },
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
| `move` | `who`, `to` (a mark; `offL`/`offR` for enter and exit), `seconds` |
| `turn` | `who`, `facing` |
| `emote` | `who`, `emotion` |
| `gesture` | `who`, `gesture` (one of the rig's gestures) |
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
`W_PLACEHOLDER`) or `failed`. `words` is `[{ "w": "...", "t0": 0.1, "t1": 0.4 }]` when a provider or whisper gives them (phase 2), else `null`.
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
`method: "words-hr"` or `"words-en"` with the same output.

```json
{ "schema": "cts.lipsync/1", "method": "amplitude", "fps": 12, "shapes": ["rest", "E", "A", "A", "E", "rest"] }
```

## Timeline `episodes/<ep>/timeline.<lang>.json`

Built by code, never hand-written. `scriptHash` is the sha1 of the bytes of `script.json` (`hashScript`, `SeriesStore.scriptHash`): a
different hash means the timeline is stale (`E_TIMELINE_STALE`). Paths are relative to the series folder (a voice line is
`episodes/<ep>/voice/<lang>/<line>.wav`; the example shortens it). `beats` lists the beats in the order they ran with their start and end;
the lint compares it between languages (`E_LANG_ORDER`).

Numeric tracks are `[t, value, ease?]` and are sampled by `sampleNumber` in `src/shared/sample.ts`: before the first key the first value
holds, after the last the last; between two keys the ease of the first decides: `step` holds until the next key's time and then jumps,
`linear` (default) interpolates, `inOut` is a smoothstep. Actors are sampled on the 12 fps grid (`gridFps`), the camera at 24 fps.
Discrete tracks (`facing`, `eyes`, `mouth`, `emotion`, `visible`) are `[t, value]` and hold until the next key (`sampleStep`). A camera key's
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

## Clips `clips/clips.json` (series) and `episodes/<ep>/clips/clips.json`

The Flow video clips (the series intro, an episode's hero moment). `file` is relative to the series folder (series clips) or to the episode
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
| `E_MARK_UNKNOWN` / `E_SHOT_UNKNOWN` | a mark or shot is not in the set |
| `E_GESTURE_UNKNOWN` | a gesture is not in the actor's rig |
| `E_LINE_NO_TEXT` | a line (or title string) has no text in a language |
| `E_LINE_NO_AUDIO` | a line has no audio in a language (checked when a voice manifest exists, or with `requireAudio`) |
| `E_RIG_PART` | a rig file is missing, breaks the part rules, or lacks a mouth, eye or brow state |
| `E_TIMELINE_STALE` | the timeline's `scriptHash` differs from `script.json` |
| `E_MOUTH_SILENT` | an actor's mouth is not `rest` outside its own line intervals |
| `E_LANG_ORDER` | the languages' timelines run different beat sequences |
| `E_CLIP_MISSING` | a `clip` beat's file is missing and the clip is not marked `fallback` |
| `W_LINE_LONG` | more than 12 words or more than 5 s |
| `W_OFF_FRAME` | a speaking actor's feet point is outside the camera rectangle |
| `W_LANG_DRIFT` | the languages' durations differ by more than 25 % |
| `W_PLACEHOLDER` | a voice line is a silent placeholder |

The result also carries `rigs` (one `cts_rig_check` result per cast member of the episode) and `stats.lines`: per line and language the
share of animation frames whose mouth is not `rest` (acceptance A9: at least 0.6).
