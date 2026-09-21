import { MAX_CONTEXT_MESSAGES, assertContextPolicy, type TranslationRequest } from "@polyglot/core";
import type { ExtractedMessage, PlatformAdapter } from "./adapter.js";

/**
 * LLM escalation: the "translate properly" action (PLAN.md §4.3, §5.1).
 *
 * The LLM is never on the automatic path. Routing short, slangy, emoji-dense
 * messages to an LLM would have made the escape hatch the default — chat *is*
 * short and slangy — which would have broken the cost claim, the latency budget
 * and the cache all at once. So it is a per-message user action, taken when the
 * cheap path produced something visibly mangled.
 *
 * That decision is what makes the privacy bound in §5.1 true. Thread context is
 * permitted only here, on a path the user chose, for a message they picked. The
 * automatic path carries no context at all, and `assertContextPolicy` enforces
 * it rather than trusting callers.
 */

/**
 * Collects the messages immediately before `id`, oldest first.
 *
 * Hard-bounded, and deliberately text-only: no author names, no timestamps, no
 * media, no ids. What leaves the machine on an escalation is N lines of chat
 * and nothing that identifies who wrote them.
 */
export function collectContext(
  adapter: PlatformAdapter,
  root: Element,
  id: string,
  limit = MAX_CONTEXT_MESSAGES,
): string[] {
  const preceding: string[] = [];

  for (const el of adapter.findMessages(root)) {
    const extracted = adapter.extract(el);
    if (!extracted) continue;
    if (extracted.id === id) break;
    preceding.push(extracted.text);
  }

  return preceding.slice(-limit);
}

export interface EscalationRequest {
  text: string;
  source: string;
  target: string;
  context: string[];
}

/**
 * Builds the request and checks it against the context policy.
 *
 * Throws rather than silently dropping context: a violation here means the
 * escalation path has been wired to something automatic, which is exactly the
 * drift §5.1 exists to catch.
 */
export function buildEscalation(
  extracted: Pick<ExtractedMessage, "text">,
  source: string,
  target: string,
  context: string[],
): TranslationRequest {
  const request: TranslationRequest = {
    text: extracted.text,
    source,
    target,
    initiation: "user",
    contextWindow: context.slice(-MAX_CONTEXT_MESSAGES),
  };
  assertContextPolicy(request);
  return request;
}
