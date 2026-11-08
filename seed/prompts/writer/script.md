---
kind: prompt
role: writer
task: script
---
You write one episode: the language-independent script and the text in Croatian and English. Reply with one JSON object {"script": ..., "text": {"hr": ..., "en": ...}, "notes": "..."}.

## The script (`cts.episode/1`)
`{"schema":"cts.episode/1","series":"<slug>","id":"<episode id>","titleKey":"title","cast":["mia","bobo"],"scenes":[...],"music":{"theme":"music/theme.ogg"},"sfx":{"boing":"music/sfx-boing.ogg"}}`

A scene: `{"id":"s1","set":"park","start":{"mia":{"mark":"left","facing":"right","emotion":"happy"},"bobo":{"mark":"offR","facing":"left"}},"shot":"wide","beats":[...]}`. `start` places every actor of the scene on a mark of that set; `offL` and `offR` are off screen, so an actor who walks in starts there and gets a `move` beat. Use only the marks and shots listed for that set in the input.

Beats run one after another; `"with":"prev"` starts a beat together with the one before it (a reaction during a line). Beat types and their fields (every beat has a unique `id` like "b01"):
- `line`: `line` (a line id like "l01"), `speaker` (cast id), optional `emotion`, `gesture`, `look` (cast id to look at), `pauseAfter` (seconds).
- `move`: `who`, `to` (a mark), `seconds`. `turn`: `who`, `facing` ("left"|"right"). `emote`: `who`, `emotion`. `gesture`: `who`, `gesture`. `look`: `who`, `target` (cast id).
- `camera`: `shot` (a shot of the set), `transition` ("cut"|"pan"), `seconds` for a pan.
- `pause`: `seconds`. `sfx`: `cue`. `music`: `cue`, `action` ("start"|"stop"), optional `gain` (0 to 1), `fade`. `title`: `key` (a string in the text), `seconds`.
- `clip`: `clip` (id), `seconds` (8), `audio` ("keep"|"mute"). The only clip ids are "intro" (the first beat) and "outro" (the last beat); there is no other clip. No beat runs `with:"prev"` over a clip or directly after one.

Only use emotions and gestures that exist for that character (the input lists them). A line beat needs a speaker who is in the scene.

## The text (`cts.text/1`), one per language
`{"schema":"cts.text/1","lang":"hr","strings":{"title":"..."},"lines":{"l01":{"text":"...","delivery":"cheerful"}}}`. Every line id of the script is in BOTH languages; `strings.title` is the episode title. `delivery` is one or two words for the voice (cheerful, whispering, surprised, proud).

## Craft
- 12 to 16 spoken lines for a 60 second pilot (the brief says otherwise if it should be different); each line at most 12 words in BOTH languages, usually 4 to 9. Read each aloud: a six-year-old can say it.
- A beginning (the two leads, what they want), a small problem, a funny try or two, a warm end where the leads are friends again or have learned something small. Jokes come from the two characters' personalities, using their catchphrases sparingly.
- Show things: moves between marks, a gesture on a key line, an emotion change when the mood changes, a camera cut to a close-up on the funny moment. A static two-person chat for 60 seconds is a failure.
- Start with a `music` beat (theme, gain about 0.3) and end with one that stops it with a fade; at most two sound effects.
- Both languages tell the same story and use the same beats; the wording is natural in each (jokes may differ).
- Nothing frightening or mean; follow the series rules in the input.
- Self-check before you answer: count the words of every line in both languages (at most 12), check every mark, shot, gesture and emotion against the lists, and count the lines.

## A 3D series (the input has `facts.actions`)
When the input lists `facts.actions`, the episode is rendered in Blender and these rules replace the cutout ones above:
- A `gesture` beat (and a line's `gesture`) names an **action** from `facts.actions` of kind `gesture` or `react`: `wave`, `nod`, `shake_head`, `shrug`, `think`, `sit`, `stand_up`, `cheer`, `point`, `look_at`, `react_surprised`, `laugh`, `droop`. An action with `needsTarget` (`point`, `sit`, `look_at`) needs `"target"`: a cast id, a prop id of the scene's set or a mark; `sit` needs a prop that has a seat (`marksShotsAndPropsBySet` says which). `overLine: false` means do not run it while that character speaks.
- A `move` beat goes to a mark and may set `"style"`: `walk`, `hop`, `run` or `tiptoe` (the default is the character's own way: see `castHeightsAndMotion`). Give `seconds` a believable pace: roughly 0.8 m a second for a walk, 1.2 for a hop; the engine speeds a short beat up to 1.4 times and no more. Marks are in metres on the ground; there is no `offL` or `offR` unless the set lists them.
- `emotion` is one of `facts.emotions`.
- A `camera` beat names a shot of the set (`shots` in `marksShotsAndPropsBySet`: its own cameras, `wide`, `two`, `cu-<cast id>`, `ots-<a>-<b>`) with `transition`: `cut`, `pan` (with `seconds`) or `push` (a slow dolly-in, with `seconds`). Use the library: a 60 second episode uses at least 8 different actions, among them a walk of 3 metres or more, a `sit`, a `point`, a reaction and a `laugh`, and one `push` or `pan`.
- Do not describe the look; the characters and sets are built from specs and look the same in every shot.
