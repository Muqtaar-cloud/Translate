import type { Detection, LanguageCode } from "./types.js";

/**
 * Language resolution and the skip rules (PLAN.md §4.5).
 *
 * Detection is injected rather than imported: in the extension it is Chrome's
 * built-in LanguageDetector (content script only — §4.2), in the Phase 0b
 * harness it is whatever the bake-off wires up, and in tests it is a fake.
 */

export type Detector = (text: string) => Promise<Detection[]>;

/** Below this, detection on chat text is not trustworthy (PLAN.md §4.5). */
export const MIN_RELIABLE_CHARS = 15;

export interface ResolveContext {
  knownLanguages: readonly LanguageCode[];
  /** Dominant language of the channel, if one is established. */
  channelDominant?: LanguageCode;
  /** Recently detected languages for this author, most recent first. */
  authorRecent?: readonly LanguageCode[];
  minChars?: number;
}

export type Resolution =
  | { lang: LanguageCode; source: "detector" | "author" | "channel"; confident: boolean }
  | { lang: null; source: "none"; confident: false };

/**
 * Resolves a message's language, falling back to author stickiness and then to
 * the channel's dominant language for text too short to detect.
 *
 * Note what this deliberately does NOT do: it does not silently give up on a
 * short message. Returning `null` means the caller shows no layer, and §12
 * counts that as a false negative — a skipped Spanish "ya voy" is visually
 * identical to an English one, so the hover affordance must remain available on
 * every message.
 */
export function resolve(
  text: string,
  detections: readonly Detection[],
  ctx: ResolveContext,
): Resolution {
  const minChars = ctx.minChars ?? MIN_RELIABLE_CHARS;
  const trimmed = text.trim();

  if (trimmed.length >= minChars) {
    const best = detections[0];
    if (best && best.confidence >= 0.5) {
      return { lang: best.lang, source: "detector", confident: best.confidence >= 0.75 };
    }
  }

  // Too short, or detection was not confident enough to trust.
  const sticky = ctx.authorRecent?.[0];
  if (sticky) return { lang: sticky, source: "author", confident: false };

  if (ctx.channelDominant) {
    return { lang: ctx.channelDominant, source: "channel", confident: false };
  }

  return { lang: null, source: "none", confident: false };
}

/** Splits on sentence-ish boundaries, including newlines, which chat uses heavily. */
export function segment(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface CodeSwitchResult {
  /** Distinct languages confidently detected across the message's segments. */
  languages: LanguageCode[];
  switched: boolean;
  /** Segments too short to judge; a high count means the verdict is weak. */
  inconclusiveSegments: number;
}

/**
 * Measures intra-message code-switching.
 *
 * This exists so PLAN.md §4.5 can be decided on evidence: the Phase 0b corpus
 * is being collected anyway, so the harness counts how often code-switching
 * actually occurs before anyone builds per-segment translation for it. Under
 * ~5% of messages, drop segmentation and the golden-set cases together; over
 * ~15%, build it.
 */
export async function measureCodeSwitching(
  text: string,
  detect: Detector,
  minChars = MIN_RELIABLE_CHARS,
): Promise<CodeSwitchResult> {
  const segments = segment(text);
  const languages = new Set<LanguageCode>();
  let inconclusive = 0;

  for (const s of segments) {
    if (s.length < minChars) {
      inconclusive++;
      continue;
    }
    const best = (await detect(s))[0];
    if (best && best.confidence >= 0.75) languages.add(best.lang);
    else inconclusive++;
  }

  return {
    languages: [...languages],
    switched: languages.size > 1,
    inconclusiveSegments: inconclusive,
  };
}
