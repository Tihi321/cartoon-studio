---
kind: studios
# Chiptune Studio (music): the user's own app. It runs an MCP server.
# Start it without a window: `cd <repo> && yarn build && yarn mcp` (or `<exe> --mcp-only`).
chiptuneStudioUrl: http://127.0.0.1:7458/mcp
# Where the code is: used for the start hints.
chiptuneStudioRepo: ../midi-generator
# A packaged app to launch instead of `yarn electron .` in the repo. Empty: use the repo.
chiptuneStudioExe: ''
# Bearer token, only when the app's MCP server asks for one. The environment variable CHIPTUNE_STUDIO_MCP_TOKEN and the credential store win over this field.
chiptuneStudioToken: ''
# flow-music-mcp: Google Flow images (free), narration voices (free Gemini) and, later, video clips (SPEND CREDITS, always under a cap).
# Start it: hub.ps1 start flow-music-mcp. Sign in once: yarn login in the repo.
flowUrl: http://127.0.0.1:7462/mcp
flowRepo: ../flow-music-mcp
# The bearer token of its MCP server; the environment variable FLOW_MUSIC_MCP_TOKEN and the credential store win over this field.
flowToken: ''
# VibeTTS (local text-to-speech: Kokoro, Supertonic, Higgs): a tray app with an MCP server. Cartoon Studio NEVER starts it: start it yourself and turn its MCP server on.
# It speaks the English lines (Kokoro) and is the Croatian fallback (Supertonic) when the hub's voice rule sends a language local (config/voice.md).
vibettsUrl: http://127.0.0.1:7723/mcp
# The bearer token of its MCP server, only when it asks for one; the environment variable VIBETTS_MCP_TOKEN and the credential store win over this field.
vibettsToken: ''
# Seconds per wait call (at most 50), and when to give up on one image job.
flowPollS: 40
flowJobTimeoutS: 900
# Voices: pause between two narration calls (ms) and retries of a clip on a rate limit (waits 10 s, 30 s, 90 s).
flowVoicePauseMs: 1500
flowVoiceRetries: 3
# Timeouts in seconds: short calls, an import and export, a track render.
timeoutS: 15
importTimeoutS: 120
renderTimeoutS: 300
---
# Studios

Where the other tools of the creative hub are. Each is an MCP server on 127.0.0.1.

- **Chiptune Studio** makes the theme and the stings of a series.
- **flow-music-mcp** reaches Google Flow: free images, free Gemini narration voices, and (only under a credit cap) video clips.
- **VibeTTS** is the local voice app. Cartoon Studio never starts it.
- ComfyUI uses the lane http://127.0.0.1:8188 unless an optional `config/comfy.md` lists others, and is started by `config/autostart.md` when a job needs it.

`cts_studios_status` checks all four and says how to start one that is down.
