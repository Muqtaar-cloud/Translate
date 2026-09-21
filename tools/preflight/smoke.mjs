/**
 * Loads the preflight page in real Chromium and drives it.
 *
 * happy-dom has no Translator API and no layout, so the only way to know this
 * page tells the truth is to run it in the browser it is about.
 */
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const url = `file://${resolve(here, "index.html")}`;

// The full Chromium binary, not the headless shell: the built-in AI APIs are
// absent from the shell, so it would report a false negative about the very
// thing this page exists to measure.
const executablePath =
  process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const browser = await chromium.launch({
  executablePath,
  headless: false,
  args: ["--headless=new", "--no-sandbox"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

await page.goto(url);
await page.waitForSelector("#verdict strong");

const initial = {
  verdict: await page.locator("#verdict strong").textContent(),
  envRows: await page.locator("#env .row").count(),
  translatorPresent: await page.evaluate(() => "Translator" in globalThis),
  checkboxes: await page.locator("#langs input").count(),
};

await page.locator("#check").click();
await page.waitForFunction(
  () => !document.querySelector("#pairs .state.dim"),
  null,
  { timeout: 20000 },
).catch(() => {});

const after = {
  pairRows: await page.locator("#pairs .row").count(),
  states: await page.locator("#pairs .state").allTextContents(),
  verdict: await page.locator("#verdict strong").textContent(),
  downloadButtons: await page.locator("#pairs button").count(),
  summary: await page.locator("#summary").textContent(),
};

// A friend mistyping a code is the likeliest error path in this page, and
// availability() throws on an unknown code rather than returning a state.
await page.locator("#extra").fill("zzz");
await page.locator("#check").click();
await page.waitForFunction(() => !document.querySelector("#pairs .state.dim"), null, { timeout: 20000 }).catch(() => {});
const bogus = {
  rows: await page.locator("#pairs .row").count(),
  hasNotOffered: (await page.locator("#pairs .state").allTextContents()).includes("not offered"),
  verdict: await page.locator("#verdict strong").textContent(),
};

// Put it back the way it was for the reported result.
await page.locator("#extra").fill("");
await page.locator("#check").click();
await page.waitForFunction(() => !document.querySelector("#pairs .state.dim"), null, { timeout: 20000 }).catch(() => {});

console.log("Preflight smoke test\n");
console.log(`  initial verdict:   ${initial.verdict}`);
console.log(`  environment rows:  ${initial.envRows}`);
console.log(`  Translator API:    ${initial.translatorPresent}`);
console.log(`  language choices:  ${initial.checkboxes}`);
console.log(`  pair rows:         ${after.pairRows}`);
console.log(`  pair states:       ${after.states.join(", ")}`);
console.log(`  download buttons:  ${after.downloadButtons}`);
console.log(`  verdict after:     ${after.verdict}`);
console.log(`  bad code handled:  ${bogus.hasNotOffered ? "yes" : "NO"} -> "${bogus.verdict}"`);
console.log(`\n  --- summary block ---\n${after.summary.split("\n").map((l) => "  " + l).join("\n")}`);
if (errors.length) console.log(`\n  errors: ${errors.join("; ")}`);

// Four preselected languages, minus none (target is en), so four pairs.
const ok =
  after.pairRows === 4 &&
  after.states.every((s) => s !== "…") &&
  after.summary.includes("translator") &&
  after.summary.includes("es->en") &&
  bogus.rows === 5 &&
  bogus.hasNotOffered &&
  errors.length === 0;

console.log(`\n  ${ok ? "PASS" : "FAIL"}`);
await browser.close();
process.exit(ok ? 0 : 1);
