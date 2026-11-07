# Roadmap

The tasks of Cartoon Studio, in order. The big plan, with the research behind it, is `HUB-29` in the creative hub (`../creative-hub/.claude/tickets/HUB-29-cartoon-studio/plan.md`); it is split into the tickets below. Every ticket is `CTS-NN`, has a plan in `.claude/tickets/CTS-NN-<name>/plan.md` and a branch named after it, and gets one commit. When it is done its row says Done.

Phase 1 is the scaffold and a **60-second pilot** the user watches (two characters, one set, 12 to 16 lines, a Croatian and an English MP4, a $0 run). Phase 2 (episode 1 of a named series, 5 to 10 minutes) starts only after the user has watched the pilot and said go.

## Where it stands

- **CTS-01 is done in code** (the scaffold and engine core, copied from Edu Studio at `46b6ec1`): the engine, the MCP server with ten `cts_` tools, the Electron shell with an empty Series view, the seed configuration, the build and the Windows package. Not played or watched by a human; no cartoon exists yet.

## Phase 1 tickets

| Ticket | What | State |
|---|---|---|
| **CTS-01** | Repo scaffold and engine core: store and lock, queue, logs, budget, models, MCP server (with the `/preview/` and `/files/<series>/` read-only routes), studio clients (VibeTTS, Chiptune Studio, Flow, ComfyUI), the Electron shell, the seed (8 roles, settings, providers, voice, budget, render, studios, autostart), an empty player stub. `docs/provenance.md` records the Edu commit and every copied file. | Done in code |
| **CTS-02** | Contracts, series store and lint: zod schemas for bible, rig, set, episode script, text catalog, voice manifest, lip-sync track, timeline and review in `src/shared/contracts.ts`; `sample.ts`; the series service with a path guard; `cts_lint`; `docs/contracts.md`. | Planned |
| **CTS-03** | Puppet player and preview: the deterministic Canvas 2D player (`window.cts`), embedded in the studio, served at `/preview/` and loaded by the renderer. | Planned |
| **CTS-04** | Timeline builder, amplitude lip-sync, seeded blinks and idle bob. | Planned |
| **CTS-05** | Render and mix: Playwright plus ffmpeg, encoder probe, audio mix with ducking and loudness, contact sheets and pose sheets, the Flow clip splice. | Planned |
| **CTS-06** | Voices and music: the Gemini quota and the local chain (OmniVoice for Croatian, Kokoro for English), the voice manifest, Chiptune Studio music. | Planned |
| **CTS-07** | Pipeline, roles and the `cts_*` tools: the eight roles as client tasks, image generation, `docs/mcp-guide.md`, `docs/pipeline.md`. | Planned |
| **CTS-08** | Image providers and the budget gate: the image provider slot (ComfyUI, Flow, fal, Recraft), the keyring, the per-production cap and spend ledger, Flow credits, `svg-split`. The pilot cap is $0. | Done in code |
| **CTS-09** | Studio UI and the Windows installer: the eight views, the embedded player, `yarn dist:installer` and `yarn dist:portable`. | Planned |

## Not in phase 1

Android, macOS and Linux builds, code signing, auto-update, word-timed lip-sync, walk cycles beyond a slide with bob, a Scriptorium episode format, publishing anywhere.
