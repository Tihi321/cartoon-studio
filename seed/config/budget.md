---
kind: budget
monthly_cap_usd: 0
daily_cap_usd: 0
per_book_cap_usd: null
warn_at: 0.8
# Paid voice providers: the most one production may spend on them (USD). 0: no paid voice call is made.
voice:
  paidMaxUsd: 0
---
# Budget

Spending caps in USD. Edit the numbers above and the engine picks them up without a restart.

- `monthly_cap_usd`, `daily_cap_usd`: day and month follow this machine's local clock. They are `0` here: nothing paid runs until you raise them (a production's own cap, with Flow credits, comes with CTS-08).
- `per_book_cap_usd`: optional cap for one series. `null` means no cap.
- `warn_at`: a warning is shown when spend reaches this fraction of a cap.
- `voice.paidMaxUsd`: the most a production may spend on paid voice providers. `0`: none. No paid voice client exists yet; this is the gate it will go through.

Before each paid request the engine reserves an estimated maximum cost and refuses to start it if that would cross a cap. Local models cost nothing: their tokens and time are recorded, but they never count against a cap.

The engine rewrites everything below the marker line. Keep your own text above it.
