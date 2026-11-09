# Roadmap

The tasks of Cartoon Studio, in order. The big plans, with the research behind them, are `HUB-29` (phase 1 and the cutout pilots) and `HUB-30` (the 3D route) in the creative hub (`../creative-hub/.claude/tickets/HUB-30-cartoon-3d/plan.md`); they are split into the tickets below. Every ticket is `CTS-NN`, has a plan in `.claude/tickets/CTS-NN-<name>/plan.md` and a branch named after it, and gets one commit. When it is done its row says Done.

Phase 1 is the scaffold and a **60-second pilot** the user watches (two characters, one set, 12 to 16 lines, a Croatian and an English MP4, a $0 run). Phase 2 (episode 1 of a named series, 5 to 10 minutes) starts only after the user has watched the pilot and said go.

## Where it stands

- **Phase 1 (CTS-01..09) is done**: the engine, the contracts, the player, the timeline, the render, the voices, the pipeline, the studio UI and the Windows package.
- **Pilots 1 and 2 (cutout puppets) were judged not good by the user on 2026-11-08.** Pilot 1 (series `pilot`, SVG rigs) had been called good before; pilot 2 (CTS-10..17, series `pip-bruno`, Z-Image raster rigs) changed the method and the user said changing models would not fix it. The method is **superseded by the 3D route**; the music, mix and Flow work of pilot 2 (CTS-15, CTS-16) is kept.
- **HUB-31 (CTS-30..36)** adds ElevenLabs free-tier voices (through flow-music-mcp) and vehicle characters (cars and trains, roads and tracks); pilot 4 is tracked in the creative hub.
- **The 3D route (CTS-18..29)** replaces the renderer: characters and sets are specs built by code in Blender 5.2, the episode is rendered with EEVEE and mixed with the existing ffmpeg code. It is done in code; **pilot 3** (series `pip-bruno-3d`, Pip and Bruno, about 60 s, hr and en) and the user's verdict are tracked in the creative hub's `HUB-30` plan. The Canvas player is frozen (it renders pilots 1 and 2) and is decided again after that verdict.

## Phase 1 tickets

| Ticket | What | State |
|---|---|---|
| **CTS-01** | Repo scaffold and engine core: store and lock, queue, logs, budget, models, MCP server (with the `/preview/` and `/files/<series>/` read-only routes), studio clients (VibeTTS, Chiptune Studio (unused since CTS-15), Flow, ComfyUI), the Electron shell, the seed (8 roles, settings, providers, voice, budget, render, studios, autostart), an empty player stub. `docs/provenance.md` records the Edu commit and every copied file. | Done |
| **CTS-02** | Contracts, series store and lint: zod schemas for bible, rig, set, episode script, text catalog, voice manifest, lip-sync track, timeline and review in `src/shared/contracts.ts`; `sample.ts`; the series service with a path guard; `cts_lint`; `docs/contracts.md`. | Done |
| **CTS-03** | Puppet player and preview: the deterministic Canvas 2D player (`window.cts`), embedded in the studio, served at `/preview/` and loaded by the renderer. | Done |
| **CTS-04** | Timeline builder, amplitude lip-sync, seeded blinks and idle bob. | Done |
| **CTS-05** | Render and mix: Playwright plus ffmpeg, encoder probe, audio mix with ducking and loudness, contact sheets and pose sheets, the Flow clip splice. | Done |
| **CTS-06** | Voices and music: the Gemini quota and the local chain (OmniVoice for Croatian, Kokoro for English), the voice manifest, music (Chiptune Studio at the time; ComfyUI since CTS-15). | Done |
| **CTS-07** | Pipeline, roles and the `cts_*` tools: the eight roles as client tasks, image generation, `docs/mcp-guide.md`, `docs/pipeline.md`. | Done in code |
| **CTS-08** | Image providers and the budget gate: the image provider slot (ComfyUI, fal; Flow images and Recraft with `svg-split` were removed in CTS-10, a `gemini` provider was added in CTS-11), the keyring, the per-production cap and spend ledger, Flow credits. The pilot cap is $0. | Done |
| **CTS-09** | Studio UI and the Windows installer: the eight views, the embedded player, `yarn dist:installer` and `yarn dist:portable`. | Done |

## Pilot 2 tickets (Pip and Bruno, Z-Image puppets; superseded by the 3D route)

