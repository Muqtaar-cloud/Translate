/** A message as it reaches an engine: already DNT-masked (PLAN.md §6). */
export interface EngineItem {
  id: string;
  /** Masked text. Placeholders must come back untouched. */
  masked: string;
  source: string;
  target: string;
  /**
   * Preceding messages, oldest first. Only the context-assisted tier receives
   * this, and only because the bake-off's LLM tier models a user-initiated
   * escalation — PLAN.md §5.1 forbids context on the automatic path.
   */
  context?: string[];
}

export interface EngineOutput {
  id: string;
  output: string;
  error?: string;
}

export interface Engine {
  readonly name: string;
  /** Whether this engine receives thread context (PLAN.md §5.1, §6). */
  readonly usesContext: boolean;
  translate(items: EngineItem[]): Promise<EngineOutput[]>;
}

/** Small concurrency limiter — engines are rate-limited and this is a batch job. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      const item = items[i];
      if (item === undefined) return;
      results[i] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}
