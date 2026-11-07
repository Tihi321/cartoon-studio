# Cartoon Studio

A desktop studio that makes **a series of cutout-puppet cartoons for children aged 4 to 8**, in the flat, paper-cutout style of South Park. The cast, the rigs and the sets are made once and reused; every episode (5 to 10 minutes) has a **Croatian and an English voice track over the same animation**, and the base animation is **rendered locally to MP4 at no cost**. A team of agent roles (showrunner, writer, character designer, background artist, voice director, composer, child-safety reviewer, frame critic) does the model work, through Claude Code over MCP (the `client` provider) or through local models.

License: MIT.

## Status

Phase 1 is being built ticket by ticket (see [ROADMAP.md](ROADMAP.md)): the scaffold and engine core (CTS-01), then the data contracts, the Canvas player, the timeline, the render, the voices, the pipeline and the studio UI, ending in a 60-second pilot episode. What exists after CTS-01 is the engine core, the MCP server with ten `cts_` tools, the Electron shell with an empty "Series" view, the seed configuration and the build. There is no cartoon yet.

## What is in the repository

| Path | What |
|---|---|
| `src/engine/` | The headless engine: job queue and scheduler, agents and roles, model providers (`client`, `mock`, OpenAI-compatible for Strata and LM Studio, Anthropic, Gemini), budget, logs, the MCP server, and the clients of the other tools (ComfyUI, Chiptune Studio, flow-music-mcp, VibeTTS). |
| `src/main`, `src/preload`, `src/renderer` | The Electron app: main process, the `window.cartoonstudio` bridge, the React studio UI. |
| `src/player/` | The Canvas puppet player (a stub until CTS-03). It is served by the engine at `/preview/`. |
| `seed/` | What a new data folder (`~/CartoonStudio`) starts from: `config/*.md` and the eight agents in `agents/`. |
| `docs/` | `mcp-guide.md` (the MCP tools), `provenance.md` (where the code came from). |
| `scripts/` | Icons, the studio screenshot harness, the package check. |

## Run it

Needs Node 24 and Yarn 4. Under fnm, put the fnm default alias folder on `PATH`.

```
yarn install
yarn typecheck && yarn lint && yarn test     # the fast suite: mock provider, no browser, no real app
yarn build:engine                            # out/engine/index.js and out/player/
node out/engine/index.js --mcp-only          # headless: MCP on http://127.0.0.1:7465/mcp
yarn dev                                     # the desktop app
yarn dist:installer                          # the Windows installer and portable exe in release/
```

Point a scratch run at its own data folder with `CTS_DATA=<dir>`; the default is `~/CartoonStudio`. Connect Claude Code with
`claude mcp add --transport http cartoon-studio http://127.0.0.1:7465/mcp`, then it can take the model calls of the agents (`cts_get_task`, `cts_submit_task`).

Environment: `CTS_DATA`, `CTS_MCP_PORT`, `CTS_MCP_TOKEN`, `CTS_SEED`, `CTS_AUTOSTART` (`0` turns off the auto-start of ComfyUI and Chiptune Studio).

## Cost

The pilot is a **$0** run: the agents use `client/claude-code` or local models, voices are local (OmniVoice through ComfyUI for Croatian, Kokoro for English) unless the free Gemini quota fits, images come from local ComfyUI, and the render is local ffmpeg. `config/budget.md` caps paid spending at 0. Nothing paid is called without a cap you set.

## Origin

The engine core and the Electron shell were copied from [Edu Studio](https://github.com/Tihi321/edu-game-studio) at commit `46b6ec1`; [docs/provenance.md](docs/provenance.md) lists every copied file and what changed.