| Ticket | What | State |
|---|---|---|
| **CTS-10** | Remove Recraft (path b), `cts_svg_split` and the Flow image provider; the clip keyframe is a player still; Flow video only for `intro` and `outro`. | Done |
| **CTS-11** | Z-Image image-to-image and masked inpaint in the ComfyUI client and `cts_image_generate`; the `gemini` (Nano Banana) provider behind the budget gate (refused at cap $0). | Done; the sketch-to-sheet use is superseded by the 3D route (CTS-28); text-to-image, image-to-image, inpaint and the gemini gate stay |
| **CTS-12** | Rough sketches from a body plan, the `cast_sheet` step (sketch, Z-Image master, three poses) and the `sheet_review` pause with `cts_sheet_approve`. | Done; superseded by the 3D route (the `cast_sheet` step and the sketches were removed in CTS-28; the `sheet_review` pause and `cts_sheet_approve` stay) |
| **CTS-13** | Raster rig from the master with image face patches (inpaint where it works, drawn where it does not), PNG plates in lint and the player. | Done; superseded by the 3D route (raster rigs and face patches were removed in CTS-28) |
| **CTS-14** | Optional pose images per gesture (`cts_pose_make`, the `poses` step). | Done; superseded by the 3D route (`cts_pose_make` and the `poses` step were removed in CTS-28) |
| **CTS-15** | Music from ComfyUI: ACE-Step instrumental theme (MiniMax Music as alternative), MOSS sound effects; Chiptune Studio dropped. | Done |
| **CTS-16** | The mix: per-stem loudness, music 18 dB under the voice (8 dB in the gaps), the measured mix check and `W_MIX_MUSIC_LOUD`. | Done |
| **CTS-17** | The pipeline order (a given pitch skips the pitch pause; `poses` step; mix check in the final step), the Cast view (sketch, master, sheet poses, approve and redo), the Settings view (music engine, image fallback order, gemini cap), the docs, the prompts and the style guide. | Done |

The pilot 2 run itself (series `pip-bruno`, hr and en, about 60 s, intro and outro from Flow within 50 credits) is in the creative hub (`HUB-29`, `runs/pip-bruno-pilot.md`). Its look was judged not good (2026-11-08); CTS-15 (music) and CTS-16 (the mix) are kept, CTS-11..14 are superseded by the 3D route below, and CTS-17 is partly superseded (the Cast view and the pipeline order now have a 3D variant, CTS-27).

## The 3D route (Blender, series `pip-bruno-3d`)

Branch `CTS-18_blender-3d`, cut from the pilot 2 branch. The plan is `HUB-30` in the creative hub.

| Ticket | What | State |
|---|---|---|
| **CTS-18** | Blender runner and config: `config/blender.md` (path, the 5.2 pin, chunk size), `src/engine/blender/{config,runner}.ts`, the `CTS {...}` stdout protocol, `blender/run.py` + `cts_blender/{api5,io}.py`, `cts_blender_status` / `cts_blender_config`, `yarn test:blender`, `blender/LICENSE` (GPL-3.0-or-later), packaging. | Done |
| **CTS-19** | 3D contracts (`cts.character3d/1`, `cts.set3d/1`, `cts.style3d/1`, `cts.timeline3d/1`, lip-sync methods), the bible `renderer`, lint by renderer, the `mini3d` fixture. | Done |
| **CTS-20** | Character builder (primitives on parented empties, outlines, face ray test, six mouth slots), the turnaround sheet, `cts_character_*`, the designer prompt. | Done |
| **CTS-21** | Set builder with a prop kit, marks, named cameras, the set sheet, `cts_set3d_*`, the background-artist prompt. | Done |
| **CTS-22** | The look: toon material, inverted-hull outlines, blob shadows, sky, view transform, optional post, `style3d.json`. | Done |
| **CTS-23** | The acting library: walk and hop cycles with planted feet, gestures, reactions, springs, listening and talking automation, camera moves, the dense channel writer. | Done |
| **CTS-24** | Six-viseme lip-sync from text, audio and whisper word times (`words-<lang>`, else `text-<lang>`), lint for silent or flat mouths. | Done |
| **CTS-25** | `timeline3d` (beats to actions with times, accents, blinks, shots), the scene assembler, `cts_scene_assemble`, `cts_still`, framing that follows walking actors. | Done |
| **CTS-26** | The Blender render backend: chunked EEVEE render, per-chunk encode, concat, Flow splice, `muxEpisode`, frame times, contact sheets; the scene is rebuilt when a character or the set changes. | Done |
| **CTS-27** | The pipeline for `renderer: blender` (`character`, `set3d`, `assemble` steps), tools, and the Cast, Sets, Preview and Settings views. | Done |
| **CTS-28** | The cutout authoring path retired: sketches, the Z-Image sheet step, raster rigs, face patches, pose images, 2D sets, `cts_rig_set/build/compare/choose`, `cts_pose_make`, their prompts; canvas steps answer `E_RETIRED`. Pilots 1 and 2 still lint and render. | Done |
| **CTS-29** | Docs: README (3D first, Canvas legacy, Blender 5.2 required, the GPL folder), `docs/blender.md`, `docs/provenance.md`, AGENTS.md, this roadmap. | Done |

Pilot 3 (the run) and its acceptance criteria (C1..C17) are in the creative hub. Phase 2 (a 5 to 10 minute episode) starts only after the user has watched pilot 3 and said go; if the answer is yes, the Canvas player and Playwright are retired with it.

