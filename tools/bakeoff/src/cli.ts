#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertIgnored,
  collect,
  formatCollectionReport,
  formatCorpus,
  parseDiscordHtml,
  parseTelegramExport,
  parseTextLines,
  type RawMessage,
} from "./collect.js";
import { loadCorpus, summarise } from "./corpus.js";
import { AnthropicEngine } from "./engines/anthropic.js";
import { DeepLEngine } from "./engines/deepl.js";
import { EchoEngine } from "./engines/echo.js";
import { OnDeviceEngine } from "./engines/ondevice.js";
import { SelfHostedEngine } from "./engines/selfhosted.js";
import type { Engine } from "./engines/types.js";
import { buildRatingSheet, prepare, RATER_INSTRUCTIONS, restoreOutputs, type ScoredOutput } from "./prepare.js";
import { formatReport, scoreEngine, type EngineScore, type Rating } from "./score.js";

const OUT = "tools/bakeoff/data";

function selectEngines(names: string[]): Engine[] {
  const engines: Engine[] = [];
  for (const name of names) {
    if (name === "ondevice") engines.push(new OnDeviceEngine());
    else if (name === "deepl") {
      const key = process.env["DEEPL_API_KEY"];
      if (!key) throw new Error("DEEPL_API_KEY is not set");
      engines.push(new DeepLEngine(key));
    } else if (name === "llm") engines.push(new AnthropicEngine());
    else if (name === "selfhosted") engines.push(new SelfHostedEngine(process.env["NLLB_URL"]));
    else if (name === "echo") engines.push(new EchoEngine());
    else throw new Error(`unknown engine "${name}"`);
  }
  return engines;
}

async function cmdProbe(): Promise<void> {
  const pairs = (process.argv[3] ?? "es->en,pt->en,ar->en,fr->en")
    .split(",")
    .map((p) => {
      const [source, target] = p.split("->");
      return { source: source ?? "", target: target ?? "en" };
    });

  const engine = new OnDeviceEngine();
  try {
    const result = await engine.probe(pairs);
    console.log("Phase 0a — capability probe (PLAN.md §4.1, §4.2)\n");
    console.log(`  Translator API present:      ${result.apiPresent}`);
    console.log(`  LanguageDetector present:    ${result.detectorPresent}`);
    for (const [pair, state] of Object.entries(result.pairs)) {
      console.log(`  ${pair.padEnd(12)} ${state}`);
    }
    if (result.note) console.log(`\n  NOTE: ${result.note}`);
    console.log(
      "\n  Reminder: create() needs a user gesture when a pack is 'downloadable',\n" +
        "  so a headless run can report that state but never resolve it. That is the\n" +
        "  platform, not the harness — and it is why Phase 1 owes a download UX.",
    );
  } finally {
    await engine.close();
  }
}

async function cmdRun(): Promise<void> {
  const corpusPath = process.argv[3];
  if (!corpusPath) throw new Error("usage: bakeoff run <corpus.jsonl> [engines] [target]");
  const engineNames = (process.argv[4] ?? "ondevice,deepl,llm,selfhosted").split(",");
  const target = process.argv[5] ?? "en";

  const corpus = loadCorpus(corpusPath);
  console.log(`corpus: ${corpus.length} messages`, summarise(corpus));

  const all: ScoredOutput[] = [];
  const dnt: Record<string, number[]> = {};
  const errors: Record<string, number> = {};

  for (const engine of selectEngines(engineNames)) {
    // Only the context-assisted tier sees context — PLAN.md §5.1.
    const prepared = prepare(corpus, target, { includeContext: engine.usesContext });
    process.stdout.write(`  ${engine.name} ... `);
    const outputs = await engine.translate(prepared.map((p) => p.item));
    const restored = restoreOutputs(prepared, outputs, engine.name);
    all.push(...restored);
    dnt[engine.name] = restored.map((r) => r.dntSurvival);
    errors[engine.name] = restored.filter((r) => r.error).length;
    console.log(`${restored.length} outputs, ${errors[engine.name]} errors`);
    if (engine instanceof OnDeviceEngine) await engine.close();
  }

  mkdirSync(OUT, { recursive: true });
  const prepared = prepare(corpus, target, { includeContext: false });
  const { sheet, key } = buildRatingSheet(prepared, all);

  writeFileSync(join(OUT, "outputs.json"), JSON.stringify({ all, dnt, errors }, null, 2));
  writeFileSync(join(OUT, "rating-sheet.csv"), sheet);
  writeFileSync(join(OUT, "rating-key.csv"), key);
  writeFileSync(join(OUT, "RATER-INSTRUCTIONS.txt"), RATER_INSTRUCTIONS);

  console.log(`\nwrote ${OUT}/rating-sheet.csv (blinded, shuffled)`);
  console.log(`      ${OUT}/rating-key.csv     (do not give this to raters)`);
  console.log(`      ${OUT}/RATER-INSTRUCTIONS.txt`);
  console.log("\nSend the sheet and instructions to a bilingual rater. §6 has the");
  console.log("paid fallback if that stalls — do not substitute an LLM judge for the");
  console.log("LLM tier, and do not substitute back-translation for any of it.");
}

