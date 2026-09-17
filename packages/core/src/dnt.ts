/**
 * Do-not-translate spans (PLAN.md §3, §12).
 *
 * Mentions, channel references, custom emoji, code and URLs must survive a
 * round trip through a translation engine untouched. Getting this wrong makes
 * output look broken instantly, so §12 requires 100% survival.
 *
 * The placeholder style is deliberately a parameter rather than a constant:
 * which sentinel an MT engine leaves alone is an empirical question, and the
 * Phase 0b harness measures survival per engine (see tools/bakeoff). If a style
 * turns out to be mangled, change it here on evidence.
 */

export interface MaskOptions {
  /** Builds the sentinel for span `i`. Default: U+27E6 i U+27E7, e.g. ⟦0⟧. */
  placeholder?: (i: number) => string;
}

export interface MaskResult {
  masked: string;
  /** Original span text, indexed by placeholder number. */
  spans: string[];
}

export interface RestoreResult {
  text: string;
  /** Placeholder indices the engine dropped or mangled. Empty means a clean pass. */
  missing: number[];
}

const defaultPlaceholder = (i: number): string => `\u27E6${i}\u27E7`;

/**
 * Ordered: earlier patterns win. Fenced code before inline code before the
 * angle-bracket entities it might otherwise contain; URLs before bare handles,
 * since a URL can hold a `#fragment` that looks like a channel reference.
 */
const PATTERNS: readonly RegExp[] = [
  /```[\s\S]*?```/g, // fenced code
  /`[^`\n]+`/g, // inline code
  /<a?:[A-Za-z0-9_]+:\d+>/g, // custom emoji <:name:id> / <a:name:id>
  /<@[!&]?\d+>/g, // user and role mentions
  /<#\d+>/g, // channel mentions
  /<\/[A-Za-z0-9_ -]+:\d+>/g, // slash-command mentions
  /<t:\d+(?::[tTdDfFR])?>/g, // timestamps
  /https?:\/\/\S+/g, // URLs
  /:[a-z0-9_+-]+:/gi, // :shortcode: emoji
  /(?<![\w/])@[A-Za-z0-9._-]{2,32}/g, // plain @handles
  /(?<![\w/])#[A-Za-z0-9._-]{2,32}/g, // plain #channels
];

export function mask(text: string, opts: MaskOptions = {}): MaskResult {
  const placeholder = opts.placeholder ?? defaultPlaceholder;
  const spans: string[] = [];
  let masked = text;

  for (const pattern of PATTERNS) {
    masked = masked.replace(new RegExp(pattern.source, pattern.flags), (match) => {
      const i = spans.length;
      spans.push(match);
      return placeholder(i);
    });
  }

  return { masked, spans };
}

export function restore(
  translated: string,
  spans: readonly string[],
  opts: MaskOptions = {},
): RestoreResult {
  const placeholder = opts.placeholder ?? defaultPlaceholder;
  const missing: number[] = [];
  let text = translated;

  for (let i = 0; i < spans.length; i++) {
    const token = placeholder(i);
    const span = spans[i];
    if (span === undefined) continue;
    if (!text.includes(token)) {
      missing.push(i);
      continue;
    }
    text = text.replaceAll(token, span);
  }

  return { text, missing };
}

/** Convenience for the harness: what fraction of spans survived the engine. */
export function survivalRate(result: RestoreResult, spanCount: number): number {
  if (spanCount === 0) return 1;
  return (spanCount - result.missing.length) / spanCount;
}
