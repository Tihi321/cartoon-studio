# Cartoon Studio

A desktop studio that makes **a series of 3D toon cartoons for children aged 4 to 8**. Characters and sets are **data** (JSON specs of simple shapes) that Python scripts build in a headless **Blender 5.2** and render with EEVEE; the cast and the sets are made once and reused, every episode (5 to 10 minutes) has a **Croatian and an English voice track over the same animation**, and the film is **rendered locally to MP4 at no cost**. A team of agent roles (showrunner, writer, character designer, background artist, voice director, composer, child-safety reviewer, frame critic) does the model work, through Claude Code over MCP (the `client` provider) or through local models.

The older **Canvas puppet player** (flat paper-cutout puppets drawn by a headless Chromium) is **legacy and frozen**: it still renders the series made with it (`renderer: "canvas"`, the default of the bible field) and gets no new features. Its authoring path (Z-Image sheets, raster rigs, face patches, pose images, 2D sets) was retired in CTS-28.

**Cars and trains (HUB-31):** a 3D character is a creature or a **vehicle**, a car or a train with no arms and no legs: its eyes are its own front lamps, its mouth is the bumper or buffer-beam slot, it drives or chugs along the roads and tracks of a set (a road-and-rail kit with level crossings), and it acts with its own library (honk, whistle, puff, rev, bounce, lean, point the nose...). See [docs/blender.md](docs/blender.md).

**Voices:** the hub's voice rule picks per language, Croatian first: **ElevenLabs** on its free tier when the free credits allow, then Google's free Gemini voices, then the local voices (OmniVoice through ComfyUI, Kokoro and Supertonic through VibeTTS). ElevenLabs and Gemini are called through `flow-music-mcp` (the hub's cloud speech tool, `flow_narrate`), never from this app. **The ElevenLabs API key is set by the user only**, in the `ELEVENLABS_API_KEY` environment variable or `~/.flow-music-mcp/.env` of flow-music-mcp; no tool sets it and Cartoon Studio never holds it. flow-music-mcp refuses anything past the free quota or on a paid tier, so voices cost $0.

**Requirement for 3D:** Blender 5.2 installed on the machine (not bundled, not downloaded). The default path is `C:/Program Files/Blender Foundation/Blender 5.2/blender.exe`; change it in Settings or `config/blender.md`. Any other major.minor is refused (`E_BLENDER_VERSION`).

**Licences:** the repository is MIT, except the [`blender/`](blender) folder (the scripts that `import bpy`), which is **GPL-3.0-or-later** (see `blender/LICENSE`). The engine starts Blender as a separate program and talks to it through a JSON file and stdout lines. See [docs/blender.md](docs/blender.md).

## Status

Phase 1 (CTS-01..09) is built: the engine, contracts, Canvas player, timeline, render, voices, pipeline and studio UI. Pilots 1 and 2 (cutout puppets) were judged not good by the user on 2026-11-08, so the project moved to 3D (CTS-18..29, see [ROADMAP.md](ROADMAP.md)): a Blender render backend, character and set builders, an acting library (walks with planted feet, gestures, springs), six-viseme lip-sync from text, audio and whisper word times, and a pipeline for `renderer: "blender"` series. The pilot 3 run (Pip and Bruno, 60 s, hr and en) is tracked in the creative hub's `HUB-30` plan. HUB-31 (CTS-30..36) added ElevenLabs voices and vehicle characters (Pip the car and Bruno the train engine, pilot 4). The pipeline order of a 3D series is pitch (skipped when `brief.pitch` is given) -> bible -> `character` -> `sheet_review` (pause) -> `set3d` -> script -> safety -> voice -> music -> clips -> timeline -> assemble -> preview -> frame review -> final render and mix check. Music comes from ComfyUI (ACE-Step) and sits at least 15 dB under the voice by measurement; Flow is used only for the intro and outro videos. See [docs/pipeline.md](docs/pipeline.md).

## What is in the repository

| Path | What |
|---|---|
| `src/engine/` | The headless engine: job queue and scheduler, agents and roles, model providers (`client`, `mock`, OpenAI-compatible for Strata and LM Studio, Anthropic, Gemini), budget, logs, the MCP server, and the clients of the other tools (ComfyUI, flow-music-mcp, VibeTTS). |
| `src/main`, `src/preload`, `src/renderer` | The Electron app: main process, the `window.cartoonstudio` bridge, the React studio UI. |
| `blender/` | The Blender side (GPL-3.0-or-later): `run.py`, `cts_blender/` (character and set builders, the acting library, the assembler, the render, the 5.x API shims) and its tests. |
| `src/player/` | The Canvas puppet player (legacy, frozen), used for `canvas` series. It is served by the engine at `/preview/`. |
| `seed/` | What a new data folder (`~/CartoonStudio`) starts from: `config/*.md` and the eight agents in `agents/`. |
| `docs/` | `blender.md` (the Blender backend), `mcp-guide.md` (the MCP tools), `pipeline.md`, `contracts.md`, `provenance.md` (where the code came from). |
| `scripts/` | Icons, the studio screenshot harness, the package check. |

## Run it

Needs Node 24 and Yarn 4. Under fnm, put the fnm default alias folder on `PATH`.

```
yarn install
yarn typecheck && yarn lint && yarn test     # the fast suite: mock provider, no browser, no Blender, no real app
yarn test:blender                            # the Blender scripts, in Blender's own Python (needs Blender 5.2)
yarn test:e2e                                # a real render: Blender (3D) and headless Chromium (canvas)
yarn build:engine                            # out/engine/index.js and out/player/
node out/engine/index.js --mcp-only          # headless: MCP on http://127.0.0.1:7465/mcp
yarn dev                                     # the desktop app
yarn dist:installer                          # the Windows installer and portable exe in release/
```

Point a scratch run at its own data folder with `CTS_DATA=<dir>`; the default is `~/CartoonStudio`. Connect Claude Code with
`claude mcp add --transport http cartoon-studio http://127.0.0.1:7465/mcp`, then it can take the model calls of the agents (`cts_get_task`, `cts_submit_task`).

Environment: `CTS_DATA`, `CTS_MCP_PORT`, `CTS_MCP_TOKEN`, `CTS_SEED`, `CTS_AUTOSTART` (`0` turns off the auto-start of ComfyUI), `CTS_BLENDER_SCRIPTS` (the folder with `run.py`, for a non-standard layout).

## Cost

The pilot is a **$0** run: the agents use `client/claude-code` or local models, voices come from ElevenLabs' free tier when its credits allow (recorded as `eleven-credits` in `spend.json`, always USD 0), else from the free Gemini quota, else local (OmniVoice through ComfyUI for Croatian, Kokoro for English), characters and sets are built by code, ComfyUI only makes music (and optional concept art), and the render is local Blender plus ffmpeg. `config/budget.md` caps paid spending at 0. Nothing paid is called without a cap you set.

## Origin

The engine core and the Electron shell were copied from [Edu Studio](https://github.com/Tihi321/edu-game-studio) at commit `46b6ec1`; [docs/provenance.md](docs/provenance.md) lists every copied file and what changed.
