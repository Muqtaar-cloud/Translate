import { execFileSync } from "node:child_process";
import {
  MAX_CONTEXT_MESSAGES,
  MIN_RELIABLE_CHARS,
  heuristicDetect,
  measureCodeSwitching,
} from "@polyglot/core";
import type { CorpusMessage } from "./corpus.js";

/**
 * Corpus collection for Phase 0b (PLAN.md §6).
 *
 * The bake-off has been runnable for weeks and has never run, because it needs
 * the one input a repository cannot contain: real messages from a real
 * multilingual group chat. This turns that input from "an afternoon of
 * copy-pasting" into a command — which is the only reason the gate has stayed
 * theoretical rather than being run and possibly failed.
 *
 * ## What this deliberately does not do
 *
 * **It does not touch an account.** §7 is explicit: reading the DOM in my own
 * browser is ordinary extension behaviour, but automating a user account is not
 * — Discord bans self-bots and API-driven automation of a user account breaks
 * Telegram's terms too. So every source here is a file the user already has,
 * exported or saved by the client itself. Nothing here logs in, scrapes a live
 * session, or calls a platform API.
 *
 * That rules out the obvious tool. DiscordChatExporter is what anyone searching
 * for this will find first, and it drives the account's own token against
 * Discord's API — exactly what §7 says not to do. It is not supported here, and
 * a corpus collected with it is a terms violation regardless of how the file
 * reaches this script.
 *
 * ## The custody problem, which is the real content of this file
 *
 * A corpus is other people's private messages sitting in a file on my disk. The
 * plan's §5 says cloud translation sends other people's words to a third party
 * and that they have not agreed; a corpus is the same act with a longer
 * retention period. So:
 *
 * - **Authors never enter the pipeline.** `RawMessage` has no author field to
 *   drop later — the parsers discard identity at the boundary, so no ordering
 *   of later steps can leak it.
 * - **Redaction runs before anything is written**, and its shape is chosen so
 *   the DNT measurement stays honest (see `redact`).
 * - **The output must be in a git-ignored location.** Enforced, not documented:
 *   `assertIgnored` refuses to write a corpus somewhere a later `git add -A`
 *   would commit it.
 *
 * What it cannot do: names in prose. "ana, vienes?" is a person's name in a
 * message body, and no mechanical pass finds that reliably. Read the corpus
 * before it goes anywhere, and treat "do not share it" as the default rather
 * than a precaution.
 */

/**
 * A message stripped to what the bake-off needs.
 *
 * No author, no timestamp, no chat id, no message id from the platform. The
 * ordinal is the position in the exported sequence, which is all that is needed
 * to rebuild a context window and is useless for identifying anyone.
 */
export interface RawMessage {
  text: string;
  ordinal: number;
}

export type RedactionKind = "url" | "handle" | "email" | "phone" | "digits";

export interface RedactionCounts {
  url: number;
  handle: number;
  email: number;
  phone: number;
  digits: number;
}

const emptyCounts = (): RedactionCounts => ({
  url: 0,
  handle: 0,
  email: 0,
  phone: 0,
  digits: 0,
});

/**
 * Removes identifying content, preserving the *shape* the DNT masker keys on.
 *
 * The shape matters more than it looks. §6 requires DNT spans to be masked
 * before the corpus reaches any engine and counts placeholder survival per
 * engine — so if redaction replaced a URL with the word `[link]`, the corpus
 * would contain fewer DNT spans than real chat does and the survival number
 * would be measured against text that no longer resembles the input. Replacing
 * a real URL with a fake URL keeps the span count, the position and the
 * mask/restore path identical while removing the content.
 *
 * Substitutions are numbered per message so that a message referring to the
 * same handle twice still reads as one person. They are NOT stable across
 * messages: `@user1` in two different messages is not a claim about the same
 * account. Stable pseudonyms would be a re-identification surface — the point
 * is that the corpus cannot be used to reconstruct who said what to whom.
 *
 * Order is deliberate: emails before handles (an email contains an `@` that
 * would otherwise be read as a mention) and before digit runs (an address can
 * contain them); URLs first, since a URL can contain all three.
 */
