import { describe, expect, it } from "vitest";
import {
  assertContextPolicy,
  ContextPolicyError,
  MAX_CONTEXT_MESSAGES,
  type TranslationRequest,
} from "../src/types.js";

const req = (over: Partial<TranslationRequest>): TranslationRequest => ({
  text: "sí, ese",
  source: "es",
  target: "en",
  initiation: "automatic",
  ...over,
});

/**
 * PLAN.md §5.1 and §12: "Context window size 0 on every automatic-path request
 * — asserted in a test, because §5.1 is a rule and rules need enforcement."
 *
 * The rule needs enforcing precisely because nothing else pushes back on
 * breaking it: DeepL's `context` parameter is unbilled, so enabling context for
 * every automatically translated message is free. Only this test costs anything.
 */
describe("context policy (§5.1)", () => {
  it("allows an automatic request with no context", () => {
    expect(() => assertContextPolicy(req({}))).not.toThrow();
    expect(() => assertContextPolicy(req({ contextWindow: [] }))).not.toThrow();
  });

  it("rejects any context on the automatic path", () => {
    expect(() => assertContextPolicy(req({ contextWindow: ["¿vienes?"] }))).toThrow(
      ContextPolicyError,
    );
  });

  it("allows bounded context on a user-initiated request", () => {
    const window = Array.from({ length: MAX_CONTEXT_MESSAGES }, (_, i) => `msg ${i}`);
    expect(() =>
      assertContextPolicy(req({ initiation: "user", contextWindow: window })),
    ).not.toThrow();
  });

  it("hard-bounds the context window even when user-initiated", () => {
    const window = Array.from({ length: MAX_CONTEXT_MESSAGES + 1 }, (_, i) => `msg ${i}`);
    expect(() => assertContextPolicy(req({ initiation: "user", contextWindow: window }))).toThrow(
      /hard-bounded/,
    );
  });
});
