---
kind: autostart
# Start Chiptune Studio and ComfyUI by itself when a job needs one and it does not answer. The job waits, then goes on.
enabled: true
# The creative hub's service list: it has the start command, port and health URL of each tool.
registry: ../creative-hub/services.json
# Which of the two may be started (this list can only narrow them).
services: [chiptune-studio, comfyui]
# Seconds to wait for a started service to answer. 0: the registry's startTimeout (ComfyUI 240), else 60.
startTimeoutS: 0
# Stop the services Cartoon Studio started when the engine stops. false: they stay up for the next job.
stopOnExit: false
---
# Auto-start

When a job calls Chiptune Studio or ComfyUI and nothing answers, Cartoon Studio starts it from the hub's `services.json`, waits until it answers (checked every half second), and retries the call once.

- `enabled`: `false` turns it off. `CTS_AUTOSTART=0` in the environment turns it off too (the tests do this).
- `registry`: the path of `services.json`. Missing or unreadable: auto-start is off, and the engine log says so once.
- `services`: a subset of `chiptune-studio`, `comfyui`.
- `startTimeoutS`, `stopOnExit`: see above. With `stopOnExit` only what this engine run started is stopped.

What is never started: Scriptorium, Strata (it uses most of the GPU), LM Studio, VibeTTS (a tray app) and anything that is not on this machine. A service the registry marks `managed: false` or with a `warning` is not started. A failed start is not tried again for 5 minutes. Status checks (`cts_studios_status`) never start anything.
