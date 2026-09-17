import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * MV3 bundle.
 *
 * esbuild rather than WXT, which the plan names. WXT's value is its dev server
 * and HMR for content scripts; what this build needs is a predictable set of
 * output files matching a hand-written manifest, with no framework conventions
 * in between. Noted as a deliberate deviation — revisit when the iteration loop
 * starts hurting, which is the problem WXT actually solves.
 */
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "dist");
const watch = process.argv.includes("--watch");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  format: "esm",
  target: "chrome138",
  sourcemap: true,
  logLevel: "info",
};

await Promise.all([
  build({
    ...common,
    entryPoints: [resolve(here, "src/content/index.ts")],
    outfile: resolve(out, "content.js"),
  }),
  build({
    ...common,
    entryPoints: [resolve(here, "src/background/index.ts")],
    outfile: resolve(out, "background.js"),
  }),
  build({
    ...common,
    entryPoints: [resolve(here, "src/options/options.ts")],
    outfile: resolve(out, "options/options.js"),
  }),
]);

cpSync(resolve(here, "manifest.json"), resolve(out, "manifest.json"));
cpSync(resolve(here, "src/options/index.html"), resolve(out, "options/index.html"));

console.log(`built -> ${out}`);
if (watch) console.log("(watch mode is not wired yet; re-run to rebuild)");
