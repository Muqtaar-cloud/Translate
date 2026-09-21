import { conversationIdFrom, DiscordAdapter } from "../content/discord.js";
import {
  autoFor,
  clearConversationOverride,
  loadSettings,
  setConversationAuto,
} from "../shared/settings.js";

/**
 * Per-channel settings, reached from the toolbar icon.
 *
 * This lives in a popup rather than the options page because the setting is
 * about *here*: "translate this channel automatically" is a decision made while
 * looking at the channel, and making someone open a settings tab, find the
 * channel in a list and identify it by id would mean the feature never gets
 * used. The options page keeps the global settings; this keeps the local one.
 */
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** A readable name for a conversation key like `discord:555/100`. */
function label(conversationId: string): string {
  const [, path] = conversationId.split(":");
  if (!path) return conversationId;
  const [guild, channel] = path.split("/");
  return guild === "@me" ? `Direct message · ${channel}` : `Server ${guild} · channel ${channel}`;
}

async function currentConversation(): Promise<string | null> {
  // `tab.url` is readable without the broad "tabs" permission because the
  // manifest already holds a host permission for discord.com, which grants URL
  // visibility for exactly the tabs this needs and no others.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;

  const url = new URL(tab.url);
  if (!new DiscordAdapter(() => url).matches(url)) return null;

  const id = conversationIdFrom(url);
  return id === "discord:unknown" ? null : id;
}

async function renderOverrides(): Promise<void> {
  const settings = await loadSettings();
  const entries = Object.entries(settings.perConversation);
  const container = $("overrides");
  container.replaceChildren();

  if (entries.length === 0) {
    const none = document.createElement("span");
    none.className = "muted";
    none.textContent = "none";
    container.append(none);
    return;
  }

  for (const [id, { auto }] of entries) {
    const row = document.createElement("div");
    row.className = "override";

    const name = document.createElement("code");
    name.textContent = `${label(id)} — ${auto ? "on" : "off"}`;

    const reset = document.createElement("button");
    reset.textContent = "reset";
    reset.title = "Return this channel to the default (translate automatically)";
    reset.addEventListener("click", () => {
      void clearConversationOverride(id).then(render);
    });

    row.append(name, reset);
    container.append(row);
  }
}

async function render(): Promise<void> {
  const conversationId = await currentConversation();
  const channel = $("channel");
  const toggleRow = $("toggleRow");
  const state = $("state");

  if (!conversationId) {
    channel.textContent = "Not a Discord channel";
    toggleRow.hidden = true;
    state.textContent = "Open a Discord channel to change its setting.";
    await renderOverrides();
    return;
  }

  const settings = await loadSettings();
  const auto = autoFor(settings, conversationId);

  channel.textContent = label(conversationId);
  toggleRow.hidden = false;

  const checkbox = $<HTMLInputElement>("auto");
  checkbox.checked = auto;
  checkbox.onchange = () => {
    void setConversationAuto(conversationId, checkbox.checked).then(render);
  };

  state.textContent = auto
    ? `Translating into ${settings.target}. Hover any message to translate it on demand.`
    : "Off here. The hover button still works on individual messages.";

  await renderOverrides();
}

$("options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

void render();
