# Cartoon Studio MCP guide

Cartoon Studio makes a series of cutout-puppet cartoons for children aged 4 to 8: the cast, the rigs and the sets are made once and reused, each episode has a Croatian and an English voice track over the same animation, and the base animation is rendered locally to MP4. This server lets an agent such as Claude Code drive the studio: see the series and the job queue, and do the model work of the jobs itself, at no cost.

**Status: CTS-07 (the pipeline).** Every tool below exists; the full list is at the end of this guide. Everything that needs ComfyUI, Flow, Chiptune Studio, VibeTTS or a browser was checked with fakes only until the pilot runs it (what is UNTESTED is said under each section).

## Connect

- Port **7465** on 127.0.0.1 (`config/mcp.md`; `CTS_MCP_PORT` overrides it for one run, `yarn mcp --port N` too).
- Token: none by default. With a `token` in `config/mcp.md` (or `CTS_MCP_TOKEN`) every request must send `Authorization: Bearer <token>`.
- Only requests with a loopback `Host` and no foreign `Origin` are served.
- Claude Code: `claude mcp add --transport http cartoon-studio http://127.0.0.1:7465/mcp`
- Headless (no window): `yarn mcp` (= `node out/engine/index.js --mcp-only`). The app runs the same server while it is open.
- Stdio, for clients that cannot speak HTTP: `claude mcp add cartoon-studio -- yarn --cwd <repo> engine -- mcp`. It relays to the running engine when there is one, else it starts its own.
- Only one engine can use a data folder (`state/engine.lock` in it names the running one). A second start prints where the running one serves MCP.
- The data folder is `~/CartoonStudio` (`--data <dir>` or `CTS_DATA` change it). A series lives in `series/<slug>/`.
- The same port also serves two read-only pages: `/preview/` (the player bundle) and `/files/<series>/...` (files under `series/<series>/` only).

## Tools

All tool names start with `cts_`. Every call returns JSON, also as `structuredContent`; a failure is an error result with a message.

| Group | Tools |
|---|---|
| Queue | `cts_status {series?}` (the job counts of a series, or of every series; `clientTasks`), `cts_wait {series?, timeoutSeconds?}` (waits until the series has nothing left to run), `cts_pause_all`, `cts_resume_all`, `cts_stop_now {drop?, slug?}` |
| Client provider | `cts_client_tasks`, `cts_get_task {client?, role?, series?, task?}`, `cts_submit_task {taskId, text}`, `cts_release_task {taskId}` |
| Generators | `cts_studios_status` (ComfyUI, Chiptune Studio, flow-music-mcp, VibeTTS) |

A job id is `<series>--<task>--<unit>--r<run>`, so `cts_status {series}` finds the jobs of a series by their prefix.

## Do the model work yourself

A role or agent set to the model `client/claude-code` (in `config/roles.md`) parks its model calls in the engine's client task queue. `cts_wait` returns with `clientTasks`; then loop: `cts_get_task` (takes the oldest waiting call, leased for 30 minutes) -> write the answer -> `cts_submit_task {taskId, text}`. When the task has a schema the answer is checked: a failed check returns `{accepted: false, problems}` and the task stays yours, so fix the text and submit again. `cts_client_tasks` lists the waiting and leased tasks; `cts_release_task` gives one back. A task is for one client model: without `client` you get the `claude-code` ones. The queue is lost when the engine restarts: the running job is asked again.

## Budget and images (CTS-08)

| Tool | What it does |
|---|---|
| `cts_budget_set {series, episode, capUsd, flowCreditsCap?, approvedBy, note?}` | Writes `episodes/<ep>/budget.json` (with `approvedAt`). Call it only after the user approved the amount. Without it both caps are 0 and every paid call is refused. |
| `cts_budget_get {series, episode}` | Caps, spent per currency (usd, credits), what is left, and the ledger `spend.json`. |
| `cts_image_generate {series, episode, provider?, prompt, width?, height?, format?, out?, refs?, model?, seed?}` | `comfy` (default, also `auto`): local, free; `refs` makes it an edit (Qwen). `gemini` (Nano Banana): a stub until CTS-11, refuses. `fal`: paid, charged to the episode budget. No image goes through Flow. |