function parseCsv(text: string): Record<string, string>[] {
  const [header, ...rows] = text.trim().split("\n");
  const cols = (header ?? "").split(",");
  return rows.map((row) => {
    const cells = row.match(/("([^"]|"")*"|[^,]*)/g)?.filter((_, i) => i % 2 === 0) ?? [];
    const out: Record<string, string> = {};
    cols.forEach((c, i) => {
      out[c.trim()] = (cells[i] ?? "").replace(/^"|"$/g, "").replaceAll('""', '"');
    });
    return out;
  });
}

async function cmdScore(): Promise<void> {
  const sheetPath = process.argv[3] ?? join(OUT, "rating-sheet.csv");
  const keyPath = process.argv[4] ?? join(OUT, "rating-key.csv");

  const sheet = parseCsv(readFileSync(sheetPath, "utf8"));
  const key = new Map(
    parseCsv(readFileSync(keyPath, "utf8")).map((r) => [
      r["row_id"] ?? "",
      { messageId: r["message_id"] ?? "", engine: r["engine"] ?? "" },
    ]),
  );

  const yes = (v: string | undefined): boolean => (v ?? "").trim().toLowerCase().startsWith("y");
  const ratings: Rating[] = [];
  for (const row of sheet) {
    const k = key.get(row["row_id"] ?? "");
    if (!k) continue;
    if ((row["meaning_preserved"] ?? "").trim() === "") continue; // unratable
    ratings.push({
      messageId: k.messageId,
      engine: k.engine,
      meaningPreserved: yes(row["meaning_preserved"]),
      registerPreserved: yes(row["register_preserved"]),
    });
  }

  let dnt: Record<string, number[]> = {};
  let errors: Record<string, number> = {};
  try {
    const raw = JSON.parse(readFileSync(join(OUT, "outputs.json"), "utf8")) as {
      dnt: Record<string, number[]>;
      errors: Record<string, number>;
    };
    dnt = raw.dnt;
    errors = raw.errors;
  } catch {
    // Scoring a hand-assembled sheet is fine; DNT just goes unreported.
  }

  const engines = [...new Set(ratings.map((r) => r.engine))];
  const scores: EngineScore[] = engines.map((e) => {
    const s = scoreEngine(e, ratings);
    const survivals = dnt[e];
    return {
      ...s,
      ...(survivals?.length
        ? { dntSurvival: survivals.reduce((a, b) => a + b, 0) / survivals.length }
        : {}),
      ...(errors[e] ? { errors: errors[e] } : {}),
    };
  });

  console.log(formatReport(scores));
}


/**
 * Phase 0b input. `collect <source> <file...>` — see collect.ts for why every
 * source is a file the platform's own client produced rather than an API call.
 */
