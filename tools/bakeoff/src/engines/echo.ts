import type { Engine, EngineItem, EngineOutput } from "./types.js";

/**
 * Pipeline smoke test. NOT a translation candidate.
 *
 * It returns the masked input unchanged, which lets you validate the whole
 * run -> sheet -> score path (and eyeball the rating sheet) before spending a
 * penny on real API calls or a rater's afternoon. Never put it in front of a
 * rater: a bilingual rater would correctly score it near zero, which tells you
 * nothing you did not already know.
 */
export class EchoEngine implements Engine {
  readonly name = "echo-pipeline-check";
  readonly usesContext = false;

  async translate(items: EngineItem[]): Promise<EngineOutput[]> {
    return items.map((i) => ({ id: i.id, output: i.masked }));
  }
}
