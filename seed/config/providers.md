---
kind: providers
providers:
  - id: deepseek
    kind: openai-compat
    base_url: https://api.deepseek.com
    api_key_env: DEEPSEEK_API_KEY
    concurrency: 8
    json_schema: false             # DeepSeek answers response_format json_schema with HTTP 400 ("unavailable now"), checked 2026-10-12
    models:
      - id: deepseek-flash
        family: deepseek
        context: 1000000
        price_in: 0.30
        price_out: 1.20
        price_cached_in: 0.006
        extra_body: { thinking: { type: disabled } }
      - id: deepseek-v4-pro
        family: deepseek
        context: 1000000
        price_in: 1.32
        price_out: 3.96
        price_cached_in: 0.044
        extra_body: null
  - id: openrouter
    kind: openai-compat
    base_url: https://openrouter.ai/api/v1
    api_key_env: OPENROUTER_API_KEY
    concurrency: 4
    rpm: 20                        # OpenRouter's limit for the free models
    rpd: 50                        # free-model requests per day without credits (1000 after buying 10 credits): then the next model
    discover: free                 # adds every model OpenRouter lists at price 0 (the `:free` ones); a paid one goes in the list below
    discover_skip: [content-safety]
    json_schema: false             # not every model there supports response_format; the engine checks and repairs the JSON instead
    models:
      # to verify
      - id: google/gemini-2.5-flash
        family: gemini
        vision: true
        context: 1000000
        price_in: 0.30
        price_out: 2.50
  - id: anthropic
    kind: anthropic
    base_url: https://api.anthropic.com
    api_key_env: ANTHROPIC_API_KEY
    concurrency: 4
    models:
      # to verify
      - id: claude-sonnet-4-5
        family: claude
        vision: true
        context: 200000
        max_output: 16000
        price_in: 3
        price_out: 15
        price_cached_in: 0.30
  - id: gemini
    kind: gemini
    base_url: https://generativelanguage.googleapis.com
    api_key_env: GEMINI_API_KEY
    concurrency: 4
    models:
      # to verify
      - id: gemini-2.5-flash
        family: gemini
        vision: true
        context: 1000000
        price_in: 0.30
        price_out: 2.50
        price_cached_in: 0.03
  - id: lmstudio
    kind: openai-compat
    local: true
    base_url: http://localhost:1234/v1
    concurrency: auto             # the sum of `parallel` over the loaded chat models (lms load --parallel <n>), 1 when none is loaded
    discover: true
    discover_skip: [dflash]       # LM Studio lists these, but they are not models it can load here
    load_models: true             # load a model that isn't loaded yet with lmstudio_parallel, lmstudio_context and lmstudio_ttl_minutes from settings.md
    # For the frame-critic, add a vision model you have in LM Studio (for example a Qwen-VL) with `vision: true`:
    #   - id: qwen2.5-vl-7b-instruct
    #     family: qwen
    #     vision: true
    models:
      - id: ista-daslab-qwen3.8-27b-gsq-rco-unsloth-mtp
        family: qwen
        extra_body: { reasoning_effort: none }
        load_context: 65536
        load_parallel: 2
      - id: nail-qwen3.6-35b-a3b-mtp
        family: qwen
        extra_body: { reasoning_effort: low }
        load_context: 65536
        load_parallel: 2
      - id: poolside/laguna-s-2.1
        family: poolside
        extra_body: { reasoning_effort: none }
      - id: tiel-coder-35b-a3b-mtp
        family: qwen
        extra_body: { reasoning_effort: none }
      - id: gemma-4-e4b-it
        family: gemma
        extra_body: { reasoning_effort: none }
  - id: strata
    kind: openai-compat
    local: true
    base_url: http://127.0.0.1:8080/v1
    api_key_env: STRATA_API_KEY   # optional: only sent if set
    concurrency: auto             # as many as the running Strata serves (its /v1/status)
    discover: true                # ask Strata which model it runs (GET /v1/models, and `model` of /v1/status)
    json_schema: false
    models:                       # the refs roles and settings use; each stands for whatever model Strata has loaded
      - id: default               # thinking off
        loaded: true
        aliases: [qwen3.8-flash-next]
        context: 131072           # used until Strata has answered once
        extra_body: { reasoning_effort: none }
      - id: default-low           # thinking on low, for the checks
        loaded: true
        aliases: [qwen3.8-flash-next-low]
        context: 131072
        extra_body: { reasoning_effort: low }
    profiles:                     # settings per model Strata may run, matched by id prefix; not refs, not in pickers
      - id: qwen3.8-flash-next    # matches qwen3.8-flash-next-unsloth-ud-iq4_xs and any other Qwen3.8-Flash-Next quant
        family: qwen
        context: 131072
      - id: deepseek-v4.1-flash
        family: deepseek
        context: 131072
  - id: ollama
    kind: openai-compat
    enabled: false
    local: true
    base_url: http://localhost:11434/v1
    concurrency: 1
    discover: true
    models: []
  # The ACP proxy (api-acp-proxy: Antigravity, Codex and Claude through ACP) as an OpenAI-style server. Off until you start the proxy and switch it on.
  # Text only.
  - id: acp
    kind: openai-compat
    enabled: false
    local: true
    base_url: http://127.0.0.1:7461/v1
    concurrency: 2
    json_schema: false
    discover: true
    models: []
  # Model work done by an MCP client (Claude Code). It is on, and the roles in config/roles.md start with it
  # (client/claude-code, or `model:` in agents/<agent>.md). See the "Client" section below.
  - id: client
    kind: client
    local: true
    concurrency: 8                # how many jobs may wait for the client at once
    models:
      - id: claude-code
        vision: true              # the frame-critic sends images
        context: 200000
      - id: antigravity           # Antigravity CLI takes these with cts_get_task {client: "antigravity"}
        vision: true
        context: 1000000
