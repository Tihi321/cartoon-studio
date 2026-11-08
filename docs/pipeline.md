# The pipeline (CTS-07)

`cts_run_pipeline { series, episode, brief?, options?, retry?, from? }` makes one episode of a series from an idea: pitches, a premise the user chooses, art, script, voices, music, video clips, renders. Re-call it with the same ids to resume (the Edu `edu_run_pipeline` pattern): the state is read from `series/<slug>/episodes/<ep>/pipeline.json` and the job store, never from memory, so it survives a restart.

Code: `src/engine/pipeline/` -- `steps.ts` (the step list), `run.ts` (the state machine: `Pipeline.run / advance / choosePitch`), `handlers.ts` and `media.ts` (the job handlers), `tasks.ts` (the role task contract), `rig.ts` (the variants record, read only), `clips.ts` (Flow clips), `tools.ts` (the MCP tools). Images: `src/engine/images/` (providers: ComfyUI Z-Image, Gemini, fal). Prompts: `seed/prompts/<role>/<kind>.md`, the 3D guide `seed/style/toon-3d.md`.

## Two step lists (CTS-27)

The steps below are the list of a **canvas** series (pilots 1 and 2, the `mini` fixture; frozen since HUB-30). A series with `renderer: "blender"` follows the list under "A Blender series" further down. The renderer is chosen when the run starts: `options.renderer` (`"canvas"` or `"blender"`) of the first `cts_run_pipeline` of an episode, else the bible's `renderer` (a hand-made series), else canvas; `run` writes `renderer: "blender"` and `style3d: "style3d.json"` into the bible of a new series. A state file follows its own list for good: one that has a `character` or `assemble` step is a Blender run, any other is a canvas run and `normalise` never changes it. A canvas series with a cast or episodes cannot be switched (start a new series); an episode cannot change its renderer. `from: "<step>"` and the step names in the report are the ones of the run's own list.

## State

`pipeline.json` (`cts.pipeline/1`):

- `state`: `idle`, `running`, `waiting-on-user`, `waiting-on-client` (a model call waits for `cts_get_task`), `failed`, `done`.
- `steps.<id>`: `state` (`pending`, `running`, `done`, `failed`), `job` (the job id), `detail` (how it ended; `redo` and `revise N: ...` mark a step to be made again), `error`, `attempts`, times.
- `brief`: what the run was asked, and under `brief.options` the run's choices. `run`: counter. `waitingOn`: why it waits. `summary`: written by the last step.

`advance` looks at the first step that is not done: a gate that is not open stops the run (`waiting-on-user`); a pending step becomes a job `<series>--<task>--<episode>--r<n>` of the step's role; a running step whose job is queued/running keeps the state `running` (or `waiting-on-client` while the job's model call sits in the client queue); a failed job fails the step. A handler marks its step done and calls `advance`, which enqueues the next step's job. `cts_wait {series}` therefore follows the whole run: it returns when a model call waits for you (`clientTasks`) or nothing is left. `cts_status {series}` lists the pipelines (state, step, hint).

`retry: true` puts failed steps back to pending. `from: "<step>"` puts that step and every later step back (marked `redo`: their handlers make the files again instead of keeping them). `options` are merged into the stored ones.

## The mandatory pause

