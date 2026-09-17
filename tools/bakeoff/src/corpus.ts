import { readFileSync } from "node:fs";

/**
 * One corpus message. JSONL, one object per line.
 *
 * PLAN.md §5.2: this file is real messages from a private group chat, so it is
 * itself the first instance of exporting other people's words. Strip authors
 * when collecting it, use a channel you would be comfortable exporting, and do
 * not treat it as exempt for being "just a test". `.gitignore` excludes
 * tools/bakeoff/data/ for this reason.
 */
export interface CorpusMessage {
  id: string;
  text: string;
  source: string;
  /** Preceding messages, oldest first. Used only by the context-assisted tier. */
  context?: string[];
}

export function parseCorpus(jsonl: string): CorpusMessage[] {
  const messages: CorpusMessage[] = [];
  const seen = new Set<string>();

  jsonl.split("\n").forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("//")) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`corpus line ${i + 1}: not valid JSON`);
    }

    const m = parsed as Partial<CorpusMessage>;
    if (typeof m.id !== "string" || m.id === "") {
      throw new Error(`corpus line ${i + 1}: missing "id"`);
    }
    if (typeof m.text !== "string" || m.text.trim() === "") {
      throw new Error(`corpus line ${i + 1}: missing "text"`);
    }
    if (typeof m.source !== "string" || m.source === "") {
      throw new Error(`corpus line ${i + 1}: missing "source" language`);
    }
    if (seen.has(m.id)) throw new Error(`corpus line ${i + 1}: duplicate id "${m.id}"`);
    seen.add(m.id);

    if (m.context !== undefined && !Array.isArray(m.context)) {
      throw new Error(`corpus line ${i + 1}: "context" must be an array of strings`);
    }

    messages.push({
      id: m.id,
      text: m.text,
      source: m.source,
      ...(m.context ? { context: m.context } : {}),
    });
  });

  return messages;
}

export function loadCorpus(path: string): CorpusMessage[] {
  return parseCorpus(readFileSync(path, "utf8"));
}

/** Per-language counts, so §6's "two languages, ~80–100 each" can be checked. */
export function summarise(messages: CorpusMessage[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of messages) counts[m.source] = (counts[m.source] ?? 0) + 1;
  return counts;
}
