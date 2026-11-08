# Roadmap

The tasks of Cartoon Studio, in order. The big plan, with the research behind it, is `HUB-29` in the creative hub (`../creative-hub/.claude/tickets/HUB-29-cartoon-studio/plan.md`); it is split into the tickets below. Every ticket is `CTS-NN`, has a plan in `.claude/tickets/CTS-NN-<name>/plan.md` and a branch named after it, and gets one commit. When it is done its row says Done.

Phase 1 is the scaffold and a **60-second pilot** the user watches (two characters, one set, 12 to 16 lines, a Croatian and an English MP4, a $0 run). Phase 2 (episode 1 of a named series, 5 to 10 minutes) starts only after the user has watched the pilot and said go.

## Where it stands

- **Phase 1 (CTS-01..09) is done**: the engine, the contracts, the player, the timeline, the render, the voices, the pipeline, the studio UI and the Windows package, and the pilot 1 episode (series `pilot`, SVG rigs) was watched and judged good by the user.
- **Pilot 2 (CTS-10..17)** changes how the puppets and the music are made: Z-Image image-to-image from a rough sketch (raster rigs with image face patches, optional pose images), music from ComfyUI, the music mixed well under the voice by measurement, Flow only for the intro and outro videos, no Recraft. It is done in code; the pilot 2 run (series `pip-bruno`, hr and en) and the user's look at it are tracked in the creative hub's `HUB-29` plan.

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

## Pilot 2 tickets (Pip and Bruno, Z-Image puppets)

| Ticket | What | State |
|---|---|---|
| **CTS-10** | Remove Recraft (path b), `cts_svg_split` and the Flow image provider; the clip keyframe is a player still; Flow video only for `intro` and `outro`. | Done |
| **CTS-11** | Z-Image image-to-image and masked inpaint in the ComfyUI client and `cts_image_generate`; the `gemini` (Nano Banana) provider behind the budget gate (refused at cap $0). | Done |
| **CTS-12** | Rough sketches from a body plan, the `cast_sheet` step (sketch, Z-Image master, three poses) and the `sheet_review` pause with `cts_sheet_approve`. | Done |
| **CTS-13** | Raster rig from the master with image face patches (inpaint where it works, drawn where it does not), PNG plates in lint and the player. | Done |
| **CTS-14** | Optional pose images per gesture (`cts_pose_make`, the `poses` step). | Done |
| **CTS-15** | Music from ComfyUI: ACE-Step instrumental theme (MiniMax Music as alternative), MOSS sound effects; Chiptune Studio dropped. | Done |
| **CTS-16** | The mix: per-stem loudness, music 18 dB under the voice (8 dB in the gaps), the measured mix check and `W_MIX_MUSIC_LOUD`. | Done |
| **CTS-17** | The pipeline order (a given pitch skips the pitch pause; `poses` step; mix check in the final step), the Cast view (sketch, master, sheet poses, approve and redo), the Settings view (music engine, image fallback order, gemini cap), the docs, the prompts and the style guide. | Done |

The pilot 2 run itself (series `pip-bruno`, hr and en, about 60 s, intro and outro from Flow within 50 credits) and the user's verdict on the look, the music level and phase 2 are in the creative hub (`HUB-29`, `runs/pip-bruno-pilot.md`).

## Not in phase 1

Android, macOS and Linux builds, code signing, auto-update, word-timed lip-sync, walk cycles beyond a slide with bob, a Scriptorium episode format, publishing anywhere.
