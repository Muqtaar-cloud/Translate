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

The extension is deliberately **not** built yet. The plan says nothing starts
until the gate passes, and that applies to the person who wrote it.

```bash
npm install
npm test        # 63 tests
npm run typecheck
```

## What still needs a human

Everything genuinely unresolved sits behind work that can't be done from a
repository: a real Chrome profile with the built-in AI components, chat data
from real channels, and two bilingual raters. The best available outcome is
that the bake-off comes back and invalidates a chunk of the plan.
