---
kind: roles
roles:
  showrunner:
    models: [client/claude-code, strata, lmstudio]
  writer:
    models: [client/claude-code, strata, lmstudio]
  character-designer:
    models: [client/claude-code, strata, lmstudio]
  background-artist:
    models: [client/claude-code, strata, lmstudio]
  voice-director:
    models: [client/claude-code, strata, lmstudio]
  composer:
    models: [client/claude-code, strata, lmstudio]
  child-safety-reviewer:
    models: [client/claude-code, strata, lmstudio]
  frame-critic:
    models: [client/claude-code, strata, lmstudio]
---
# Roles

The default models for each role, as an ordered list of `provider/model` or an alias. The first model is the default. If it fails or is not available, the next one is tried. An agent's own `model` (in `agents/`) wins over this list.

Every role starts on `client/claude-code`: the model call waits in the engine's client task queue until Claude Code (or any MCP client) takes it with `cts_get_task` and answers with `cts_submit_task`. That costs nothing here. `strata` and `lmstudio` are the local fallbacks (the aliases stand for the first row of that kind in `config/settings.md`). **No role names a paid model.** A role left on `client` with nobody answering stalls every job of that role: put the roles on a local model when Claude Code is not working on the run.

The Cartoon Studio team:
- `showrunner`: pitches three series premises with two leads each, keeps the series bible (tone, rules, cast, sets) and the episode plan, and writes the run summary.
- `writer`: writes the episode script (beats with line ids, language-independent) and the text of each language.
- `character-designer`: draws the rig parts of a character from its reference image (shapes, outline, palette, pivots) and the face set (3 eye states, 4 brows, 8 mouths).
- `background-artist`: plans and checks the sets (background layers, marks, camera shots).
- `voice-director`: gives each character a voice per language (Gemini voice, OmniVoice attribute tags, VibeTTS voice) and the delivery of each line.
- `composer`: plans the theme and the stings for Chiptune Studio.
- `child-safety-reviewer`: reads the script and the text for children aged 4 to 8. Must pass before a render.
- `frame-critic`: looks at contact sheets and pose sheets (it needs a model that takes images) and says what is off model.
