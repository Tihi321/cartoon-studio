# Rules for agents working in this repository

Cartoon Studio makes a series of cutout-puppet cartoons for children (Croatian and English tracks, local MP4 render). Read `README.md` for what it is, `ROADMAP.md` for what is done and what comes next, and `docs/provenance.md` for where the copied engine code came from. The big plan is `HUB-29` in the creative hub (`../creative-hub`); this repo only holds its own tickets.

## Stack and commands

Electron 44, electron-vite, React 19, zustand, TypeScript strict, zod 4, Vitest, ESLint flat config, Yarn 4 (`nodeLinker: node-modules`), Node 24.

- Node is managed by fnm. If `node` or `yarn` is not on `PATH`, run `fnm exec --using default <command>`; `fnm exec yarn` can fail, so put the fnm default alias folder on `PATH` and run `yarn <script>`. Do not leave a test unrun because Node was missing.
- Check your work with `yarn typecheck`, `yarn lint` and `yarn test` (the fast suite, no Chromium). A test that needs a browser goes in a `*.e2e.test.ts` file and runs in `yarn test:e2e` (it fails, not skips, without a browser). `yarn build` must keep working.
- `yarn build:engine && node out/engine/index.js --mcp-only` starts the headless MCP server (port 7465). Point it at a scratch data folder (`CTS_DATA=.claude/temp/<name>`), never at `~/CartoonStudio`.

## Work in tickets

- A ticket is `CTS-NN`, with its plan in `.claude/tickets/CTS-NN-<name>/plan.md` (changelog and notes next to it). New work gets the next free number and a row in `ROADMAP.md`.
- A branch is `CTS-NN_<what>`. One commit per ticket. Do not commit or push unless asked.
- Put every scratch, staging and intermediate file under `.claude/temp/` (it is ignored by git). Durable notes go in the ticket folder.
- Record what was verified and what was not. End a run with each requested item marked DONE, NOT DONE (with the reason) or UNTESTED (not run in the real app).

## Rules

- **The repository is public.** No keys, tokens, e-mail addresses, personal data, `~/CartoonStudio` content or Windows user-profile paths in any committed file. Sibling tools are found by relative paths (`../creative-hub`). Before a push run the A3 grep of the HUB-29 plan (`git grep` for a user-profile path prefix, the user name, an API-key prefix such as the OpenAI or Google ones): it must print nothing.
- **Our own renderer.** The player is our own Canvas 2D runtime; the render is headless Chromium plus ffmpeg. Do not add a game-engine or animation library.
- **Every interactive element has a `data-testid`**, in the studio UI and in the player, so Playwright can drive it.
- **No "director" behaviour.** An agent working on a ticket does the assigned work directly: it does not re-plan an approved ticket, take over another agent's files or act as an orchestrator. (The product's own `showrunner` role is a different thing.)
- Tools are named `cts_*`, the preload bridge is `window.cartoonstudio`, the file protocol is `cartoonstudio-file://`, the MCP port is 7465 (`CTS_MCP_PORT`, `CTS_MCP_TOKEN`), the data folder is `~/CartoonStudio` (`CTS_DATA`, `--data`; `CTS_SEED` for the seed; `CTS_AUTOSTART=0` turns off the auto-start of other tools).
- A new MCP tool is a `def(name, description, zod schema, run)` entry in a tool module: a function `(svc, def, opts) => Tool[]` added to `TOOL_MODULES` in `src/engine/mcp/modules.ts`. Add it to `docs/mcp-guide.md` too.
- A job handler is registered with `engine.queue.register(task, handler)` from an engine module added to `ENGINE_MODULES` in `src/engine/modules.ts`. The service (`engine.cts`, `src/engine/service.ts`) gives modules the generator clients (`cts.comfy()`, `cts.studios()`).
- All text a viewer sees lives in the text catalog (`text/<lang>.json`) or the bible's `{hr, en}` maps, never in the script, so a language can be added without touching the animation.
- Keep the copied engine code as it is unless a ticket needs a change; say in the changelog when you change it, and keep `docs/provenance.md` true.
- Tests use the `mock` provider and fakes for ComfyUI and the studios; no test may start a real app (`CTS_AUTOSTART=0` is set for the test run), call a paid service or spend money. Write only the most important tests; no near-duplicates.
