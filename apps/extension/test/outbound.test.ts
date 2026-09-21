// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture } from "./fixture.js";
import { DiscordAdapter } from "../src/content/discord.js";
import { composerHandle, formatOutbound } from "../src/content/composer.js";
import { OutboundComposer, type OutboundDeps } from "../src/content/outbound.js";

const FIXTURE = fixture("discord-messages.html");

/**
 * happy-dom has no Slate editor, so the composer is a contenteditable div and
 * `execCommand` is stubbed to perform the edit the browser would. That is the
 * right level here: what these tests pin is the *protocol* — read back, never
 * send, report failure honestly — not Slate's internals, which only a real
 * browser can exercise.
 */
function installComposer(): HTMLElement {
  const form = document.createElement("form");
  const el = document.createElement("div");
  el.setAttribute("data-slate-editor", "true");
  el.setAttribute("contenteditable", "true");
  el.textContent = "are you coming tomorrow?";
  form.append(el);
  document.body.append(form);
  return el;
}

/** Simulates a browser that honours execCommand("insertText"). */
function stubExecCommand(behaviour: "works" | "ignored" = "works"): void {
  (document as Document & { execCommand?: unknown }).execCommand = (
    _cmd: string,
    _ui: boolean,
    value: string,
  ) => {
    if (behaviour === "works") {
      const el = document.querySelector<HTMLElement>("[data-slate-editor]");
      if (el) el.textContent = value;
      return true;
    }
    return false;
  };
}

beforeEach(() => {
  document.body.innerHTML = FIXTURE;
  delete (document as Document & { execCommand?: unknown }).execCommand;
});

describe("formatOutbound", () => {
  // The real mitigation for outbound risk: a bad translation becomes
  // self-correcting because any bilingual reader in the channel sees both.
  it("appends the original by default", () => {
    expect(formatOutbound("¿Vienes mañana?", "Are you coming tomorrow?", "en", true)).toBe(
      "¿Vienes mañana?\n\n> (EN) Are you coming tomorrow?",
    );
  });

  it("sends the translation alone when the user turns that off", () => {
    expect(formatOutbound("¿Vienes mañana?", "Are you coming tomorrow?", "en", false)).toBe(
      "¿Vienes mañana?",
    );
  });
});

describe("composerHandle", () => {
  it("reads the current text", () => {
    const el = installComposer();
    expect(composerHandle(el).read()).toBe("are you coming tomorrow?");
  });

  it("writes through execCommand where the browser honours it", () => {
    const el = installComposer();
    stubExecCommand("works");
    expect(composerHandle(el).write("¿vienes mañana?")).toBe(true);
    expect(el.textContent).toBe("¿vienes mañana?");
  });

  // The failure that matters: assigning DOM text updates the view while the
  // editor's model keeps the old value, so the message that sends is the one
  // the user typed rather than the translation they approved. Reporting false
  // is what lets the panel tell them to copy it manually instead.
  it("reports failure rather than pretending, when the editor ignores input", () => {
    const el = installComposer();
    stubExecCommand("ignored");
    expect(composerHandle(el).write("¿vienes mañana?")).toBe(false);
    expect(el.textContent).toBe("are you coming tomorrow?");
  });
});