export function redact(text: string): { text: string; counts: RedactionCounts } {
  const counts = emptyCounts();
  let out = text;

  // Keep a real URL shape: masked as a DNT span exactly as the original was.
  out = out.replace(/https?:\/\/\S+/g, () => `https://redacted.invalid/${++counts.url}`);

  out = out.replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    () => `redacted${++counts.email}@example.invalid`,
  );

  /**
   * Discord's numeric mention form, before any rule that looks at digit runs.
   *
   * Measured: a snowflake is a long run of digits, so a phone-number pattern
   * matches it and turns `<@123456789>` into `<@[phone]>`. That silently
   * destroys a DNT span, and the DNT survival number §6 reports would then be
   * measured against a corpus with fewer spans than the chat it came from. The
   * replacement keeps the form intact so it is still masked as a mention.
   */
  out = out.replace(/<@[!&]?\d+>/g, () => `<@${String(100000 + ++counts.handle)}>`);

  // Long digit runs before phone numbers: a card or IBAN also matches a phone
  // pattern, and counting a card as a phone number under-reports what was in
  // the corpus. Longest and most specific first.
  out = out.replace(/\d{12,}/g, () => {
    counts.digits++;
    return "[number]";
  });

  // International and grouped forms: +34 600 123 456, (555) 010-9999.
  out = out.replace(/\+?\d[\d\s().-]{7,}\d/g, () => {
    counts.phone++;
    return "[phone]";
  });

  // Plain @handles. A DNT span, so the replacement is still one.
  out = out.replace(/(?<![\w/])@[A-Za-z0-9._-]{2,32}/g, () => `@user${++counts.handle}`);

  return { text: out, counts };
}

/**
 * Telegram Desktop's own export (Settings, Advanced, Export Telegram data, or a
 * single chat's "Export chat history" with format JSON).
 *
 * This is the sanctioned path: the official client writes the file, so no
 * account is automated and no API is called.
 *
 * `text` is a string for a plain message and an array of parts for anything with
 * an entity in it (links, mentions, code, bold). Both shapes are handled, and
 * the entity text is kept rather than flattened away — a message whose only
 * content is a link is still a message, and a mention is a DNT span the
 * bake-off wants to see.
 */
export function parseTelegramExport(json: string): RawMessage[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("telegram export: not valid JSON (expected the client's result.json)");
  }

  const root = parsed as { messages?: unknown[] };
  if (!Array.isArray(root.messages)) {
    throw new Error(
      'telegram export: no "messages" array. Export a chat as JSON rather than HTML.',
    );
  }

  const out: RawMessage[] = [];
  let ordinal = 0;

  for (const entry of root.messages) {
    const m = entry as {
      type?: string;
      text?: unknown;
      sticker_emoji?: string;
    };
    // Service messages: joins, pins, calls, title changes. Not chat.
    if (m.type !== "message") continue;

    const text = flattenTelegramText(m.text).trim();
    if (text === "") continue;

    out.push({ text, ordinal: ordinal++ });
  }

  return out;
}

function flattenTelegramText(text: unknown): string {
  if (typeof text === "string") return text;
  if (!Array.isArray(text)) return "";
  return text
    .map((part) => {
      if (typeof part === "string") return part;
      const p = part as { text?: unknown };
      return typeof p.text === "string" ? p.text : "";
    })
    .join("");
}

