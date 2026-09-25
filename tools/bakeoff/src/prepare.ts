import { mask, restore, survivalRate } from "@polyglot/core";
import type { CorpusMessage } from "./corpus.js";
import type { EngineItem, EngineOutput } from "./engines/types.js";

/**
 * PLAN.md §6: DNT spans are masked with the real masking code before the corpus
 * reaches any engine. Otherwise 0b measures the unmasked baseline — every
 * engine mangles @handles and :emoji: when nothing is protecting them — and a
 * rater marks all four candidates down for a problem none of them caused.
 */
export interface PreparedMessage {
  message: CorpusMessage;
  item: EngineItem;
  spans: string[];
}

export function prepare(
  messages: CorpusMessage[],
  target: string,
  opts: { includeContext: boolean },
): PreparedMessage[] {
  return messages.map((message) => {
    const { masked, spans } = mask(message.text);
    return {
      message,
      spans,
      item: {
        id: message.id,
        masked,
        source: message.source,
        target,
        ...(opts.includeContext && message.context ? { context: message.context } : {}),
      },
    };
  });
}

export interface ScoredOutput {
  id: string;
  engine: string;
  /** Translation with DNT placeholders put back. What a rater sees. */
  restored: string;
  /** Fraction of this message's DNT spans the engine left intact. */
  dntSurvival: number;
  error?: string;
}

export function restoreOutputs(
  prepared: PreparedMessage[],
  outputs: EngineOutput[],
  engine: string,
): ScoredOutput[] {
  const bySpan = new Map(prepared.map((p) => [p.item.id, p]));

  return outputs.map((o) => {
    const p = bySpan.get(o.id);
    if (!p) return { id: o.id, engine, restored: o.output, dntSurvival: 1 };

    const result = restore(o.output, p.spans);
    return {
      id: o.id,
      engine,
      restored: result.text,
      dntSurvival: survivalRate(result, p.spans.length),
      ...(o.error ? { error: o.error } : {}),
    };
  });
}

const csvCell = (s: string): string => `"${s.replaceAll('"', '""')}"`;

/**
 * Gold rows: checks with a known answer, mixed into the sheet so a rater's
 * reliability is measured rather than assumed.
 *
 * The constraint that shapes them: the person running this cannot read the
 * source languages, so a gold row cannot be a hand-written reference
 * translation. What CAN be built for any language without reading it is a
 * mismatch — message A's original beside message B's translation. It is fluent,
 * it is casual, and it says the wrong thing, which is precisely the failure the
 * rater exists to catch (PLAN.md §6: "a fluent translation that says the wrong
 * thing is n"). Its known answer is always meaning_preserved = n.
 *
 * What mismatch gold cannot catch is a rater who marks everything n: they pass
 * every trap. Known-good rows would catch that, and they need someone who reads
 * the language to write them. The score report warns when a rater's real rows
 * are almost all n instead, because only a human spot-check can separate a
 * harsh rater from genuinely bad engines.
 */
export const GOLD_RATE = 0.05;
export const GOLD_MIN = 4;
export const GOLD_MAX = 20;

/** Gold rows for a sheet of `realRows` rows across `messages` distinct messages. */
export function goldCount(realRows: number, messages: number): number {
  // A mismatch needs a second message to borrow a translation from, and each
  // gold row uses a different host message.
  if (messages < 2 || realRows === 0) return 0;
  const n = Math.min(GOLD_MAX, Math.max(GOLD_MIN, Math.round(realRows * GOLD_RATE)));
  return Math.min(n, messages);
}

const words = (s: string): Set<string> =>
  new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));

/** Jaccard overlap of word sets: a cheap guard against an accidental match. */
function overlap(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 && y.size === 0) return 1;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

export const KEY_HEADER = "row_id,message_id,engine,kind,donor_message_id";

export interface SheetOptions {
  seed?: number;
  /** Row-id prefix, e.g. `es-` for the Spanish rater's sheet. */
  prefix?: string;
  /** Mix in gold rows. On by default; off only for tests of the plain sheet. */
  gold?: boolean;
}

interface SheetRow {
  id: string;
  engine: string;
  restored: string;
  kind: "real" | "gold";
  donor?: string;
}

/**
 * Builds the sheet a bilingual rater fills in.
 *
 * Blinded and shuffled: the engine column is omitted and rows are interleaved,
 * so a rater cannot (even unconsciously) rate the engine rather than the
 * output. `key` maps row ids back to engines — and gold rows to their known
 * answer — at scoring time.
 *
 * Row ids are assigned AFTER the shuffle, in display order. Measured: they used
 * to be assigned before it, so ids kept generation order — r0–r99 one engine,
 * r100–r199 the next — and anyone glancing at the row_id column could see
 * which rows came from the same system. That defeated the blinding the rater
 * instructions promise, and would also have marked every gold row, appended
 * last, with the highest ids in the sheet.
 */
