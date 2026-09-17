import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Loads a fixture by repo-relative path.
 *
 * Not `new URL(..., import.meta.url)`: under the happy-dom test environment
 * `import.meta.url` is an http URL, not a file one, and readFileSync rejects it.
 */
export const fixture = (name: string): string =>
  readFileSync(resolve(process.cwd(), "apps/extension/fixtures", name), "utf8");
