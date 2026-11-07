# Cartoon Studio MCP guide

Cartoon Studio makes a series of cutout-puppet cartoons for children aged 4 to 8: the cast, the rigs and the sets are made once and reused, each episode has a Croatian and an English voice track over the same animation, and the base animation is rendered locally to MP4. This server lets an agent such as Claude Code drive the studio: see the series and the job queue, and do the model work of the jobs itself, at no cost.

**Status: CTS-01 (the scaffold).** Only the generic tools below exist. The tools for the series, rigs, sets, voices, render and the pipeline are added by the later tickets (see `ROADMAP.md`); each one adds its tools to this guide.

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
| `cts_image_generate {series, episode, provider?, prompt, width?, height?, format?, out?, refs?, styleId?, model?, seed?}` | `comfy` (default, also `auto`): local, free; `refs` makes it an edit (Qwen). `flow`: free Google Flow image (`max_credits: 0`, never video). `fal`, `recraft`: paid, charged to the episode budget; `recraft` with `format: "svg"` returns a vector. |
| `cts_svg_split {series, svg, outDir, mode: parts or grid, parts?, cols?, rows?, ids?}` | Splits an SVG into one file per part (polygons in viewBox coordinates, same viewBox) or cuts a sheet into grid cells. |

Every paid call goes through `charge` (`src/engine/budget/spend.ts`): the price estimate (from `config/prices.md`, unverified, check before use) is checked against the cap BEFORE the call (`BUDGET_EXCEEDED` for dollars, `FLOW_CREDITS_EXCEEDED` for Flow credits) and the real cost is appended to `spend.json` afterwards. A series-level spend (the series intro clip, a Recraft style) is charged to the episode that triggers it. Keys for `fal` and `recraft` are read only from this tool's credential store: a missing one is `KEY_MISSING <provider>`; store it with `node out/engine/index.js key-set fal` (or `recraft`).