## ElevenLabs voices and vehicle characters (HUB-31, series `pip-bruno-wheels`)

Branch `CTS-30_vehicles-elevenlabs`, cut from `CTS-18_blender-3d`. The plan is `HUB-31` in the creative hub (`../creative-hub/.claude/tickets/HUB-31-vehicles-voices/plan.md`); the ElevenLabs client lives in flow-music-mcp (FMM-17, FMM-18).

| Ticket | What | State |
|---|---|---|
| **CTS-30** | ElevenLabs as the first voice provider through flow-music-mcp (`studios/flow.ts`, `providers/elevenlabs.ts`): allocation ElevenLabs, then Gemini, then local, whole languages, Croatian first; `voice.<lang>.elevenlabs` in the bible; word times from the alignment (`wordsFrom`, shifted by `leadTrimS`); `cts_voice_quota` with the ElevenLabs line; `cts_voice_audition`; `eleven-credits` in `spend.json`; `W_VOICE_MIXED`, `W_VOICE_ID_CHANGED`. | Done |
| **CTS-31** | Vehicle contracts (`kind: "vehicle"`, the `vehicle` block, the `drive` motion, `cylinder`, lamp eyes, set `paths`, the road-and-rail prop kinds), `library.json` `bodies`, lint `E_VEHICLE_LIMB`, `E_ACTION_BODY`, `E_MARK_OFF_PATH`, `E_OFF_TRACK`, `E_PATH_BLOCKED`, the `mini-vehicles` fixture. | Done |
| **CTS-32** | The vehicle builder (wheels, lamp eyes with hoods and glow, bumper-mouth slots, puff pools, the antenna chain, the face ray test), the motion strip of the sheet, the designer prompt with the lamp-eyes rule, the Pip-car and Bruno-engine examples in `toon-3d.md`. | Done |
| **CTS-33** | The road-and-rail set kit: paths as curves, `road`, `track`, `crossing`, `platform`, `signal`, `buffer_stop`, the set sheet with the paths, the background-artist prompt. | Done |
| **CTS-34** | The vehicle acting library (`acting/vehicle.py`): `idle_engine`, hood blinks, `look_at`, the talking and listening automation, `drive`/`zoom`/`reverse`/`chug` along a path, the car `turn`, the gestures and reactions; B2v tests. | Done |
| **CTS-35** | Timeline, assembly, pipeline and app for vehicle series: moves along paths and trains held to their tracks, vehicles on the road or rail top, a car over the crossing boards, puffs and lamp glow keyed, vehicle framing, writer facts and checks by body (sounds paired with sfx beats, the credit title card), premade ElevenLabs voices for the voice cast, `W_SFX_MISSING`, the Cast and Settings views; the pipeline test and the Blender e2e on `mini-vehicles`. | Done |
| **CTS-36** | Docs: README, this roadmap, `docs/blender.md` (vehicles, paths, the actions, the build.json vehicle block), `docs/mcp-guide.md` (`cts_voice_audition`, `cts_voice_quota`, the voice plan), `docs/pipeline.md`. | Done |
| **CTS-37** | The voice review gate: `voice_review` after `voice_cast` on every Blender series, released by `cts_voice_approve {series, ok, note?}` (`voice-review.json` with the hash of the voices; `ok: false` recasts with the note); the casting's auditions go through ElevenLabs (the code of `cts_voice_audition`, credits in `spend.json`) when the cast has ElevenLabs voices and the free tier is ready. | Done |
| **CTS-38** | Budget before series: a series exists when it has a `bible.json`, so `cts_budget_set` may come before `cts_run_pipeline` or `cts_series_create`, which keep the episode files. | Done |
| **CTS-39** | One revise job per pipeline: a second `cts_sheet_approve ok: false` while the character job is queued or running joins it; the job takes every redo note until none is left. | Done |
| **CTS-40** | Flat visemes on English lines: a gap under 2 frames between two heard words is bridged, a short spoken run never becomes rest (pilot 4 en l12 from 52 % to 66 % open). | Done |
| **CTS-41** | Vehicle polish: the car `turn` ends on its road's line, the antenna swings without pinning on a hard `zoom`, the vehicle wide shot rises over a body that hides another actor, `compose.build` resets every actor, `normaliseWav` measures the lead silence only on request, the visor ray test (a warning). Creature output identical. | Done |
| **CTS-42** | Docs: the MCP guide's intro and `cts_run_pipeline` row for the 3D route, the set sheet's plan row (2048 x 1728), `tiptoe` as a slow `walk`, these rows. | Done |

Pilot 4 (series `pip-bruno-wheels`, about 60 s, hr and en, ElevenLabs voices, $0 and 0 Flow credits) and its acceptance criteria are in the creative hub's `HUB-31` plan.

## Not in phase 1

Android, macOS and Linux builds, code signing, auto-update, a Scriptorium episode format, publishing anywhere. (Word-timed lip-sync and walk cycles came with the 3D route.)
