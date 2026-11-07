# The pipeline (CTS-07)

`cts_run_pipeline { series, episode, brief?, options?, retry?, from? }` makes one episode of a series from an idea: pitches, a premise the user chooses, art, script, voices, music, video clips, renders. Re-call it with the same ids to resume (the Edu `edu_run_pipeline` pattern): the state is read from `series/<slug>/episodes/<ep>/pipeline.json` and the job store, never from memory, so it survives a restart.

Code: `src/engine/pipeline/` -- `steps.ts` (the step list), `run.ts` (the state machine: `Pipeline.run / advance / choosePitch`), `handlers.ts` and `media.ts` (the job handlers), `tasks.ts` (the role task contract), `rig.ts` (rig building), `clips.ts` (Flow clips), `tools.ts` (the MCP tools). Images: `src/engine/images/{reference,background}.ts`. Prompts: `seed/prompts/<role>/<kind>.md`, the drawing guide `seed/style/cutout-kids.md`.

## State

`pipeline.json` (`cts.pipeline/1`):

- `state`: `idle`, `running`, `waiting-on-user`, `waiting-on-client` (a model call waits for `cts_get_task`), `failed`, `done`.
- `steps.<id>`: `state` (`pending`, `running`, `done`, `failed`), `job` (the job id), `detail` (how it ended; `redo` and `revise N: ...` mark a step to be made again), `error`, `attempts`, times.
- `brief`: what the run was asked, and under `brief.options` the run's choices. `run`: counter. `waitingOn`: why it waits. `summary`: written by the last step.

`advance` looks at the first step that is not done: a gate that is not open stops the run (`waiting-on-user`); a pending step becomes a job `<series>--<task>--<episode>--r<n>` of the step's role; a running step whose job is queued/running keeps the state `running` (or `waiting-on-client` while the job's model call sits in the client queue); a failed job fails the step. A handler marks its step done and calls `advance`, which enqueues the next step's job. `cts_wait {series}` therefore follows the whole run: it returns when a model call waits for you (`clientTasks`) or nothing is left. `cts_status {series}` lists the pipelines (state, step, hint).

`retry: true` puts failed steps back to pending. `from: "<step>"` puts that step and every later step back (marked `redo`: their handlers make the files again instead of keeping them). `options` are merged into the stored ones.

## The mandatory pause