Step 1 (`pitch`) writes three pitches into `bible.json` (`pitches`, `chosenPitch: null`). The next step, `pitch_choice`, is a **gate**: it is done only when `bible.chosenPitch` names one of `bible.pitches`, and only `cts_pitch_choose { series, pitch }` (or the studio's Series view, which calls it) writes that, together with the time (`bible.chosenAt`). Until then the run is `waiting-on-user` and **nothing visual is made**: re-calling `cts_run_pipeline`, `retry` and `from: "<later step>"` all stop at the gate again, `Pipeline.enqueue` refuses a later step if no premise is chosen, every visual handler checks it first, and `cts_series_update` cannot set the pitch fields. `from: "pitch"` makes new pitches and clears the choice. Show the user the pitches (title, logline, two leads, sets, why; `cts_series_get` or the `pitches` of the run report) and wait for their answer.

**A given pitch skips the pause.** `cts_run_pipeline { brief: { pitch: { id?: "p1", title: {hr, en}, logline: {hr, en}, leads: [{name, what}], sets: [], why } } }` is the user's pick made earlier: the run writes `pitches: [<that pitch>]` and `chosenPitch` (id default `p1`) into the bible, marks `pitch` and `pitch_choice` done (detail "given pitch p1") and starts at `bible`. Without `brief.pitch` the pitch pause stays as above. The two pauses of a run are then the character sheets and the user watching the films.

A `pipeline.json` written before CTS-12 has a `cast_ref` step: on load a finished one becomes a finished `cast_sheet` and `sheet_review` (detail "made before the sheet step: no review"), any other state becomes a pending `cast_sheet`; the `cast_ref` key is dropped. A `pipeline.json` written before CTS-17 has no `poses` step: on load it becomes `skipped` when its `rig` is done (pending otherwise), so pilot 1's series `pilot` loads and renders as before.

## Steps

| # | id | role | what it does | writes |
|---|---|---|---|---|
| 1 | `pitch` | showrunner | 3 premises (hr + en title and logline, two leads, 1-2 sets, why) | `bible.json` `pitches`, `tasks/pitches.json` |
| 1 | `pitch_choice` | (gate) | waits for the user | `bible.chosenPitch`, `chosenAt` |
| 1b | `bible` | showrunner | cast (with a `look` each), sets, tone, rules, style from the chosen pitch | `bible.json` |
| 2 | `cast_sheet` | character-designer | **retired in CTS-28** (the Z-Image sheet over a drawn sketch). A finished canvas pilot keeps it done; a run that would make it answers `E_RETIRED`. A `blender` series uses `character` instead | (canvas pilots: `cast/<id>/sheet.png`, `ref.png`, `sheet/meta.json`) |
| 2 | `sheet_review` | (gate) | **waits for the user**: `cts_sheet_approve { series, cast, ok, note? }` for every character (`ok: true` writes `bible.cast[].sheet {approvedAt, seed, denoise, model}`); nothing is rigged before | bible `cast[].sheet`, `cast/<id>/sheet/review.json` |
| 3 | `rig` | character-designer | **retired in CTS-28** (raster and claude-svg rigs, face patches). `E_RETIRED` in a canvas series; pilots 1 and 2 keep their rigs, which `cts_rig_check`, lint and the canvas renderer still read | (canvas pilots: `rig.json`, `parts/`, `variants/`) |
| 3b | `poses` | frame-critic | **retired in CTS-28** (pose images). `E_RETIRED` in a canvas series | (canvas pilots: `poses/`) |
| 4 | `set` | background-artist | **retired in CTS-28** (Z-Image 2D backgrounds and keyed props). `E_RETIRED` in a canvas series; the set contract (`set.json`) stays and `cts_set_get` / `cts_set_update` still edit it. A `blender` series uses `set3d` | (canvas pilots: `sets/<id>/layers/`, `set.json`) |
| 5 | `script` | writer | the language-independent script and both texts (12-16 lines for the pilot, only existing beats, gestures, emotions, marks and shots; self-check: at most 12 words per line in both languages) | `script.json`, `text/hr.json`, `text/en.json`, bible episode entry |
| 6 | `safety` | child-safety-reviewer | must pass; `revise` sends the problems back to the writer (script and safety are reopened), at most 2 revise rounds, then the step fails | `reviews/safety.json` |
| 7 | `voice_cast` | voice-director | voices per language into the bible (hr OmniVoice attribute tags, seed and Supertonic fallback; en Kokoro, distinct per character; Gemini names); one audition line per character and language | bible voices, `cast/<id>/voice/<lang>.wav` |
| 8 | `voice` | (code) | `runVoice` (allocation, OmniVoice, Kokoro, Gemini within the quota); emits `voice.clip` | `voice/<lang>/*.wav`, `manifest.json` |
| 9 | `music` | composer | picks style tags, bpm, key, seed and up to 2 effects; ComfyUI makes a 40 s instrumental theme (`comfy.musicModel`: `ace-step-v1-instrumental`, or `minimax-music-3`; faded in 0.5 s and out 2 s) and the effects (`moss-soundeffect-v2`); the engine and the wall time go in the step detail; the script's cues are pointed at the files that exist (ComfyUI down = no music, a warning). No Chiptune Studio | `music/*.ogg` |
| 9b | `clip_shots` | showrunner | for each `clip` beat without a file (the intro and the outro, once per series; no other id) writes the shot, its `staging` (set, camera shot, the leads' marks, emotion, gesture) and the input of `video-plan.mjs plan` | `tasks/clip-shots.json`, `episodes/<ep>/video/screenplay.json`, `clips-map.json` |
| 9b | `clips` | frame-critic | waits for a Flow credit cap and each clip's `max_credits`; keyframe (free), video (credits, behind `charge`), review, one retry | `series/<slug>/clips/intro.mp4` or `episodes/<ep>/clips/<id>.mp4`, `clips.json` |
| 10 | `timeline` | (code) | lip-sync and `timeline.<lang>.json` for every language (T4), then `cts_lint` with `requireAudio` must have 0 errors | `lipsync/`, `timeline.*.json` |
| 11 | `preview_render` | (code) | 960x540 preview per language, 12-frame contact sheet, pose sheets | `out/<lang>.preview.mp4`, `render/<lang>/sheet-12.png` |
| 12 | `frame_review` | frame-critic | reads the contact sheet and the pose sheets: off model, parts, mouth, facing, framing, background. Not must-pass; up to 2 rounds: a second round happens when the step runs again after the data was fixed (`from: "preview_render"`) | `reviews/frames-<lang>-<n>.json` |
| 13 | `final_render` | (code) | 1920x1080 per language and the summary. The mix is set by `config/render.md` `mix` (voices to -20 LUFS, music 18 dB under the voice while someone speaks and 8 dB under in the gaps, then `loudnorm` to -16 LUFS); each final render writes `render/<lang>/mix-check.json` and the step detail and summary give the input loudness and `minUnderDb` (the smallest number of dB the music sits under the voice, over the lines) next to it (`W_MIX_MUSIC_LOUD` in lint below `minUnderVoiceDb`) | `out/<lang>.mp4`, `render/<lang>/mix-check.json`, `pipeline.json` `summary` |

## A Blender series (CTS-27)

`src/engine/pipeline/steps.ts` `BLENDER_STEPS`; the handlers of the new steps are in `media3d.ts`, the shared ones branch on `bible.renderer`. A character or a set is **data**: a JSON spec of primitives that Blender builds; no image model makes anything.

| id | role | what it does | writes |
|---|---|---|---|
| `pitch`, `pitch_choice` | showrunner, gate | as above; skipped with `brief.pitch` | `bible.json` |
| `bible` | showrunner | as above for a 3D look (toon shapes, palette, leads that differ in silhouette and speed); sets `renderer`, `style3d` and copies the default look `seed/style/style3d.json` to the series' `style3d.json` when it has none | `bible.json`, `style3d.json` |
| `character` | character-designer | per cast member: the spec that is there is built first; with none (or on a redo) the designer writes `cast/<id>/character.json` (`cts.character3d/1`, guide `style/toon-3d.md`, the other characters' specs for contrast, the user's redo note); Blender builds it (`character_build`: `character.blend`, `sheet.png`, `build.json`); the designer reads `sheet.png` (kind `character-review`). `revise` or a build error such as `E_FACE_HIDDEN` sends the designer back, at most **2 revisions** (then the sheet goes to the user as it is, with what the designer would still change in the log). A built spec with a current sheet is kept | `cast/<id>/character.json`, `character.blend`, `sheet.png`, `sheet/*.png`, `build.json`, `tasks/character-*.json` |
| `sheet_review` | (gate) | **waits for the user**: `cts_sheet_approve { series, cast, ok, note? }` for every character. `ok: true` writes `bible.cast[].sheet { approvedAt, specHash }` (refused when the spec changed after the last build; an approval of an older spec `specHash` no longer counts and the gate reopens); `ok: false` needs a note, keeps it in `cast/<id>/sheet-redo.json`, withdraws the approval and reopens `character` + `sheet_review` (only that character is designed again, the designer gets the note). Nothing else is built before every character is approved | bible `cast[].sheet`, `sheet/review.json` |
| `set3d` | background-artist | per set: the same loop with `sets/<id>/set3d.json` (`cts.set3d/1`, the prop kit, marks, named cameras), `set_build` (`set.blend`, a four-view `sheet.png`) and a `set-review` of the sheet | `sets/<id>/set3d.json`, `set.blend`, `sheet.png`, `build.json` |
| `script` | writer | as above, but the writer gets the **acting library** (`blender/cts_blender/acting/library.json`: action names, kind, seconds, `overLine`, `needsTarget`), the emotions the assembler knows, `move.style` (`walk`, `hop`, `run`, `tiptoe`), `gesture.target`, and per set the marks, the camera shots (the set's cameras, `wide`, `two`, `cu-<id>`, `ots-<a>-<b>`) and the props (a seat or not). The checks add: an action that needs a target has a valid one, `sit` targets a prop with a seat | `script.json`, `text/*.json` |
| `safety`, `voice_cast`, `voice`, `music` | | as above; `voice` also asks whisper (`flow_transcribe`) for word times and stores the aligned words in the manifest | |
| `clip_shots`, `clips` | showrunner, frame-critic | as above; the shot's `staging` is checked against the 3D set (marks, shots) and the library (a gesture without a target); the keyframe is a **Blender still** of that staging (`keyframe3d.ts`: a one-scene `cts.timeline3d/1` assembled in `clips/keyframes/work-<id>/` and one frame rendered, the same `still` command `cts_still` runs); the Flow prompt asks for the toon 3D look; the review compares with the characters' `sheet.png`. The gate (credit cap, `max_credits`) is unchanged | `clips/keyframes/<id>.png`, `clips/<id>.mp4` |
| `timeline` | (code) | six-viseme lip-sync (24 fps), `cts.timeline3d/1` per language, then `cts_lint` with `requireAudio` must have 0 errors | `lipsync/`, `timeline.<lang>.json` |
| `assemble` | (code) | one `scene.blend` and `assembly.json` per language (`assemble` command: assets appended, actors on marks, the acting library run, cameras, titles); an assembler error (`E_ACTION_UNKNOWN`, `E_MARK_UNKNOWN`, `E_SHOT_UNKNOWN`, `E_ASSEMBLE_FAILED`) fails the step with its code | `render/<lang>/scene.blend`, `assembly.json` |
| `preview_render` | (code) | Blender renders 960x540 (4 samples) in chunks, each chunk is encoded while the next renders; 12-frame contact sheet cut from the MP4 (`render/blender.ts`) | `out/<lang>.preview.mp4`, `render/<lang>/sheet-12.png`, `blender-times.json` |
| `frame_review` | frame-critic | kind `frames-3d`: the contact sheet and each character's `sheet.png`; on model, feet planted, no limb through the body, mouth shut in silence, eyes on the speaker, framing, the set. Not must-pass; up to 2 rounds | `reviews/frames-<lang>-<n>.json` |
| `final_render` | (code) | 1920x1080 (16 samples), real Flow clips spliced in, the mix and `mix-check.json`; the summary has the Blender frame times per language | `out/<lang>.mp4`, `render/<lang>/blender-times.json`, `mix-check.json` |

The Blender work reports its stage: `cts_status {series}` shows `blender { task, unit, stage, fraction }` in the pipeline entry while a build, the assembly or a render runs (`blender/stage.ts`; in memory only), and the studio gets the same as `job.progress`. The runner is the one of `config/blender.md`; tests inject a fake one with `setBlenderRunnerOverride` (`tests/pipeline.test.ts` runs this whole list on `mini3d`). A Blender that is missing or of another version fails the step with `E_BLENDER_MISSING` / `E_BLENDER_VERSION`; `cts_blender_status` says which first.

`options` read by this list: `renderer`, `skipClips`, `clipCredits`, `skipAuditions` (no audition line in `voice_cast`). `rigPaths`, `rigChoice`, `poses` and `poseFacePlates` belonged to the canvas list and are ignored since CTS-28.

### Retired in CTS-28: the cutout authoring path

The rig paths (`claude-svg` as variant `a`, `raster` as variant `c`), the face patches, the pose images, the body plan and sketches, the Z-Image character sheet and the 2D set art were removed with their tools (`cts_rig_set`, `cts_rig_build`, `cts_rig_compare`, `cts_rig_choose`, `cts_pose_make`) and prompts. Only the readers stay: `cast/<id>/variants/variants.json` (`pipeline/rig.ts`), the rig and set contracts, `cts_rig_check`, `cts_pose_sheet` and lint, so pilots 1 and 2 still lint and render with the frozen Canvas player.

### Image to image, inpaint and the paid fallback (CTS-11)

- `cts_image_generate { provider: "comfy", init, denoise, mask? }` (and `ComfyRequest.init` / `ImageRequest.init`) runs Z-Image Turbo from a start picture: `LoadImage -> VAEEncode` as the latent, 8 steps, `res_multistep`, cfg 1, AuraFlow shift 3, `denoise` from the request (0.75-0.85 turns a rough sketch into a drawn character; 0.35-0.6 cleans up a render). The result has the start picture's size. With `mask` (same size, white = redraw) only the masked region is redrawn: `LoadImageMask -> SetLatentNoiseMask` before the sampler, and the result is composited over the start picture through the mask, so the rest stays exactly as it was. $0.
- `provider: "gemini"` is Nano Banana (Gemini API `generateContent`, image output), the paid fallback after (1) Z-Image at a lower denoise from a rig render and (2) Qwen-Image 2.1 edit with the sheet as reference. The model id and USD price come from `config/prices.md` (a row marked "check before use"), the key is the keyring account `GEMINI_API_KEY` (`key-set gemini`), and every call is behind `charge` (usd): at cap $0 it is refused with `BUDGET_EXCEEDED` before any network call. It runs only after the user said yes and `cts_budget_set` recorded an amount.
- **Upgrade path, not installed:** pose-exact drawing from a skeleton or sketch would use ComfyUI's `ZImageFunControlnet` node with a Z-Image union ControlNet as a model patch (`ModelPatchLoader`). No ControlNet or model patch is installed on this machine (their loader lists are empty), nothing was downloaded, and downloading one needs the user's yes.

### Flow clips (step 9b)

Decision 12 of the plan. The intro and the outro (`clip` beat ids `intro` and `outro`; no other id is allowed) are made once per series (`series/<slug>/clips/<id>.mp4`, `clips.json` there). The keyframe is a still drawn by our own player from the clip's `staging` (the set, the leads at their marks, emotion, gesture peak) at 1280x720, saved as `clips/keyframes/<id>.png`; Flow makes video only, with that still as `first_frame`. `polish: true` runs Z-Image img2img (local ComfyUI, $0) on the still at denoise 0.35 and sends that as `first_frame` (`clips/keyframes/<id>-polished.png`); if ComfyUI cannot do it the plain still is used and the result says `polish: { skipped }`. A pilot 1 episode may still hold a `hero` clip entry at episode level: it keeps resolving. The spend is charged to the episode that triggers it.

1. `clip_shots`: the showrunner writes who, what happens in 8 s, framing, move and the keyframe for each missing clip; code writes `episodes/<ep>/video/screenplay.json` in the shape `scripts/video-plan.mjs plan` reads (one chapter, one scene, a shot per clip) and `clips-map.json` (clip id to shot id). **The hub session** runs `video-plan.mjs plan <dir>` / `next <dir>` / `record <dir> <shot> @result.json` for the estimate and each call's `max_credits` (`cts_clip_plan` prints the commands). Cartoon Studio copies no price table.
2. `clips` waits (`waiting-on-user`) until `cts_budget_set` recorded a `flowCreditsCap` for the episode and each missing clip has its `max_credits` (`options.clipCredits { "intro": 15 }`), or the clips are made by hand with `cts_clip_generate`, or `options.skipClips: true` drops them (recorded NOT RUN: `clips.json` gets `fallback: true` entries and the beats fall back to a title card).
3. For each clip: keyframe = the player still described above (no Flow image call); video by `flow_generate` type video (Omni 1.1 Flash, 720p, 8 s, `first_frame` = the keyframe, `max_credits` = the given one) inside `charge({currency: "credits"})` (`FLOW_CREDITS_EXCEEDED` past the cap, nothing spent); download to the clip path; `clips.json` gets `{id, file, seconds, credits, flowMediaId, prompt, review}`.
4. The frame-critic reviews a 6-frame sheet of the clip next to the pose sheets. `revise` gives one retry (a new generation, charged again); a second fail sets `fallback: true` (the spend stays in `spend.json`).

Flow needs upload rights for local reference pictures (`FLOW_MUSIC_MCP_UPLOAD_RIGHTS=agree` in its `.env`, the user's to give); without them `cts_clip_generate` stops before spending anything.

## The role task contract

Every model job is a role task (`tasks.ts`): `{ id, role, kind, prompt, inputs: { paths[], json }, output: { schema, path } }`.

- `role`: one of the 8 roles (the job's role decides the agent and the model list; every role starts on `client/claude-code`).
- `kind`: the prompt template `prompts/<role>/<kind>.md` (the data folder's copy, else the seed's). The system message is `prompts/_rules.md`, the agent's persona and that guide (plus `style/toon-3d.md` for the 3D designer tasks).
- `inputs`: `json` is shown as JSON, `paths` (relative to the series folder) are shown as text, pictures are attached (shrunk to 1568 px JPEG).
- `output.schema` names the answer's schema (`TASK_SCHEMAS` in `tasks.ts`, or a file tag like `cts.review/1`); `output.path` is where the validated answer is written (relative to the series folder; `tasks/<id>.json` for the composite answers, `episodes/<ep>/reviews/*.json` for reviews).

The answer is checked BEFORE anything is written. `cts_submit_task` already refuses a reply that does not match the JSON schema (`accepted: false` with the problems; the task stays leased, no round is spent). A reply that parses but fails the zod schema, or the task's own check (for example the script's references and word counts, `cts_rig_check` for a rig), goes back to the model as a retry with the errors (2 retries; the script gets 3). Reviews use the review JSON `{verdict: "pass" | "revise", scores, notes, problems: [{where, what, fix}]}`.

## Events for the studio

`series.state { series, episode, state, step }` on every change of the run state, `pitch.chosen { series, pitch }`, `voice.clip { series, episode, lang, line, status, provider, seconds, file }` per line after the voice step, `job.progress { jobId, series, task, unit, episode, fraction, message }` at the start of a step and during the voice, rig, set and render steps. (Shapes in `src/shared/protocol.ts`.)

## Options

`options` of `cts_run_pipeline`: `renderer` (`canvas` or `blender`, a new episode only), `skipAuditions` (no audition lines in `voice_cast`), `rigPaths` (default raster; `claude-svg` only when asked), `rigChoice`, `poses`, `poseFacePlates`, `skipClips`, `clipCredits` (above). `brief.pitch` (above) skips the pitch pause. `brief` keys read by the steps: `idea`, `title`, `ageMin`, `ageMax`, `notes`, `seconds` (target length), `lineRange` (default `[12, 16]`), `intro` (false = no intro clip), `outro` (false = no outro clip).

## Not covered

Everything that needs ComfyUI, Flow, VibeTTS or a browser was checked with fakes only (`docs/mcp-guide.md` says what is UNTESTED). The pilot (P) runs it for real.
