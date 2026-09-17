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
 * Builds the sheet a bilingual rater fills in.
 *
 * Blinded and shuffled: the engine column is omitted and rows are interleaved,
 * so a rater cannot (even unconsciously) rate the engine rather than the
 * output. `key` maps row ids back to engines at scoring time.
 */
export function buildRatingSheet(
  prepared: PreparedMessage[],
  outputs: ScoredOutput[],
  seed = 42,
): { sheet: string; key: string } {
  const byId = new Map(prepared.map((p) => [p.message.id, p.message]));

  const rows = outputs
    .filter((o) => !o.error && o.restored.trim() !== "")
    .map((o, i) => ({ rowId: `r${i}`, ...o }));

  // Deterministic shuffle so a re-run produces the same sheet.
  let state = seed;
  const rand = (): number => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = rows[i];
    const b = rows[j];
    if (a && b) {
      rows[i] = b;
      rows[j] = a;
    }
  }

  const sheet = [
    "row_id,original,translation,meaning_preserved,register_preserved,notes",
    ...rows.map((r) =>
      [
        r.rowId,
        csvCell(byId.get(r.id)?.text ?? ""),
        csvCell(r.restored),
        "",
        "",
        "",
      ].join(","),
    ),
  ].join("\n");

  const key = ["row_id,message_id,engine", ...rows.map((r) => `${r.rowId},${r.id},${r.engine}`)].join(
    "\n",
  );

  return { sheet, key };
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

If a row is unratable (truncated, empty, not really language), leave both
columns blank and say why in notes.`;
