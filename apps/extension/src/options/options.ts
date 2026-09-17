import { DEFAULT_SETTINGS, loadApiKey, loadSettings, saveApiKey, saveSettings } from "../shared/settings.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const known = $<HTMLInputElement>("known");
const target = $<HTMLInputElement>("target");
const cloud = $<HTMLInputElement>("cloud");
const cloudDms = $<HTMLInputElement>("cloudDms");
const deeplKey = $<HTMLInputElement>("deeplKey");
const status = $<HTMLSpanElement>("status");

const parseList = (value: string): string[] =>
  value.split(",").map((s) => s.trim()).filter(Boolean);

async function render(): Promise<void> {
  const settings = await loadSettings();
  known.value = settings.knownLanguages.join(", ");
  target.value = settings.target;
  cloud.checked = settings.cloudEnabled;
  cloudDms.checked = settings.cloudInDirectMessages;
  deeplKey.value = (await loadApiKey("deepl")) ?? "";

  const stored = await chrome.storage.local.get("polyglot.counters");
  const counters = (stored["polyglot.counters"] as Record<string, number>) ?? {};
  const rows = Object.entries(counters)
    .filter(([k]) => k.startsWith("availability.") || k.startsWith("pair."))
    .sort()
    .map(([k, v]) => `${k.padEnd(34)} ${v}`);
  $("counters").textContent = rows.length > 0 ? rows.join("\n") : "none yet";
}

$("save").addEventListener("click", () => {
  void (async () => {
    await saveSettings({
      ...DEFAULT_SETTINGS,
      ...(await loadSettings()),
      knownLanguages: parseList(known.value),
      target: target.value.trim() || "en",
      cloudEnabled: cloud.checked,
      cloudProvider: "deepl",
      cloudInDirectMessages: cloudDms.checked,
    });
    if (deeplKey.value.trim() !== "") await saveApiKey("deepl", deeplKey.value.trim());
    status.textContent = "saved";
    setTimeout(() => (status.textContent = ""), 1500);
  })();
});

void render();
