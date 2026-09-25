# Polyglot

[![CI](https://github.com/Muqtaar-cloud/Translate/actions/workflows/ci.yml/badge.svg)](https://github.com/Muqtaar-cloud/Translate/actions/workflows/ci.yml)

In-place translation for multilingual group chats — read Discord in your
language without leaving the conversation.

Translations render *underneath* the original message, never replacing it.
On-device translation by default, so no message content leaves the machine on
the automatic path. Cloud engines are opt-in with your own API keys, and LLM
translation happens only when you ask for it, per message.

## Status

Phase 0. The plan ([docs/PLAN.md](docs/PLAN.md)) gates everything on a
translation-quality bake-off, and the harness for it is built:

- **`packages/core`** — routing, two-tier cache keys, DNT masking, detection
  and the context-policy guard. Pure logic, no browser, fully tested.
- **`tools/bakeoff`** — the Phase 0b gate: capability probe, four engines,
  blinded rating sheets, Wilson intervals and a coarse verdict.
  ([how to run it](tools/bakeoff/README.md))
- **`apps/extension`** — Phases 1–2: the Discord adapter, render loop,
  translation layer, per-pair language-pack UX, viewport gating, batching, a
  two-level cache, per-channel settings, the LLM escalation button and the
  outbound compose-and-review panel. ([how to run it](apps/extension/README.md))
- **`apps/bot`** — Phase 3: a Telegram bot that translates on request, with
  demand gating in place of viewport gating and self-hosted MT in place of an
  on-device one. ([how to run it](apps/bot/README.md))

The quality gate still hasn't run — it needs real chat data and bilingual
raters. Phase 1 was built ahead of it by explicit decision; if the gate comes
back bad, this code is a sunk cost and the plan says so.

```bash
npm install
npm test          # 268 tests
npm run typecheck
npm run build:ext # -> apps/extension/dist, load unpacked in Chrome
npm run smoke     # loads it into real Chromium against a fake Discord page
```

CI runs the typecheck and unit suite on every push and pull request, then
builds the extension and runs the browser smoke test. Requires Node 22.5+ —
`apps/bot` uses `node:sqlite`, which has no driver fallback.

## What still needs a human

Everything genuinely unresolved sits behind work that can't be done from a
repository: a real Chrome profile with the built-in AI components, chat data
from real channels, and two bilingual raters. The best available outcome is
that the bake-off comes back and invalidates a chunk of the plan.