export function buildRatingSheet(
  prepared: PreparedMessage[],
  outputs: ScoredOutput[],
  opts: SheetOptions = {},
): { sheet: string; key: string; gold: number } {
  const { seed = 42, prefix = "r", gold = true } = opts;
  const byId = new Map(prepared.map((p) => [p.message.id, p.message]));

  // Deterministic, so a re-run produces the same sheet and the same key.
  let state = seed;
  const rand = (): number => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };

  const real: SheetRow[] = outputs
    .filter((o) => !o.error && o.restored.trim() !== "")
    .map((o) => ({ id: o.id, engine: o.engine, restored: o.restored, kind: "real" }));

  const rows: SheetRow[] = [...real];

  if (gold) {
    const translationsOf = new Map<string, string[]>();
    for (const r of real) {
      const list = translationsOf.get(r.id) ?? [];
      list.push(r.restored);
      translationsOf.set(r.id, list);
    }

    const hosts = [...translationsOf.keys()].filter((id) => byId.has(id));
    const wanted = goldCount(real.length, hosts.length);

    for (let i = hosts.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [hosts[i], hosts[j]] = [hosts[j] as string, hosts[i] as string];
    }

    const usedDonors = new Set<string>();
    for (const host of hosts) {
      if (rows.length - real.length >= wanted) break;
      const own = translationsOf.get(host) ?? [];
      const ownNorm = new Set(own.map((t) => t.trim().toLowerCase()));

      // Candidates: another message's translation that is not textually the
      // same as any of this message's own. Of a few sampled, keep the one that
      // shares fewest words with this message's real translations — two
      // messages that both mean "ok see you tomorrow" would otherwise make a
      // trap whose right answer is actually y.
      const pool = real.filter(
        (r) => r.id !== host && !usedDonors.has(r.id) && !ownNorm.has(r.restored.trim().toLowerCase()),
      );
      if (pool.length === 0) continue;

      let best: SheetRow | undefined;
      let bestScore = Infinity;
      for (let k = 0; k < Math.min(8, pool.length); k++) {
        const candidate = pool[Math.floor(rand() * pool.length)];
        if (!candidate) continue;
        const score = Math.max(...own.map((t) => overlap(t, candidate.restored)));
        if (score < bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
      if (!best) continue;

      usedDonors.add(best.id);
      rows.push({ id: host, engine: "gold", restored: best.restored, kind: "gold", donor: best.id });
    }
  }

  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = rows[i];
    const b = rows[j];
    if (a && b) {
      rows[i] = b;
      rows[j] = a;
    }
  }

  const numbered = rows.map((r, i) => ({ ...r, rowId: `${prefix}${i + 1}` }));

  const sheet = [
    "row_id,original,translation,meaning_preserved,register_preserved,notes",
    ...numbered.map((r) =>
      [r.rowId, csvCell(byId.get(r.id)?.text ?? ""), csvCell(r.restored), "", "", ""].join(","),
    ),
  ].join("\n");

  const key = [
    KEY_HEADER,
    ...numbered.map((r) => `${r.rowId},${r.id},${r.engine},${r.kind},${r.donor ?? ""}`),
  ].join("\n");

  return { sheet, key, gold: rows.length - real.length };
}

export const RATER_INSTRUCTIONS = `Rating instructions (PLAN.md §6)

You are rating machine translations of casual group-chat messages. The person
who built this cannot read the source language — that is the whole reason your
rating is the gate, and why an automated proxy was rejected for this job.

Two columns, y or n:

  meaning_preserved   Would a reader of the translation come away understanding
                      what the original actually said? Small wording differences
                      are fine. A fluent translation that says the wrong thing
                      is n — that failure is the one this exists to catch.

  register_preserved  Is it still casual? Chat that comes back sounding like a
                      business letter is n, even when the meaning is right.

Text like the symbols around numbers (for example a bracketed 0 or 1) stands in
for @mentions, emoji, code and links. Ignore them; they are counted separately.

Rows are shuffled and the engine is hidden on purpose. Please do not try to
work out which system produced which line.

A few rows are checks with a known answer, mixed in with the rest. They look
like every other row. They are there so that a quick pass through the sheet
cannot look like a careful one, so please rate every row the same way.

If a row is unratable (truncated, empty, not really language), leave both
columns blank and say why in notes.`;