/**
 * A Discord channel page saved from the browser (Ctrl+S, "complete" or
 * "HTML only").
 *
 * Saving a page I am already looking at is the same act as the extension
 * reading the DOM, which §7 puts squarely inside ordinary browser behaviour.
 * The user scrolls back as far as they want a corpus for, saves, and this reads
 * the file.
 *
 * The selectors are the adapter's contract, not a second guess at it: id
 * prefixes and `data-*` only, never a hashed class. If Discord's markup moves,
 * this breaks in the same release as the adapter and for the same reason, which
 * is the behaviour I want — a collector that kept working while the adapter
 * broke would be reading something the product cannot.
 */
export function parseDiscordHtml(html: string, doc: Document): RawMessage[] {
  doc.body.innerHTML = html;

  const rows = doc.querySelectorAll('li[id^="chat-messages-"]');
  const out: RawMessage[] = [];
  let ordinal = 0;

  for (const row of Array.from(rows)) {
    const content = row.querySelector('[id^="message-content-"]');
    if (!content) continue;

    // Same strip list as the adapter's extract(): embeds and link previews are
    // not message text, and a reply's quoted context would enter the corpus
    // twice — once as quoted context and once as its own row.
    const clone = content.cloneNode(true) as Element;
    for (const junk of Array.from(
      clone.querySelectorAll('[id^="message-accessories-"], [id^="message-reply-context-"]'),
    )) {
      junk.remove();
    }

    const text = (clone.textContent ?? "").trim();
    if (text === "") continue;

    out.push({ text, ordinal: ordinal++ });
  }

  return out;
}

/** One message per line. The fallback that needs no export at all. */
export function parseTextLines(text: string): RawMessage[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("//"))
    .map((l, i) => ({ text: l, ordinal: i }));
}

export interface CollectOptions {
  /** Cap per language, so §6's "~80-100 per language" is reachable exactly. */
  perLanguage?: number;
  /** Languages to keep. Empty keeps whatever is detected. */
  languages?: readonly string[];
  /** Seed for the sample, so a corpus can be regenerated identically. */
  seed?: number;
  /** Confidence below which a label is a guess rather than a label. */
  minConfidence?: number;
  contextMessages?: number;
}

export interface CollectReport {
  parsed: number;
  afterDedupe: number;
  redactions: RedactionCounts;
  redactedMessages: number;
  /** Below MIN_RELIABLE_CHARS: dropped, because no label would be honest. */
  tooShort: number;
  /** Long enough to label but ambiguous: sent to review, not dropped. */
  undetected: number;
  lowConfidence: number;
  perLanguage: Record<string, number>;
  sampled: Record<string, number>;
  codeSwitched: number;
  codeSwitchSampleSize: number;
}

export interface CollectResult {
  corpus: CorpusMessage[];
  /** Detected but not confidently: a human confirms the label before use. */
  review: (CorpusMessage & { confidence: number })[];
  report: CollectReport;
}

/** mulberry32 — a seeded PRNG, so the same input yields the same corpus. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const normalise = (s: string): string => s.toLowerCase().replace(/\s+/gu, " ").trim();

/**
 * Raw messages to a corpus.
 *
 * The one decision worth defending: a message whose language cannot be
 * confidently detected goes to `review`, not to the corpus and not to the bin.
 *
 * Dropping it would bias the corpus towards long, well-formed messages — which
 * is exactly the text machine translation is already good at, and would make the
 * gate easier than the product. Writing a guess is worse: the engines are told
 * the source language, so a wrong label measures "translating Spanish as
 * Portuguese" and blames the engine for it. A short review file is the honest
 * third option, and §6 already budgets a human for this phase.
 */
