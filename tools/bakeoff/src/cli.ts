#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

const commands: Record<string, () => Promise<void>> = {
  probe: cmdProbe,
  run: cmdRun,
  score: cmdScore,
};

const command = process.argv[2];
const handler = command ? commands[command] : undefined;

if (!handler) {
  console.error(
    "usage: bakeoff <probe|run|score>\n\n" +
      "  probe [pairs]                     Phase 0a: what this machine can actually do\n" +
      "  run <corpus.jsonl> [engines]      translate + build a blinded rating sheet\n" +
      "  score [sheet] [key]               Wilson intervals and the coarse verdict\n",
  );
  process.exit(1);
}

handler().catch((error: unknown) => {
  console.error(String(error));
  process.exit(1);
});
