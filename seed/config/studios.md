---
kind: studios
# flow-music-mcp: narration voices (free Gemini) and the intro and outro video clips (SPEND CREDITS, always under a cap). No images go through Flow.
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

- **flow-music-mcp** reaches Google Flow: free Gemini narration voices and (only under a credit cap) the intro and outro video clips. It makes no images.
- **VibeTTS** is the local voice app. Cartoon Studio never starts it.
- ComfyUI makes the images (Z-Image), the series music (ACE-Step) and the Croatian voice. It uses the lane http://127.0.0.1:8188 unless an optional `config/comfy.md` lists others, and is started by `config/autostart.md` when a job needs it.

`cts_studios_status` checks all three and says how to start one that is down.