export async function collect(
  raws: readonly RawMessage[],
  opts: CollectOptions = {},
): Promise<CollectResult> {
  const perLanguage = opts.perLanguage ?? 100;
  const minConfidence = opts.minConfidence ?? 0.6;
  const contextMessages = Math.min(opts.contextMessages ?? 3, MAX_CONTEXT_MESSAGES);
  const wanted = new Set(opts.languages ?? []);

  const report: CollectReport = {
    parsed: raws.length,
    afterDedupe: 0,
    redactions: emptyCounts(),
    redactedMessages: 0,
    tooShort: 0,
    undetected: 0,
    lowConfidence: 0,
    perLanguage: {},
    sampled: {},
    codeSwitched: 0,
    codeSwitchSampleSize: 0,
  };

  // Redact first: every later stage, including the report, sees only clean text.
  const redacted = raws.map((raw) => {
    const { text, counts } = redact(raw.text);
    let touched = false;
    for (const key of Object.keys(counts) as RedactionKind[]) {
      report.redactions[key] += counts[key];
      if (counts[key] > 0) touched = true;
    }
    if (touched) report.redactedMessages++;
    return { text, ordinal: raw.ordinal };
  });

  // Dedupe on normalised text. Chat is full of "ok", "jaja", "+1", and a corpus
  // of a hundred messages where eleven are "si" measures agreement, not
  // translation. Keeps the first occurrence so context stays coherent.
  const seen = new Set<string>();
  const unique = redacted.filter((m) => {
    const key = normalise(m.text);
    if (key === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  report.afterDedupe = unique.length;

  const byOrdinal = new Map(redacted.map((m) => [m.ordinal, m.text]));
  const contextFor = (ordinal: number): string[] => {
    const out: string[] = [];
    for (let i = ordinal - contextMessages; i < ordinal; i++) {
      const text = byOrdinal.get(i);
      if (text !== undefined) out.push(text);
    }
    return out;
  };

  const candidates: { message: CorpusMessage; confidence: number }[] = [];
  const review: (CorpusMessage & { confidence: number })[] = [];

  for (const m of unique) {
    const context = contextFor(m.ordinal);
    const base = {
      // Opaque and derived from position only. Nothing platform-side survives.
      id: `m${String(m.ordinal).padStart(5, "0")}`,
      text: m.text,
      ...(context.length > 0 ? { context } : {}),
    };

    // Too short for any detector to be honest about (§4.5's threshold). Dropped
    // and counted: the extension handles these with author and channel
    // stickiness, which a flat corpus file has no equivalent for.
    if (m.text.trim().length < MIN_RELIABLE_CHARS) {
      report.tooShort++;
      continue;
    }

    const best = heuristicDetect(m.text)[0];

    // Long enough to label, but the detector would not commit. This goes to
    // review with an empty source rather than being dropped — dropping it is
    // what biases the corpus towards text machine translation already handles
    // well. An empty source is also rejected by `parseCorpus`, so an unedited
    // review file fails loudly instead of quietly relabelling anything.
    if (!best) {
      report.undetected++;
      review.push({ ...base, source: "", confidence: 0 });
      continue;
    }

    if (wanted.size > 0 && !wanted.has(best.lang)) continue;

    const message: CorpusMessage = { ...base, source: best.lang };
    report.perLanguage[best.lang] = (report.perLanguage[best.lang] ?? 0) + 1;

    if (best.confidence < minConfidence) {
      report.lowConfidence++;
      review.push({ ...message, confidence: best.confidence });
      continue;
    }
    candidates.push({ message, confidence: best.confidence });
  }

  // Sample per language, seeded. Shuffling before the cap matters: taking the
  // first N would take the start of the export, which is one conversation on
  // one day about one thing.
  const random = rng(opts.seed ?? 1);
  const grouped = new Map<string, CorpusMessage[]>();
  for (const c of candidates) {
    const list = grouped.get(c.message.source) ?? [];
    list.push(c.message);
    grouped.set(c.message.source, list);
  }

  const corpus: CorpusMessage[] = [];
  for (const [lang, list] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      const a = list[i];
      const b = list[j];
      if (a && b) {
        list[i] = b;
        list[j] = a;
      }
    }
    const taken = list.slice(0, perLanguage);
    report.sampled[lang] = taken.length;
    corpus.push(...taken);
  }

  // §6 counts code-switching in this phase "free", since the corpus exists
  // anyway. Measured on what was sampled, so the number describes the corpus
  // the raters actually see.
  const detectAsync = async (t: string) => heuristicDetect(t);
  for (const m of corpus) {
    const result = await measureCodeSwitching(m.text, detectAsync);
    report.codeSwitchSampleSize++;
    if (result.switched) report.codeSwitched++;
  }

  corpus.sort((a, b) => a.id.localeCompare(b.id));
  return { corpus, review, report };
}

/**
 * Refuses to write a corpus anywhere git would pick it up.
 *
 * This is the one control in the file that is not advice. A corpus of a friend's
 * private group chat committed to a public repository is the worst outcome
 * available here, it happens through `git add -A` rather than through a
 * decision, and `.gitignore` covering `tools/bakeoff/data/` only helps if that
 * is actually where the file lands.
 */
export function assertIgnored(path: string): void {
  try {
    execFileSync("git", ["check-ignore", "-q", path], { stdio: "ignore" });
  } catch {
    throw new Error(
      `refusing to write ${path}: git does not ignore it.\n` +
        "A corpus is other people's private messages (PLAN.md §5.2). Write it " +
        "under tools/bakeoff/data/, which .gitignore covers, or add the path to " +
        ".gitignore first.",
    );
  }
}

/** JSONL, with provenance in `//` lines that `parseCorpus` already skips. */
export function formatCorpus(
  corpus: readonly CorpusMessage[],
  report: CollectReport,
  sourceKind: string,
): string {
  const header = [
    `// Phase 0b corpus — ${corpus.length} messages, collected ${new Date().toISOString().slice(0, 10)}`,
    `// source: ${sourceKind} (client export / saved page; no account was automated — PLAN.md §7)`,
    `// redacted: ${JSON.stringify(report.redactions)}`,
    "// Authors were never parsed. Ids are ordinals, not platform ids.",
    "// Other people's private messages. Do not share, do not commit, delete when 0b is decided.",
  ].join("\n");

  const lines = corpus.map((m) => JSON.stringify(m));
  return `${header}\n${lines.join("\n")}\n`;
}

export function formatCollectionReport(report: CollectReport): string {
  const pct = (n: number, d: number): string =>
    d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`;

  const lines = [
    "Corpus collection — Phase 0b (PLAN.md §6)",
    "",
    `  parsed                ${report.parsed}`,
    `  after dedupe          ${report.afterDedupe}`,
    `  redacted              ${report.redactedMessages} messages ${JSON.stringify(report.redactions)}`,
    `  too short to label    ${report.tooShort} (under ${MIN_RELIABLE_CHARS} chars, dropped)`,
    `  ambiguous             ${report.undetected} -> review file, source left blank`,
    `  low confidence        ${report.lowConfidence} -> review file, label to confirm`,
    "",
    "  detected:",
  ];

  for (const [lang, n] of Object.entries(report.perLanguage).sort((a, b) => b[1] - a[1])) {
    lines.push(`    ${lang.padEnd(6)} ${String(n).padStart(5)}   sampled ${report.sampled[lang] ?? 0}`);
  }

  lines.push(
    "",
    `  code-switching        ${report.codeSwitched}/${report.codeSwitchSampleSize} (${pct(
      report.codeSwitched,
      report.codeSwitchSampleSize,
    )}) of sampled messages`,
    "    §4.5: under ~5% drop segmentation and its golden-set cases; over ~15% build it.",
  );

  const sampled = Object.values(report.sampled);
  const languages = sampled.filter((n) => n >= 80).length;
  if (languages < 2) {
    lines.push(
      "",
      "  NOT YET ENOUGH FOR THE GATE. §6 asks for ~80-100 messages in each of two",
      "  languages, rated carefully. Collect more history, or a second channel,",
      "  before spending rater time — an underpowered gate returns whatever number",
      "  you were hoping for, which is the failure §6 exists to prevent.",
    );
  }

  return lines.join("\n");
}