Every paid call goes through `charge` (`src/engine/budget/spend.ts`): the price estimate (from `config/prices.md`, unverified, check before use) is checked against the cap BEFORE the call (`BUDGET_EXCEEDED` for dollars, `FLOW_CREDITS_EXCEEDED` for Flow credits) and the real cost is appended to `spend.json` afterwards. A series-level spend (the series intro or outro clip) is charged to the episode that triggers it. The key for `fal` is read only from this tool's credential store: a missing one is `KEY_MISSING <provider>`; store it with `node out/engine/index.js key-set fal`.

## Voices and music (CTS-06)

| Tool | What it does |
|---|---|
| `cts_voice_plan {series, episode, lang?, provider?}` | Speaks nothing. The clips (script lines x series languages) with their state (`current`, `new`, `changed`, `redo`, `forced`), the allocation per language (Gemini only within the free quota, Croatian first; else the local chain), what is left of the Gemini quota, what is up, and warnings (bad OmniVoice tags, missing texts or voices). |
| `cts_voice_generate {series, episode, lang?, ids?, force?, provider?}` | Returns a job id; the job speaks every clip that needs it and writes `episodes/<ep>/voice/<lang>/<line>.wav` (44.1 kHz mono, edge silence trimmed) and `manifest.json`. A clip is made again only when its hash (text, language, voice, speed, style) changes; a clip no provider can speak becomes a silent placeholder (2.5 words a second) with status `placeholder` and a warning, never a failed run. `costUsd` is 0. |
| `cts_voice_status {series, episode}` | Per language: the allocation, every line's status/provider/engine/seconds, total seconds; and the voice jobs of the series. |
| `cts_voice_quota {reset?}` | Today's Gemini TTS counter (`state/gemini-tts.json`): limit 10, used, remaining; the day ends at Pacific midnight. |
| `cts_music_generate {series, mood, chip, seed, seconds?, sfx?}` | Returns a job id; Chiptune Studio makes `series/<slug>/music/theme.ogg` (a 30-40 s loop) and up to 2 effects (`sfx`: `{kind: sfx|stinger|ambience, sound, name?}`) as `.ogg` beside it. No Chiptune Studio = a warning in the job log and no music. |

Who speaks: the hub rule (`config/voice.md`). Gemini (`flow_narrate`, engine `gemini`, one request per clip) only when a whole language fits in the free requests left today; otherwise the local chain `localOrder`: Croatian OmniVoice through ComfyUI, then Supertonic through VibeTTS; English Kokoro through VibeTTS, then OmniVoice. A character's bible voice can pin `comfy`, `vibetts` or `paid` (the paid slot goes through the budget gate and then throws `NOT_IMPLEMENTED` in phase 1). OmniVoice reads `voice.<lang>.comfy.instruct` as attribute tags only (`male|female`, `child|teenager|young adult|middle-aged|elderly`, `very low|low|moderate|high|very high pitch`, `whisper`, and one English accent); other words are dropped with a warning in `cts_voice_plan`. ComfyUI memory is freed (`comfyKindSwitch`, `src/engine/comfy/kind-switch.ts`) before voice work after image work and the other way round.

## Render and sheets (CTS-05)