describe("OutboundComposer", () => {
  const make = (over: Partial<OutboundDeps> = {}) => {
    const translate = vi.fn(async (_s: string, _t: string, text: string) => `ES(${text})`);
    const deps: OutboundDeps = {
      adapter: new DiscordAdapter(() => new URL("https://discord.com/channels/555/100")),
      doc: document,
      sourceLanguage: "en",
      targetLanguage: () => "es",
      translate,
      glossary: () => [],
      appendOriginal: () => true,
      ...over,
    };
    return { outbound: new OutboundComposer(deps), translate, deps };
  };

  const panelText = (): string =>
    document.querySelector("polyglot-outbound")?.shadowRoot?.querySelector(".panel")?.textContent ??
    "";

  const clickButton = (label: string): boolean => {
    const buttons = [
      ...(document
        .querySelector("polyglot-outbound")
        ?.shadowRoot?.querySelectorAll<HTMLButtonElement>("button") ?? []),
    ];
    const button = buttons.find((b) => b.textContent?.includes(label));
    button?.click();
    return Boolean(button);
  };

  it("does nothing when the message box is empty", async () => {
    const { outbound } = make();
    await outbound.open();
    expect(outbound.isOpen).toBe(false);
  });

  it("translates what is in the box and shows it for review", async () => {
    installComposer();
    const { outbound, translate } = make();
    await outbound.open();

    expect(translate).toHaveBeenCalledOnce();
    expect(panelText()).toContain("ES(are you coming tomorrow?)");
    expect(panelText()).toContain("review before sending");
  });

  // The single most important property in this file.
  it("never sends: no key events, no form submission, no send click", async () => {
    installComposer();
    stubExecCommand("works");

    const keys: string[] = [];
    document.addEventListener("keydown", (e) => keys.push(e.key));
    document.addEventListener("keypress", (e) => keys.push(e.key));
    const submit = vi.fn((e: Event) => e.preventDefault());
    document.querySelector("form")!.addEventListener("submit", submit);

    const { outbound } = make();
    await outbound.open();
    expect(clickButton("Put in message box")).toBe(true);

    expect(keys).toEqual([]);
    expect(submit).not.toHaveBeenCalled();
    // The translation is in the box, waiting for the user's own keystroke.
    expect(document.querySelector("[data-slate-editor]")?.textContent).toContain("ES(");
  });

  it("puts the original underneath when that setting is on", async () => {
    installComposer();
    stubExecCommand("works");
    const { outbound } = make({ appendOriginal: () => true });

    await outbound.open();
    clickButton("Put in message box");

    const written = document.querySelector("[data-slate-editor]")?.textContent ?? "";
    expect(written).toContain("> (EN) are you coming tomorrow?");
  });

  it("tells the user to copy manually when the editor refuses the write", async () => {
    installComposer();
    stubExecCommand("ignored");
    const { outbound } = make();

    await outbound.open();
    clickButton("Put in message box");

    expect(panelText()).toMatch(/copy it manually/);
  });

  it("refuses to guess a target language it has not observed", async () => {
    installComposer();
    const { outbound, translate } = make({ targetLanguage: () => null });
    await outbound.open();

    expect(translate).not.toHaveBeenCalled();
    expect(panelText()).toMatch(/No language detected/);
  });

  it("does not translate a channel that already reads my language", async () => {
    installComposer();
    const { outbound, translate } = make({ targetLanguage: () => "en" });
    await outbound.open();

    expect(translate).not.toHaveBeenCalled();
    expect(panelText()).toMatch(/already reads en/);
  });

  it("protects glossary terms in both the translation and the review pass", async () => {
    const el = installComposer();
    el.textContent = "ship Polyglot before friday";

    let sent = "";
    const { outbound } = make({
      glossary: () => ["Polyglot"],
      translate: async (_s, _t, text) => {
        sent = text;
        return text;
      },
    });

    await outbound.open();
    expect(sent).not.toContain("Polyglot");
    expect(panelText()).toContain("Polyglot");
  });

  describe("back-translation", () => {
    it("shows it as a rough check, never as a guarantee", async () => {
      installComposer();
      const { outbound } = make({
        backTranslate: async (_s, _t, text) => `EN(${text})`,
      });

      await outbound.open();
      expect(panelText()).toContain("Back-translation");
      // No green tick, and the limit stated: this is the failure mode it
      // cannot catch, and the panel has to say so.
      expect(panelText()).toMatch(/wrong translation that reads well/);
    });

    it("still offers the translation when the review pass fails", async () => {
      installComposer();
      const { outbound } = make({
        backTranslate: async () => {
          throw new Error("offline");
        },
      });

      await outbound.open();
      expect(panelText()).toContain("ES(are you coming tomorrow?)");
      expect(panelText()).not.toContain("Back-translation");
    });
  });

  describe("quota", () => {
    it("refuses to spend past the daily budget", async () => {
      installComposer();
      const { outbound, translate } = make({
        quota: { remaining: async () => 3, record: async () => {} },
      });

      await outbound.open();
      expect(translate).not.toHaveBeenCalled();
      expect(panelText()).toMatch(/budget spent/);
    });

    it("records what it spent", async () => {
      installComposer();
      const record = vi.fn(async () => {});
      const { outbound } = make({ quota: { remaining: async () => 10_000, record } });

      await outbound.open();
      expect(record).toHaveBeenCalledWith("are you coming tomorrow?".length);
    });
  });

  describe("hotkey", () => {
    it("opens on the hotkey and not on other keys", async () => {
      installComposer();
      const { outbound } = make();
      outbound.attach();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
      expect(outbound.isOpen).toBe(false);

      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "T", ctrlKey: true, shiftKey: true, bubbles: true }),
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(outbound.isOpen).toBe(true);

      outbound.detach();
      expect(outbound.isOpen).toBe(false);
    });
  });

  it("surfaces a translation failure instead of inserting anything", async () => {
    installComposer();
    stubExecCommand("works");
    const { outbound } = make({
      translate: async () => {
        throw new Error("pack evicted");
      },
    });

    await outbound.open();
    expect(panelText()).toMatch(/pack evicted/);
    expect(document.querySelector("[data-slate-editor]")?.textContent).toBe(
      "are you coming tomorrow?",
    );
  });
});
