---
kind: prices
# Check before use: these prices were NOT verified against the vendors' pages. Last read 2026-11-07 (from memory and a secondary source).
# Before a production gets a budget (cts_budget_set), read the vendors' current price pages and correct this file.
checked: "check before use; last read 2026-11-07; unverified"
# USD per image. `model` is the fal.ai endpoint id (provider fal). `format` is what the call returns.
images:
  - { provider: fal, model: fal-ai/flux-2-pro, format: png, usd: 0.03, note: "FLUX 2 Pro; fal bills per megapixel, this is about 1 MP; unverified" }
  - { provider: fal, model: fal-ai/flux/schnell, format: png, usd: 0.003, note: "FLUX Schnell, per megapixel; unverified" }
  - { provider: fal, model: fal-ai/stable-diffusion-v35-large, format: png, usd: 0.065, note: "SD3.5 Large; unverified" }
---
# Prices

Every paid image call asks this file for its estimate before it runs; `cts_budget_set` caps what a production may spend, and a call whose estimate would cross the cap is refused (`BUDGET_EXCEEDED`). With no `budget.json` the cap is 0, so nothing paid runs without the user's yes.

- **Check before use.** Nothing here is verified. A wrong low price lets a production overspend its cap by the difference; the ledger (`spend.json`) records the estimate unless the API reports a cost.
- A model that is not listed has no price, and the call is refused with `PRICE_UNKNOWN`.
- ComfyUI images cost nothing and are not listed. Google Flow makes no images (video only, charged in credits).