| Tool | What it does |
|---|---|
| `cts_render {series, episode, langs?, quality?, maxSeconds?, wait?}` | Returns one job id per language (`<series>--render--<ep>-<lang>-<quality>--r<n>`); the Canvas player in headless Chromium draws every frame, ffmpeg encodes (`h264_amf` when it works on this machine, else `libx264`), the audio is mixed (music ducked under voices, -16 LUFS). `quality: final` -> `episodes/<ep>/out/<lang>.mp4` (1920x1080, real clips spliced in); `preview` -> `out/<lang>.preview.mp4` (960x540, clips show a placeholder card). `render/<lang>/render.log` has the frames, stage times and encoder. A missing clip file that is not marked `fallback` fails the final render (`E_CLIP_MISSING`); a `fallback` clip shows the cutout scene with the actors bouncing. |
| `cts_render_status {id?}` | State (running, done, failed), progress in frames, and the result or error of the render jobs of this engine session (they are not in the markdown job queue: a render needs no model). |
| `cts_frames {series, episode, lang?, count? or times?}` | Contact sheet PNG of N frames (default 12) with time labels: `episodes/<ep>/render/<lang>/sheet-<n>.png`. Returns the path and the picture. |
| `cts_pose_sheet {series, cast, variant?}` | Pose sheet PNG of a rig: `cast/<id>/sheet.png` (or the variant's). Returns the path and the picture. |

The render serves the player and the series folders itself on a random 127.0.0.1 port (same routes as the MCP server's `/preview/` and `/files/`), so it does not need the MCP server or its token. `state/encoder.json` caches the encoder probe (delete it to probe again). Sizes, fps, encoder order, frame format and loudness are in `config/render.md`.

## Series, rigs, sets, episodes and the pipeline (CTS-07)

The model work of the pipeline is done through the client task tools above; `docs/pipeline.md` has the steps, the pause, the role task contract and the files.

| Tool | What it does |
|---|---|
| `cts_run_pipeline {series, episode, brief?, options?, retry?, from?}` | Starts or resumes the episode pipeline (creates the series from the brief when it does not exist). The first call needs `brief {idea, title?, ageMin?, ageMax?, notes?, seconds?, lineRange?, intro?, outro?}`. Answers with the state, the current step, every step, a `hint` on what to do next, the pitches while they wait and the `summary` when done. Re-calling with the same ids resumes; it never skips the pitch pause. `retry: true` puts failed steps back; `from: "<step>"` redoes a step and everything after it; `options {rigPaths, rigChoice, skipClips, clipCredits}`. |
| `cts_pitch_choose {series, pitch}` | The user's pick of premise p1/p2/p3: writes `bible.chosenPitch` and `chosenAt`, and lets every pipeline that waits go on. Call it only with the pitch the user chose. |
| `cts_sheet_approve {series, cast, ok, note?}` | The user's verdict on one character sheet (`cast/<id>/sheet.png`: master + wave, point, shrug). The pipeline waits at `sheet_review` until every character is approved; `ok: true` writes `bible.cast[].sheet`; `ok: false` needs a note and makes that sheet again with new seeds. Call it only with the user's answer. |
| `cts_series_create {slug, title?, logline?, ageMin?, ageMax?, languages?}` | A stub bible. Usually not needed. |
| `cts_series_get {series}` | The bible, pitches and the chosen one, the rig variants per character, the episodes and the pipelines. |
| `cts_series_update {series, title?, logline?, tone?, rules?, audience?, languages?, style?, music?, cast?, sets?}` | Changes the bible (validated). The pitches and the choice cannot be changed here. |
| `cts_cast_get {series, cast?}` | The cast entry, the rig (parts, gestures, emotions), the variants (path, wall time, spend), `cts_rig_check` of the chosen rig and of each built variant, the reference and sheet paths. |
| `cts_rig_set {series, cast, variant?, rig, parts}` | Writes `rig.json` and the part SVGs under `cast/<id>/` (or `variants/<v>/`) and returns the `cts_rig_check` result. `parts` maps a rig file (`parts/body.svg`, `body.svg` or `body`) to SVG text; a file not given must already exist. Nothing is written when the rig does not parse or a file is missing. |
| `cts_rig_check {series, cast, variant?}` | (CTS-02) The part rules, all 8 mouths, 3 eye states and 4 brows. |
| `cts_rig_build {series, episode, cast, path?}` | Job: builds one rig path (`claude-svg` = a, `raster` = c) as a variant, with the pose sheet and the time and spend in `variants.json`. |
| `cts_rig_compare {series, cast}` | One sheet with the pose sheets of the built variants side by side, each under its path, time and spend: `cast/<id>/variants/compare.png`. Returns the picture. |
| `cts_rig_choose {series, cast, variant}` | Copies the variant's rig, parts and sheet up to `cast/<id>/` and runs `cts_rig_check`. |
| `cts_set_get {series, set?}` / `cts_set_update {series, set, groundY?, actorScale?, layers?, marks?, shots?}` | Read a set (or list them); change it (marks and shots merge by name, `null` removes one). Validated. |
| `cts_episode_create {series, episode, title?, cast, set, shot?, mark?}` | A hand-made episode: a one-scene stub script, registered in the bible. |
| `cts_episode_get {series, episode?}` | Script, both texts, voice status per line, timelines, reviews, clips, budget and spend, pipeline. Without an episode: the list. |
| `cts_script_set {series, episode, script}` / `cts_text_set {series, episode, lang, text? or strings?/lines?}` | Write the script / one language's text (validated; `strings` and `lines` merge into the catalog). |
| `cts_timeline_build {series, episode}` | Lip-sync and the timelines of all languages (needs the voices). Then `cts_lint {requireAudio: true}`. |
| `cts_clip_plan {series, episode}` | The missing Flow clips, their shots, the credit cap and spend, and the `video-plan.mjs` commands (`plan`, `next`, `record`) for the hub session. |
| `cts_clip_generate {series, episode?, clip: "intro"\|"outro", maxCredits}` | Job: keyframe (a still drawn by our own player from the clip's `staging`, 1280x720, `clips/keyframes/<id>.png`; no image goes to Flow), the 8 s video scene (`max_credits` = `maxCredits`, charged to the Flow credit cap), review (one retry, then `fallback`). Refuses without a recorded `flowCreditsCap` and past it; any other clip id is refused (no hero clip). `episode` only names the budget that pays. |
| `cts_clip_review {series, episode?, clip}` | Job: the frame-critic reviews six frames of the clip next to the pose sheets. |

`cts_status {series}` also lists the pipelines of the series: `state` (`running`, `waiting-on-user` after the pitches until `cts_pitch_choose`, or while Flow clips wait for a credit cap; `waiting-on-client`; `failed`; `done`), the current step and a hint.

UNTESTED against the real services (checked with fakes): ComfyUI image jobs (`cast_sheet` in the app's flow, `set`; the sheet images were probed live with a hand-made body plan, not through a model task), Flow video (`flow.generateVideo` is new in `studios/flow.ts` and follows `flow_generate` in `flow-music-mcp/src/flow/tools.ts`), the player still of a clip (Chromium), the Chiptune and VibeTTS calls of the pipeline, and the pose sheets and renders (Chromium).

## All tools

| Group | Tools |
|---|---|
| Queue and client provider | `cts_status`, `cts_wait`, `cts_pause_all`, `cts_resume_all`, `cts_stop_now`, `cts_client_tasks`, `cts_get_task`, `cts_submit_task`, `cts_release_task`, `cts_studios_status` |
| Series, cast, sets, episodes | `cts_series_create`, `cts_series_get`, `cts_series_update`, `cts_pitch_choose`, `cts_sheet_approve`, `cts_cast_get`, `cts_set_get`, `cts_set_update`, `cts_episode_create`, `cts_episode_get`, `cts_script_set`, `cts_text_set` |
| Rigs | `cts_rig_set`, `cts_rig_check`, `cts_rig_build`, `cts_rig_compare`, `cts_rig_choose`, `cts_pose_sheet` |
| Pipeline and clips | `cts_run_pipeline`, `cts_timeline_build`, `cts_lint`, `cts_clip_plan`, `cts_clip_generate`, `cts_clip_review` |
| Voices and music | `cts_voice_plan`, `cts_voice_generate`, `cts_voice_status`, `cts_voice_quota`, `cts_music_generate` |
| Budget and images | `cts_budget_set`, `cts_budget_get`, `cts_image_generate` |
| Render | `cts_render`, `cts_render_status`, `cts_frames` |