# ComfyUI image generation (not a chat model): which model makes the pictures. Read by the image provider (CTS-08).
comfy:
  imageModel: z-image-turbo     # about 26 s per character reference and 39 s per background in the bake-off
  alternatives: [krea2-turbo]   # the configured alternative; Qwen-Image 2.1 was slower
---
# Providers

One entry per provider. Edit this file and the engine picks the change up without a restart. API keys are never written here: `api_key_env` names an environment variable, and the engine also looks in the Windows credential store (set one with `yarn key:set <NAME>`).

The paid providers (DeepSeek, OpenRouter, Anthropic, Gemini) are listed so the Models page can use them, but **no role in `config/roles.md` names one** and `config/budget.md` caps them at 0. Local models (Strata, LM Studio) and the client provider (Claude Code) cost nothing.

## Fields of a provider

- `id`: the name used in model references. A model is written `provider/model`, for example `lmstudio/gemma-4-e4b-it`.
- `kind`: `openai-compat` (any OpenAI-style API), `anthropic`, `gemini`, `client` (an MCP client answers, see below).
- `enabled`: `false` switches the provider off. A provider whose key can't be found is skipped automatically.
- `name`: the name shown in the app (the id when missing). `custom`: `true` for a provider added in the app's **Models** page.
- `local`: `true` for models on this machine. Local models cost nothing and never count against the caps.
- `base_url`, `api_key_env`: where to call and which variable holds the key.
- `concurrency`: how many requests may run at once. `auto`: as many as the server says it serves at once, asked at start and every 10 seconds.
- `rpm`, `rpd`: optional requests per minute and per day (from midnight UTC).
- `discover`: ask the provider for its models (`GET /v1/models`) and add the ones not listed here. `discover_skip` leaves out models whose id contains one of its words.
- `json_schema`: `true` (the default) sends the JSON schema of a structured answer as `response_format`. Set `false` for a server that answers a bad JSON reply with an error.
- `loaded`, `aliases` (on a model), `profiles` (on the provider): for a server that runs one model at a time (Strata).
- `price_in`, `price_out`, `price_cached_in` (on a model): USD per 1M tokens. `vision: true` marks a model that accepts images (the frame-critic needs one).

## Client (Claude Code does the model work)

`kind: client` has no server and no key: a request waits in the engine's in-memory client task queue until an MCP client takes it (`cts_get_task`) and answers (`cts_submit_task`). It is `local: true`, so it costs nothing here. Each model is a named client: a task made for `client/antigravity` is only handed to a client that asks for `antigravity`; `cts_get_task` without `client` takes the `claude-code` ones. The queue is lost when the engine restarts: the running job is asked again.

## Strata

Strata is a fast local server with an OpenAI-style API on port 8080. Cartoon Studio only connects to it, you start it. `strata/default` stands for whatever model Strata has loaded (thinking off), `strata/default-low` the same with thinking on low. No key is needed.

## ComfyUI image model

`comfy.imageModel` above is the model ComfyUI uses for pictures. `z-image-turbo` is the default; `krea2-turbo` is the listed alternative. Z-Image draws a white sticker halo round the figure; that is harmless where the picture is only a reference to redraw, and the colour key removes it where the picture is cut into parts.
