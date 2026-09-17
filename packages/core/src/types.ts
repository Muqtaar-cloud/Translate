/** Shared vocabulary. Kept deliberately small — see PLAN.md §11. */

/** The four states Chrome's Translator API reports per language pair (PLAN.md §4.1). */
export type Availability = "available" | "downloadable" | "downloading" | "unavailable";

export type LanguageCode = string;

export interface Detection {
  lang: LanguageCode;
  /** 0..1 */
  confidence: number;
}

/**
 * How a translation was asked for.
 *
 * This is not bookkeeping: PLAN.md §5.1 permits thread context ONLY on
 * user-initiated paths. `initiation` is what makes that rule checkable.
 */
export type Initiation = "automatic" | "user";

export interface TranslationRequest {
  text: string;
  source: LanguageCode;
  target: LanguageCode;
  initiation: Initiation;
  /**
   * Preceding messages, oldest first. Permitted only when `initiation` is
   * "user" — see assertContextPolicy. Hard-bounded by MAX_CONTEXT_MESSAGES.
   */
  contextWindow?: string[];
}

/** PLAN.md §5.1: "N messages, no media, no author ids, hard-bounded." */
export const MAX_CONTEXT_MESSAGES = 5;

export class ContextPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextPolicyError";
  }
}

/**
 * Enforces PLAN.md §5.1.
 *
 * The rule needs enforcement precisely because nothing else discourages it:
 * DeepL's `context` parameter is unbilled, so cost will never push back on
 * quietly enabling context for every automatically translated message. Call
 * this on every request before it reaches a provider.
 */
export function assertContextPolicy(req: TranslationRequest): void {
  const n = req.contextWindow?.length ?? 0;
  if (n === 0) return;
  if (req.initiation === "automatic") {
    throw new ContextPolicyError(
      "PLAN.md §5.1: thread context is permitted only on user-initiated paths; " +
        `got ${n} context message(s) on an automatic request.`,
    );
  }
  if (n > MAX_CONTEXT_MESSAGES) {
    throw new ContextPolicyError(
      `PLAN.md §5.1: context window is hard-bounded at ${MAX_CONTEXT_MESSAGES}; got ${n}.`,
    );
  }
}
