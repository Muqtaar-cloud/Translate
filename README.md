# Polyglot

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
- **`apps/extension`** — Phase 1: the Discord adapter, render loop, translation
  layer and per-pair language-pack UX. ([how to run it](apps/extension/README.md))

The quality gate still hasn't run — it needs real chat data and bilingual
raters. Phase 1 was built ahead of it by explicit decision; if the gate comes
back bad, this code is a sunk cost and the plan says so.

```bash
npm install
npm test          # 98 tests
npm run typecheck
npm run build:ext # -> apps/extension/dist, load unpacked in Chrome
npm run smoke     # loads it into real Chromium against a fake Discord page
```

## What still needs a human

Everything genuinely unresolved sits behind work that can't be done from a
repository: a real Chrome profile with the built-in AI components, chat data
from real channels, and two bilingual raters. The best available outcome is
that the bake-off comes back and invalidates a chunk of the plan.
