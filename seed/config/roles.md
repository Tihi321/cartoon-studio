---
kind: roles
roles:
  showrunner:
    models: [client/claude-code, acp]
  writer:
    models: [client/claude-code, acp]
  character-designer:
    models: [client/claude-code, acp]
  background-artist:
    models: [client/claude-code, acp]
  voice-director:
    models: [client/claude-code, acp]
  composer:
    models: [client/claude-code, acp]
  child-safety-reviewer:
    models: [client/claude-code, acp]
  frame-critic:
    models: [client/claude-code, lmstudio]
---
# Roles

The default models for each role, as an ordered list of `provider/model` or an alias. The first model is the default. If it fails or is not available, the next one is tried. An agent's own `model` (in `agents/`) wins over this list.

Every role starts on `client/claude-code`: the model call waits in the engine's client task queue until Claude Code (or any MCP client) takes it with `cts_get_task` and answers with `cts_submit_task`. That costs nothing here. `acp` (the local model through the ACP proxy) is the fallback; `lmstudio` only for the frame-critic's vision (the aliases stand for the first row of that kind in `config/settings.md`). **No role names a paid model.** A role left on `client` with nobody answering stalls every job of that role: put the roles on a local model when Claude Code is not working on the run.

The Cartoon Studio team:
- `showrunner`: pitches three series premises with two leads each, keeps the series bible (tone, rules, cast, sets) and the episode plan, and writes the run summary.
- `writer`: writes the episode script (beats with line ids, language-independent) and the text of each language.
- `character-designer`: writes each character as a 3D toon spec (simple rounded shapes on named controls, a face, a motion profile; a vehicle gets lamp eyes) that Blender builds into a turnaround sheet for the user to approve. Only in an old canvas series: an image prompt and a body plan, the master, rig parts (polygons, pivots, face boxes) and the face set.
- `background-artist`: plans and checks the sets (background layers, marks, camera shots).
- `voice-director`: gives each character a voice per language (an ElevenLabs voice first, then a Gemini voice, OmniVoice attribute tags and a VibeTTS voice for the fallbacks) and the delivery of each line.
- `composer`: plans the theme and up to two sound effects for ComfyUI's music model (tags, tempo, key, seed).
- `child-safety-reviewer`: reads the script and the text for children aged 4 to 8. Must pass before a render.
- `frame-critic`: looks at contact sheets and pose sheets (it needs a model that takes images) and says what is off model.
