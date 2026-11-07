---
kind: settings
fallbacks:
  - client/claude-code
  - strata/default
  - lmstudio/gemma-4-e4b-it
fallback_shared: false
lmstudio_parallel: 4
lmstudio_context: 131072
lmstudio_ttl_minutes: 60
---
# Settings

## Default models

`fallbacks` is the list of models the pipeline falls back through, first row first. It can have any length, and a kind may repeat. Each row is one `provider/model`. Its **kind** comes from the model's provider, so a row can't disagree with its model: an API provider (free or paid) is `paid`, any other provider is named by its id (`strata`, `lmstudio`, `client` ...). Edit the list here or on the app's Models page. A change applies at once, to running jobs too.

The role lists in `roles.md` and an agent's `model` can name a kind instead of a model: `paid` is the first API row, `strata` the first Strata row, `lmstudio-2` the second LM Studio row, `client` the first client row. A name with no matching row is skipped (the engine logs it once). An agent's own model, picked in the app, still goes first.

- `fallbacks`: the rows. At least one. This repo seeds no paid row.
- `fallback_shared`: `true` gives every role the rows top to bottom. `false` keeps each role's own order from `roles.md`, and the rows only say what `paid`, `strata`, `lmstudio` ... stand for.

## LM Studio loading

When a request goes to an LM Studio model that isn't loaded, the engine loads it first with these settings (also in the app's Models panel, under lmstudio). A model that is already loaded is used as it is.

- `lmstudio_parallel`: how many requests the model serves at once (`--parallel`). 1 means one at a time.
- `lmstudio_context`: the context window (`-c`). The parallel requests share it.
- `lmstudio_ttl_minutes`: LM Studio unloads the model after this many idle minutes (`--ttl`).