Step 1 (`pitch`) writes three pitches into `bible.json` (`pitches`, `chosenPitch: null`). The next step, `pitch_choice`, is a **gate**: it is done only when `bible.chosenPitch` names one of `bible.pitches`, and only `cts_pitch_choose { series, pitch }` (or the studio's Series view, which calls it) writes that, together with the time (`bible.chosenAt`). Until then the run is `waiting-on-user` and **nothing visual is made**: re-calling `cts_run_pipeline`, `retry` and `from: "<later step>"` all stop at the gate again, `Pipeline.enqueue` refuses a later step if no premise is chosen, every visual handler checks it first, and `cts_series_update` cannot set the pitch fields. `from: "pitch"` makes new pitches and clears the choice. Show the user the pitches (title, logline, two leads, sets, why; `cts_series_get` or the `pitches` of the run report) and wait for their answer.

## Steps

| # | id | role | what it does | writes |
|---|---|---|---|---|
| 1 | `pitch` | showrunner | 3 premises (hr + en title and logline, two leads, 1-2 sets, why) | `bible.json` `pitches`, `tasks/pitches.json` |
| 1 | `pitch_choice` | (gate) | waits for the user | `bible.chosenPitch`, `chosenAt` |
| 1b | `bible` | showrunner | cast (with a `look` each), sets, tone, rules, style from the chosen pitch | `bible.json` |
| 2 | `cast_ref` | character-designer | writes the reference prompt; ComfyUI (`comfy.imageModel`, z-image-turbo) makes 3 candidates, 1024x1536 on flat #808080, arms held away from the body; the designer picks 1 | `cast/<id>/ref/c1..3.png`, `ref.png` |
| 3 | `rig` | character-designer | per character one or more rig paths as variants (below), pose sheet, comparison, choice | `cast/<id>/variants/<v>/`, `variants.json`, `rig.json`, `parts/`, `sheet.png` |
| 4 | `set` | background-artist | prompt; ComfyUI 1920x1080 background upscaled 1.5x (sharp lanczos) and a keyed foreground prop; the artist reads the image and places `groundY`, marks and shots | `sets/<id>/layers/bg.png`, `prop.png`, `set.json` |
| 5 | `script` | writer | the language-independent script and both texts (12-16 lines for the pilot, only existing beats, gestures, emotions, marks and shots; self-check: at most 12 words per line in both languages) | `script.json`, `text/hr.json`, `text/en.json`, bible episode entry |
| 6 | `safety` | child-safety-reviewer | must pass; `revise` sends the problems back to the writer (script and safety are reopened), at most 2 revise rounds, then the step fails | `reviews/safety.json` |
| 7 | `voice_cast` | voice-director | voices per language into the bible (hr OmniVoice attribute tags, seed and Supertonic fallback; en Kokoro, distinct per character; Gemini names); one audition line per character and language | bible voices, `cast/<id>/voice/<lang>.wav` |
| 8 | `voice` | (code) | `runVoice` (allocation, OmniVoice, Kokoro, Gemini within the quota); emits `voice.clip` | `voice/<lang>/*.wav`, `manifest.json` |
| 9 | `music` | composer | picks mood/chip/seed and the effects; Chiptune Studio makes theme and up to 2 SFX; the script's cues are pointed at the files that exist (a missing studio = no music, a warning) | `music/*.ogg` |
| 9b | `clip_shots` | showrunner | for each `clip` beat without a file (the intro once per series, at most one hero clip per episode) writes the shot and the input of `video-plan.mjs plan` | `tasks/clip-shots.json`, `episodes/<ep>/video/screenplay.json`, `clips-map.json` |
| 9b | `clips` | frame-critic | waits for a Flow credit cap and each clip's `max_credits`; keyframe (free), video (credits, behind `charge`), review, one retry | `series/<slug>/clips/intro.mp4` or `episodes/<ep>/clips/<id>.mp4`, `clips.json` |
| 10 | `timeline` | (code) | lip-sync and `timeline.<lang>.json` for every language (T4), then `cts_lint` with `requireAudio` must have 0 errors | `lipsync/`, `timeline.*.json` |
| 11 | `preview_render` | (code) | 960x540 preview per language, 12-frame contact sheet, pose sheets | `out/<lang>.preview.mp4`, `render/<lang>/sheet-12.png` |
| 12 | `frame_review` | frame-critic | reads the contact sheet and the pose sheets: off model, parts, mouth, facing, framing, background. Not must-pass; up to 2 rounds: a second round happens when the step runs again after the data was fixed (`from: "preview_render"`) | `reviews/frames-<lang>-<n>.json` |
| 13 | `final_render` | (code) | 1920x1080 per language and the summary | `out/<lang>.mp4`, `pipeline.json` `summary` |

### Rig paths (step 3)

Three paths make one rig format; each is a variant under `cast/<id>/variants/<v>/`, with its wall time and spend in `cast/<id>/variants/variants.json`.

| path | variant | how | cost |
|---|---|---|---|
| `claude-svg` | a (default) | the character-designer draws the part SVGs from `ref.png` and `seed/style/cutout-kids.md` (VectorCraft in the hub session when available, hand-written SVG otherwise). The answer carries `rig` and `parts`, or the session calls `cts_rig_set` and answers `{viaTool: true}`. `cts_rig_check` must pass: its errors go back to the designer (2 retries). | $0 |
| `recraft-svg` | b | Recraft draws the figure as an SVG (`images/recraft.ts`, behind `charge`); the designer gives cut polygons and pivots; code splits the SVG by centroid-in-polygon (`svg-split.ts`) and puts the face of variant a on it. At a $0 cap the call is refused (`BUDGET_EXCEEDED` or `KEY_MISSING`) and the variant is recorded `not-run`. | paid |
| `raster` | c | the reference is keyed (`images/key.ts` removes the Z-Image halo), the designer gives polygons, pivots and the face position, code crops PNG parts with an overlap at the joints and adds the face of variant a | $0 |

`options.rigPaths { "<castId>": ["claude-svg", "raster"] }` builds more than the default; `cts_rig_build` does one path as a job. After all variants of a character are built the pipeline renders their pose sheets, one comparison sheet (`cast/<id>/variants/compare.png`, also `cts_rig_compare`) and copies the chosen variant up to `cast/<id>/` (`options.rigChoice { "<castId>": "a" }`, default a; `cts_rig_choose` does it later). A variant over the 45 minute time box is noted in `variants.json`; the pilot comparison is a hub-session task.

### Flow clips (step 9b)

Decision 12 of the plan. The intro (`clip` beat id `intro`) is made once per series (`series/<slug>/clips/intro.mp4`, `clips.json` there); at most one other clip (the hero moment) per episode (`episodes/<ep>/clips/<id>.mp4`, the entry's `file` is relative to the episode folder). The spend is charged to the episode that triggers it.

1. `clip_shots`: the showrunner writes who, what happens in 8 s, framing, move and the keyframe for each missing clip; code writes `episodes/<ep>/video/screenplay.json` in the shape `scripts/video-plan.mjs plan` reads (one chapter, one scene, a shot per clip) and `clips-map.json` (clip id to shot id). **The hub session** runs `video-plan.mjs plan <dir>` / `next <dir>` / `record <dir> <shot> @result.json` for the estimate and each call's `max_credits` (`cts_clip_plan` prints the commands). Cartoon Studio copies no price table.
2. `clips` waits (`waiting-on-user`) until `cts_budget_set` recorded a `flowCreditsCap` for the episode and each missing clip has its `max_credits` (`options.clipCredits { "intro": 15 }`), or the clips are made by hand with `cts_clip_generate`, or `options.skipClips: true` drops them (recorded NOT RUN: `clips.json` gets `fallback: true` entries and the beats fall back to a title card).
3. For each clip: keyframe by `flow_generate` type image (`max_credits: 0`, `reference_images` = the leads' `ref.png` then their pose sheets, at most 3); video by `flow_generate` type video (Omni 1.1 Flash, 720p, 8 s, `first_frame` = the keyframe, `max_credits` = the given one) inside `charge({currency: "credits"})` (`FLOW_CREDITS_EXCEEDED` past the cap, nothing spent); download to the clip path; `clips.json` gets `{id, file, seconds, credits, flowMediaId, prompt, review}`.
4. The frame-critic reviews a 6-frame sheet of the clip next to the pose sheets. `revise` gives one retry (a new generation, charged again); a second fail sets `fallback: true` (the spend stays in `spend.json`).

Flow needs upload rights for local reference pictures (`FLOW_MUSIC_MCP_UPLOAD_RIGHTS=agree` in its `.env`, the user's to give); without them `cts_clip_generate` stops before spending anything.

## The role task contract

Every model job is a role task (`tasks.ts`): `{ id, role, kind, prompt, inputs: { paths[], json }, output: { schema, path } }`.

- `role`: one of the 8 roles (the job's role decides the agent and the model list; every role starts on `client/claude-code`).
- `kind`: the prompt template `prompts/<role>/<kind>.md` (the data folder's copy, else the seed's). The system message is `prompts/_rules.md`, the agent's persona and that guide (plus `style/cutout-kids.md` for the character-designer).
- `inputs`: `json` is shown as JSON, `paths` (relative to the series folder) are shown as text, pictures are attached (shrunk to 1568 px JPEG).
- `output.schema` names the answer's schema (`TASK_SCHEMAS` in `tasks.ts`, or a file tag like `cts.review/1`); `output.path` is where the validated answer is written (relative to the series folder; `tasks/<id>.json` for the composite answers, `episodes/<ep>/reviews/*.json` for reviews).

The answer is checked BEFORE anything is written. `cts_submit_task` already refuses a reply that does not match the JSON schema (`accepted: false` with the problems; the task stays leased, no round is spent). A reply that parses but fails the zod schema, or the task's own check (for example the script's references and word counts, `cts_rig_check` for a rig), goes back to the model as a retry with the errors (2 retries; the script gets 3). Reviews use the review JSON `{verdict: "pass" | "revise", scores, notes, problems: [{where, what, fix}]}`.

## Events for the studio

`series.state { series, episode, state, step }` on every change of the run state, `pitch.chosen { series, pitch }`, `voice.clip { series, episode, lang, line, status, provider, seconds, file }` per line after the voice step, `job.progress { jobId, series, task, unit, episode, fraction, message }` at the start of a step and during the voice, rig, set and render steps. (Shapes in `src/shared/protocol.ts`.)

## Options

`options` of `cts_run_pipeline`: `rigPaths`, `rigChoice`, `skipClips`, `clipCredits` (above). `brief` keys read by the steps: `idea`, `title`, `ageMin`, `ageMax`, `notes`, `seconds` (target length), `lineRange` (default `[12, 16]`), `intro` (false = no intro clip), `heroClip` (false = no hero clip).

## Not covered

Everything that needs ComfyUI, Flow, Chiptune Studio, VibeTTS or a browser was checked with fakes only (`docs/mcp-guide.md` says what is UNTESTED). The pilot (P) runs it for real.
