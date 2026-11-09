# Provenance

Cartoon Studio started from **Edu Studio** (`Tihi321/edu-game-studio`, the user's own repository, MIT) at commit `46b6ec1` ("EGS-61: Strata docs drop the removed IQ3_S launchers"), taken with `git archive 46b6ec1` so that the later commits of Edu's `master` are not part of it. Edu itself was built from VN Studio's engine core. This file lists every file the copy produced and what happened to it; keep it true when a copied file changes a lot.

Totals at CTS-01: 143 files, 41 copied unchanged, 87 copied and changed, 15 new.

## The Blender probe (HUB-30, CTS-18..29)

Not copied from Edu: the 3D route started from a 15 s probe of Pip and Bruno in a park, made in the creative hub on 2026-11-08 (`.claude/temp/blender-probe/` there: `build_scene.py`, `render.py`, `notes.md`). The probe is the **origin** of three pieces of code, which were rewritten into this repository's structure and tested:

- the **character and set builders** (`blender/cts_blender/build_character.py`, `build_set.py`, `shapes.py`): primitives on parented empties, the six-mouth slots shown by scale, inverted-hull outlines, blob shadows, and the ray test that came from the probe's buried-mouth bug (`E_FACE_HIDDEN`);
- the **lip-sync** (`src/engine/anim/visemes.ts`): the probe's Croatian letter table (`lj`/`nj`/`dž` as one letter, vowel visemes, labials to `MBP`, `k g h` to the next vowel), the RMS voiced-segment matching and the 24 fps rules (a minimum hold of 2 frames, a lip closure shown for 2 frames); CTS-24 added the English grapheme table and whisper word times on top; CTS-40 changed two rules: a gap between two heard words shorter than the 2-frame hold is bridged, and a short spoken run joins a spoken neighbour (or takes a frame of a rest around it) instead of turning into rest;
- the **look** (`blender/cts_blender/materials.py`, `seed/style/style3d.json`): Diffuse, Shader to RGB, a constant two-stop ColorRamp and Emission, the `Standard` view transform, a sun without shadows, a sky gradient, and the 5.x compositor group used for the optional post effects.

The probe also supplied the Blender 5.x gotchas collected in `blender/cts_blender/api5.py` and [blender.md](blender.md), and the render-time numbers (about 0.13 s a frame at 1080p on the AMD 8060S) that the pilot 3 acceptance criteria are based on. The acting library, the scene assembler and the engine side are new code.

## What was kept, renamed and replaced

- **Engine core, kept:** `src/engine/store` (atomic writes, data folder, seed refresh, watcher, the data-folder lock), `queue` (jobs, scheduler), `logs`, `budget/spend.ts`, `agents`, `models` (client, mock, OpenAI-compatible, Anthropic, Gemini, router, registry, limiter, keys, custom providers), `summary.ts`, `transport.ts`, `cli.ts` (probe, key-set), `pipeline/llm.ts` (JSON extraction and schema helpers only), `mcp` (HTTP, server, stdio, relay, config, controller, client-task tools), `studios` (mcp-http, autostart, launch, config, VibeTTS, Chiptune Studio, Flow), `comfy` (client, graphs, TTS engines, audio save, custom workflows).
- **Electron shell, kept:** `src/main`, `src/preload`, the app frame, store, Models, Agents and Settings pages and the design tokens of `src/renderer` and `src/design`, `electron-builder.config.cjs`, `electron.vite.config.ts`, the `dist*` scripts, `scripts/verify-package.mjs`, `scripts/make-icons.mjs`, `scripts/studio-shots.mjs`.
- **Renamed:** MCP tools `edu_*` to `cts_*`; environment `EDU_*` to `CTS_*` (`CTS_DATA`, `CTS_MCP_PORT`, `CTS_MCP_TOKEN`, `CTS_SEED`, `CTS_AUTOSTART`); MCP port 7463 to 7465; data folder `~/EduGames` to `~/CartoonStudio`; preload bridge `window.edustudio` to `window.cartoonstudio`; file protocol `edustudio-file://` to `cartoonstudio-file://`; CSS variables `--edu-*` to `--cts-*`; the zustand store `eduStore` to `ctsStore`; app id `dev.selak.cartoon-studio`, product name "Cartoon Studio", package `cartoon-studio`; the credential-store service `edu-studio` to `cartoon-studio`.
- **Replaced:** `edu/service.ts` (`EduService`) by `service.ts` (`CtsService`: queue helpers, generator clients, `listSeries`, `studiosStatus`); `edu/handlers.ts` by the module lists `modules.ts` and `mcp/modules.ts`; `educli.ts` by `headless.ts`; the course MCP tools by ten `cts_` tools in `mcp/tools.ts` (`cts_status`, `cts_wait`, `cts_studios_status`, the four client-task tools, `cts_pause_all`, `cts_resume_all`, `cts_stop_now`; `edu_clear_queue` is a service method only); the Library page and course store by the Series page and series store.
- **Changed in kept files:** `protocol.ts` (course events and commands replaced by `listSeries`, `studiosStatus`, `series.listed`, `studios.status`), `schemas.ts` (the 8 cartoon roles; quality and formats schemas dropped; `budget.voice.paidMaxUsd`; no paid fallback by default), `media.ts` (cut to language, voice provider, chip and engine-task names), `studios/config.ts` (Pixel Studio and Scriptorium removed), `engine.ts` (the research and course parts removed; `queue` and `registerModule` added; module list applied), `index.ts` (no course CLI, no speech-to-text), `mcp/http.ts` (the static routes), `store/lock.ts` (the lock lives in `state/`), `store/seedRefresh.ts` and `seedMigrations.ts` (Edu's seed history and migrations dropped), `main/files.ts` (serves `series/<slug>/...` only), the icon (a flat cutout face).
- **Seed:** `seed/config` has eight files (roles, settings, providers, voice, budget, render, studios, autostart) written from Edu's; `voice.md` keeps Edu's allocation rule with a per-language local chain (`localOrder`); `seed/agents` has eight new personas.

## Not copied from Edu

`src/engine/edu` (the course store, build, lint, pipeline, assets, music, voice services), `android`, `assets`, `live`, `stt`, `research`, `puzzles`, `themes`, `review` (the review JSON shape comes back with CTS-02's contracts), `voice` (CTS-06 writes the allocation for this repo), `studios/pixel*`, `studios/scriptorium`, `studios/draw`, `studios/music`, `studios/chip-*`, `comfy/inventory`, `comfy/ui-to-api`, `mcp/tools-{android,class,course,live,media,pipeline,research,stt}`, `src/player` (the game player), `src/live-client`, `src/shared` course, edu, puzzles, shells, lang, live and classroom modules, the course views of `src/renderer`, `themes/`, `courses/`, the game fonts, the autoplay bot scripts, all of Edu's tests and fixtures, the Android scripts, Edu's docs and `.claude/tickets`.

## Every file

| File | Against Edu `46b6ec1` | Note |
|---|---|---|
| `.gitattributes` | unchanged |  |
| `.gitignore` | changed |  |
| `.yarnrc.yml` | unchanged |  |
| `AGENTS.md` | changed |  |
| `LICENSE` | unchanged |  |
| `README.md` | changed |  |
| `ROADMAP.md` | changed |  |
| `build/icon.ico` | changed |  |
| `build/icon.png` | changed |  |
| `docs/mcp-guide.md` | changed |  |
| `electron-builder.config.cjs` | changed |  |
| `electron.vite.config.ts` | unchanged |  |
| `eslint.config.mjs` | unchanged |  |
| `package.json` | changed |  |
| `scripts/make-icons.mjs` | changed |  |
| `scripts/studio-shots.mjs` | changed |  |
| `scripts/verify-package.mjs` | changed |  |
| `seed/agents/background-artist-mira-castellan.md` | new |  |
| `seed/agents/character-designer-priya-nakamura.md` | new |  |
| `seed/agents/child-safety-reviewer-hugo-lindqvist.md` | changed |  |
| `seed/agents/composer-tobias-lindqvist.md` | changed |  |
| `seed/agents/frame-critic-felix-ostrander.md` | new |  |
| `seed/agents/showrunner-mara-quill.md` | new |  |
| `seed/agents/voice-director-elodie-brandt.md` | changed |  |
| `seed/agents/writer-jonas-reyes.md` | new |  |
| `seed/config/autostart.md` | changed |  |
| `seed/config/budget.md` | changed |  |
| `seed/config/providers.md` | changed |  |
| `seed/config/render.md` | new |  |
| `seed/config/roles.md` | changed |  |
| `seed/config/settings.md` | changed |  |
| `seed/config/studios.md` | changed |  |
| `seed/config/voice.md` | changed |  |
| `src/design/fonts/atkinson-hyperlegible-next/OFL.txt` | unchanged |  |
| `src/design/fonts/atkinson-hyperlegible-next/atkinson-hyperlegible-next-latin-ext-wght-normal.woff2` | unchanged |  |
| `src/design/fonts/atkinson-hyperlegible-next/atkinson-hyperlegible-next-latin-wght-normal.woff2` | unchanged |  |
| `src/design/fonts/atkinson-hyperlegible-next/font.css` | unchanged |  |
| `src/design/fonts/young-serif/OFL.txt` | unchanged |  |
| `src/design/fonts/young-serif/font.css` | unchanged |  |
| `src/design/fonts/young-serif/young-serif-latin-400-normal.woff2` | unchanged |  |
| `src/design/fonts/young-serif/young-serif-latin-ext-400-normal.woff2` | unchanged |  |
| `src/design/tokens.css` | changed |  |
| `src/engine/agents/agents.ts` | unchanged |  |
| `src/engine/budget/spend.ts` | changed |  |
| `src/engine/cli.ts` | changed |  |
| `src/engine/comfy/audio-save.ts` | unchanged |  |
| `src/engine/comfy/client.ts` | changed |  |
| `src/engine/comfy/custom-workflow.ts` | unchanged |  |
| `src/engine/comfy/graphs.ts` | unchanged |  |
| `src/engine/comfy/tts-engines.ts` | unchanged |  |
| `src/engine/comfy/kind-switch.ts` | new | CTS-06: `comfyKindSwitch(kind)` frees ComfyUI memory (`POST /free`) when the work switches between voice and image; T7 and T9 call it before their ComfyUI batches |
| `src/engine/engine.ts` | changed |  |
| `src/engine/headless.ts` | new | `startHeadless` of Edu's `educli.ts`, without the course CLI |
| `src/engine/index.ts` | changed |  |
| `src/engine/logs/logs.ts` | changed |  |
| `src/engine/mcp/config.ts` | changed |  |
| `src/engine/mcp/controller.ts` | changed |  |
| `src/engine/mcp/http.ts` | changed |  |
| `src/engine/mcp/modules.ts` | new | the list of MCP tool modules |
| `src/engine/mcp/raw.d.ts` | unchanged |  |
| `src/engine/mcp/relay.ts` | changed |  |
| `src/engine/mcp/server.ts` | changed |  |
| `src/engine/mcp/static.ts` | new | the read-only `/preview/` and `/files/<series>/` routes |
| `src/engine/mcp/stdio.ts` | changed |  |
| `src/engine/mcp/tools-client.ts` | changed |  |
| `src/engine/mcp/tools.ts` | changed |  |
| `src/engine/models/anthropic.ts` | unchanged |  |
| `src/engine/models/client.ts` | unchanged |  |
| `src/engine/models/customProviders.ts` | unchanged |  |
| `src/engine/models/gemini.ts` | unchanged |  |
| `src/engine/models/keys.ts` | changed |  |
| `src/engine/models/limiter.ts` | unchanged |  |
| `src/engine/models/mock.ts` | unchanged |  |
| `src/engine/models/openaiCompat.ts` | unchanged |  |
| `src/engine/models/registry.ts` | changed |  |
| `src/engine/models/router.ts` | unchanged |  |
| `src/engine/models/sse.ts` | unchanged |  |
| `src/engine/models/types.ts` | unchanged |  |
| `src/engine/modules.ts` | new | the list of engine modules (job handlers register here) |
| `src/engine/pipeline/llm.ts` | unchanged |  |
| `src/engine/queue/jobs.ts` | unchanged |  |
| `src/engine/queue/scheduler.ts` | changed |  |
| `src/engine/service.ts` | new | replaces `edu/service.ts` (EduService): CtsService with the queue helpers, the generator clients and the series list |
| `src/engine/store/atomic.ts` | unchanged |  |
| `src/engine/store/dataFolder.ts` | changed |  |
| `src/engine/store/lock.ts` | changed |  |
| `src/engine/store/seedMigrations.ts` | changed |  |
| `src/engine/store/seedRefresh.ts` | changed |  |
| `src/engine/store/watcher.ts` | unchanged |  |
| `src/engine/music/chiptune.ts` | new | CTS-06: theme loop (`compose_track` + `render_audio`) and up to 2 effects (`compose_sfx`) as `.ogg` under `series/<slug>/music/` |
| `src/engine/voice/allocate.ts` | changed | CTS-06: Edu `46b6ec1` `src/engine/voice/allocate.ts` with one change: the local chain per language comes from `config/voice.md` `localOrder` (default `hr: [comfy, vibetts]`, `en: [vibetts, comfy]`; Edu always tried VibeTTS first). The allocation types moved here from Edu's `shared/voice.ts` |
| `src/engine/voice/audio.ts` | new | CTS-06: ffprobe length, normalise to 44.1 kHz mono WAV with the edge silence trimmed to 0.15 s, silent placeholder WAV |
| `src/engine/voice/manifest.ts` | new | CTS-06: voice manifest read/write, `clipHash` (Edu's formula over the speaker's whole voice key) |
| `src/engine/voice/providers/comfy.ts` | new | CTS-06: OmniVoice through ComfyUI (the speaker of Edu's `speak.ts` `comfySpeaker`, with OmniVoice tag validation) |
| `src/engine/voice/providers/gemini.ts` | new | CTS-06: ported from Edu's `speak.ts` `geminiSpeaker` (retry and quota handling), writes files instead of bytes |
| `src/engine/voice/providers/paid.ts` | new | CTS-06: the paid slot behind `charge`; throws `NOT_IMPLEMENTED` after the gate |
| `src/engine/voice/providers/types.ts` | new | CTS-06: shared provider shapes |
| `src/engine/voice/providers/vibetts.ts` | new | CTS-06: ported from Edu's `speak.ts` `vibettsSpeaker` and `vibeVoiceFor` |
| `src/engine/voice/quota.ts` | unchanged | CTS-06: Edu `46b6ec1` `src/engine/voice/quota.ts` |
| `src/engine/voice/run.ts` | new | CTS-06: written for lines x languages (Edu's `run.ts` worked on a course asset manifest); `config/voice.md` loader |
| `src/engine/voice/tools.ts` | new | CTS-06: `cts_voice_*` and `cts_music_generate` tools and the `voice` / `music` job handlers |
| `src/engine/studios/autostart.ts` | changed |  |
| `src/engine/studios/chiptune.ts` | changed |  |
| `src/engine/studios/config.ts` | changed |  |
| `src/engine/studios/flow.ts` | changed |  |
| `src/engine/studios/launch.ts` | changed |  |
| `src/engine/studios/mcp-http.ts` | changed |  |
| `src/engine/studios/vibetts.ts` | changed |  |
| `src/engine/summary.ts` | unchanged |  |
| `src/engine/transport.ts` | unchanged |  |
| `src/main/engineClient.ts` | changed |  |
| `src/main/files.ts` | changed |  |
| `src/main/index.ts` | changed |  |
| `src/player/index.html` | new | player stub (CTS-03 fills it) |
| `src/player/main.ts` | changed | player stub (CTS-03 fills it) |
| `src/preload/index.ts` | changed |  |
| `src/renderer/App.tsx` | changed |  |
| `src/renderer/api.ts` | changed |  |
| `src/renderer/env.d.ts` | unchanged |  |
| `src/renderer/hostApi.ts` | changed |  |
| `src/renderer/index.html` | changed |  |
| `src/renderer/lib/mcp.ts` | changed |  |
| `src/renderer/lib/scheme.ts` | changed |  |
| `src/renderer/main.tsx` | changed |  |
| `src/renderer/store/hooks.ts` | changed |  |
| `src/renderer/store/mcp.ts` | unchanged |  |
| `src/renderer/store/series.ts` | new | series state (replaces store/courses.ts) |
| `src/renderer/store/store.ts` | changed |  |
| `src/renderer/styles.css` | changed |  |
| `src/renderer/ui/AgentsPage.tsx` | changed |  |
| `src/renderer/ui/McpSettings.tsx` | changed |  |
| `src/renderer/ui/ModelsPage.tsx` | changed |  |
| `src/renderer/ui/SeriesPage.tsx` | new | the empty Series view (replaces LibraryPage) |
| `src/renderer/ui/SettingsPage.tsx` | changed |  |
| `src/renderer/ui/common.tsx` | changed |  |
| `src/renderer/ui/roles.ts` | changed |  |
| `src/shared/languages.ts` | changed |  |
| `src/shared/md.ts` | unchanged |  |
| `src/shared/media.ts` | changed |  |
| `src/shared/protocol.ts` | changed |  |
| `src/shared/schemas.ts` | changed |  |
| `src/shared/ui-strings.ts` | changed |  |
| `tests/voice-allocate.test.ts` | changed | CTS-06: Edu `46b6ec1` `tests/voice-allocate.test.ts`; hr expectations follow the new default chain, plus the `localOrder` test |
| `tests/engine-lock.test.ts` | changed |  |
| `tests/helpers.ts` | changed |  |
| `tests/main-files.test.ts` | changed |  |
| `tests/mcp-http.test.ts` | changed |  |
| `tests/seed.test.ts` | new |  |
| `tsconfig.json` | unchanged |  |
| `tsconfig.node.json` | changed |  |
| `tsconfig.player.json` | changed |  |
| `tsconfig.web.json` | unchanged |  |
| `vite.engine.config.ts` | unchanged |  |
| `vite.player.config.ts` | changed |  |
| `vitest.config.ts` | changed |  |
| `vitest.e2e.config.ts` | changed |  |
| `yarn.lock` | changed |  |
