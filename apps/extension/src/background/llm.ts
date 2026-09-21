import { assertContextPolicy, type TranslationRequest } from "@polyglot/core";

/**
 * The LLM escalation, worker side (PLAN.md §4.3, §5.1).
 *
 * Reached only from a click in a message's layer. Nothing automatic routes
 * here, and the guard below is the last place that can be checked before
 * content leaves the machine — so it is checked here too, not only in the
 * content script. A bug that made this automatic would otherwise start sending
 * the preceding few messages off-device on every translation.
 *
 * ---
 *
 * **Raw HTTP rather than the official SDK, on evidence.**
 *
 * `@anthropic-ai/sdk` bundles cleanly into the MV3 service worker and then
 * breaks it at runtime: with the SDK imported the worker's module body never
 * completes, so `chrome.runtime.onMessage` is never registered and every
 * message — including every cache lookup — silently degrades. Measured with
 * the readiness marker in `index.ts`:
 *
 *   with the SDK:     511 kB bundle, worker alive = false
 *   without the SDK:   8.4 kB bundle, worker alive = true
 *
 * The SDK is the right default everywhere it runs. It does not run here, and
 * shipping a dead service worker to honour a default would be worse than the
 * fifty lines below. The bundle size matters independently: this worker is woken
 * by every cache lookup, so a 511 kB parse on each cold start would tax the
 * exact path the cache exists to make fast.
 */

export const MODEL = "claude-opus-5";
const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  error?: { message?: string };
}

function prompt(request: TranslationRequest): string {
  const context = request.contextWindow?.length
    ? `Preceding messages in the channel, oldest first:\n${request.contextWindow
        .map((c) => `- ${c}`)
        .join("\n")}\n\n`
    : "";

  return (
    `${context}Translate this ${request.source} group-chat message into ${request.target}.\n\n` +
    `Message:\n${request.text}\n\n` +
    `Rules:\n` +
    `- This is casual group chat. Preserve the register, tone and humour; do not formalise it.\n` +
    `- Placeholders that look like ⟦0⟧, ⟦1⟧ are mentions, emoji, code or URLs. ` +
    `Reproduce them exactly and in a sensible position. Never translate or renumber them.\n` +
    `- Use the preceding messages only to resolve what the message refers to. Do not translate them.\n` +
    `- Output only the translation. No quotes, no notes, no preamble.`
  );
}

export async function translateWithLlm(
  request: TranslationRequest,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  // Belt and braces: routing should never produce an automatic request here,
  // but this is the last gate before the content leaves the machine.
  assertContextPolicy(request);
  if (request.initiation !== "user") {
    throw new Error("PLAN.md §4.3: the LLM is reachable only from a user action");
  }

  const response = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": API_VERSION,
      // Required for calls made from a browser origin. Not covered by the
      // bundled reference, so treat it as unverified: if it turns out to be
      // unnecessary it is harmless, and if CORS still rejects the call the
      // error surfaces in the message's layer rather than disappearing.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048, // chat messages are short; deliberately capped
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      messages: [{ role: "user", content: prompt(request) }],
    }),
  });

  const body = (await response.json().catch(() => ({}))) as MessagesResponse;

  if (!response.ok) {
    throw new Error(body.error?.message ?? `${response.status} ${response.statusText}`);
  }

  if (body.stop_reason === "refusal") {
    throw new Error("the model declined to translate this message");
  }

  const text = (body.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();

  if (text === "") throw new Error("empty translation");
  return text;
}