async function cmdCollect(): Promise<void> {
  const kind = process.argv[3];
  const files = process.argv.slice(4);
  if (!kind || files.length === 0) {
    throw new Error(
      "usage: bakeoff collect <telegram|discord-html|text> <file...>\n\n" +
        "  telegram      result.json from the official Telegram Desktop export\n" +
        "  discord-html  a channel page saved from your own browser (Ctrl+S)\n" +
        "  text          one message per line\n\n" +
        "Env: PER_LANGUAGE (default 100), LANGUAGES (es,pt), SEED, MIN_CONFIDENCE\n\n" +
        "No account is automated and no platform API is called (PLAN.md §7).",
    );
  }

  const raws: RawMessage[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (kind === "telegram") raws.push(...reordinal(parseTelegramExport(text), raws.length));
    else if (kind === "text") raws.push(...reordinal(parseTextLines(text), raws.length));
    else if (kind === "discord-html") {
      // happy-dom rather than a regex: the adapter's contract is expressed as
      // selectors, and re-expressing it as string matching is how the two
      // drift apart. Imported lazily so `probe` and `score` do not need it.
      const { Window } = await import("happy-dom");
      const window = new Window();
      raws.push(
        ...reordinal(
          parseDiscordHtml(text, window.document as unknown as Document),
          raws.length,
        ),
      );
    } else throw new Error(`unknown source "${kind}"`);
  }

  const languages = (process.env["LANGUAGES"] ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);

  const result = await collect(raws, {
    perLanguage: Number(process.env["PER_LANGUAGE"] ?? 100),
    seed: Number(process.env["SEED"] ?? 1),
    minConfidence: Number(process.env["MIN_CONFIDENCE"] ?? 0.6),
    ...(languages.length > 0 ? { languages } : {}),
  });

  mkdirSync(OUT, { recursive: true });
  const corpusPath = join(OUT, "corpus.jsonl");
  const reviewPath = join(OUT, "corpus-needs-review.jsonl");

  // Before writing, not after. See collect.ts — this is the control, not a note.
  assertIgnored(corpusPath);
  assertIgnored(reviewPath);

  writeFileSync(corpusPath, formatCorpus(result.corpus, result.report, kind));
  if (result.review.length > 0) {
    writeFileSync(
      reviewPath,
      `// ${result.review.length} messages whose language could not be confidently detected.\n` +
        "// Fix the \"source\" field where it is wrong, delete what is unusable, then append\n" +
        "// the lines to corpus.jsonl. A guessed label measures the wrong thing: the engine\n" +
        "// is told the source language, so a mislabelled message blames it for obeying.\n" +
        result.review.map((m) => JSON.stringify(m)).join("\n") +
        "\n",
    );
  }

  console.log(formatCollectionReport(result.report));
  console.log(`\n  wrote ${corpusPath} (${result.corpus.length} messages)`);
  if (result.review.length > 0) console.log(`        ${reviewPath} (${result.review.length} to check)`);
  console.log(
    "\n  This file is other people's private messages. It is git-ignored, it should\n" +
      "  not be shared, and it should be deleted once 0b is decided (PLAN.md §5.2).",
  );
}

/**
 * Renumbers a file's messages so ordinals stay unique across several files.
 *
 * Without this, two exports both starting at 0 would interleave and a context
 * window could be built from a different conversation than the message it is
 * attached to — which would be invisible in the output and would quietly
 * corrupt the context-assisted tier.
 */
function reordinal(messages: readonly RawMessage[], offset: number): RawMessage[] {
  return messages.map((m, i) => ({ text: m.text, ordinal: offset + i }));
}

const commands: Record<string, () => Promise<void>> = {
  probe: cmdProbe,
  collect: cmdCollect,
  run: cmdRun,
  score: cmdScore,
};

const command = process.argv[2];
const handler = command ? commands[command] : undefined;

if (!handler) {
  console.error(
    "usage: bakeoff <probe|collect|run|score>\n\n" +
      "  probe [pairs]                     Phase 0a: what this machine can actually do\n" +
      "  collect <source> <file...>        build the 0b corpus from a client export\n" +
      "  run <corpus.jsonl> [engines]      translate + build a blinded rating sheet\n" +
      "  score [sheet] [key]               Wilson intervals and the coarse verdict\n",
  );
  process.exit(1);
}

handler().catch((error: unknown) => {
  console.error(String(error));
  process.exit(1);
});
