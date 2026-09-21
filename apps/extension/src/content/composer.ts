/**
 * Writing into the message box.
 *
 * This is the part of outbound translation that is actually hard, and the
 * reason is worth stating plainly: **Discord's composer is a Slate editor, and
 * its value cannot be set by assigning DOM text.** Setting `textContent` or
 * `innerText` updates the visible DOM while React's model keeps the old value,
 * so the message that eventually sends is the one the user typed, not the
 * translation they approved. That failure is silent and it would send the wrong
 * text under their name — the exact outcome the whole review step exists to
 * prevent.
 *
 * The reliable path is to make the browser perform the edit, so the editor sees
 * real input events:
 *
 *   1. `execCommand("insertText")` — deprecated, still implemented everywhere
 *      that matters, and what every working userscript uses.
 *   2. A synthetic `paste` carrying the text, for editors that ignore (1).
 *
 * Both are attempted, and the result is *verified by reading the editor back*
 * rather than assumed. An insertion that silently failed must not look like one
 * that worked.
 */

export interface ComposerHandle {
  el: HTMLElement;
  /** Current text as the editor sees it. */
  read(): string;
  /** Replaces the whole contents. Returns false if the editor did not take it. */
  write(text: string): boolean;
}

function selectAll(el: HTMLElement): void {
  const doc = el.ownerDocument;
  const range = doc.createRange();
  range.selectNodeContents(el);
  const selection = doc.defaultView?.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function tryExecCommand(el: HTMLElement, text: string): boolean {
  const doc = el.ownerDocument as Document & {
    execCommand?: (command: string, ui?: boolean, value?: string) => boolean;
  };
  if (typeof doc.execCommand !== "function") return false;
  el.focus();
  selectAll(el);
  try {
    return doc.execCommand("insertText", false, text);
  } catch {
    return false;
  }
}

function tryPaste(el: HTMLElement, text: string): boolean {
  const view = el.ownerDocument.defaultView;
  if (!view || typeof view.DataTransfer !== "function") return false;

  el.focus();
  selectAll(el);

  const data = new view.DataTransfer();
  data.setData("text/plain", text);

  const event = new view.ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: data,
  });
  return el.dispatchEvent(event);
}

export function composerHandle(el: HTMLElement): ComposerHandle {
  const read = (): string => (el.textContent ?? "").trim();

  return {
    el,
    read,
    write(text: string): boolean {
      const before = read();

      if (tryExecCommand(el, text) && read() !== before) return true;
      if (tryPaste(el, text) && read() !== before) return true;

      // Read back rather than trusting the return value: both paths can report
      // success while the editor's model ignored them.
      return read() === text.trim();
    },
  };
}

/**
 * Formats the message that actually goes in the box.
 *
 * Appending the original is on by default, and it is the real mitigation for
 * outbound risk. Back-translation review cannot catch a fluent-but-wrong
 * translation — by construction, it is the failure that back-translates
 * fluently — but any bilingual reader in the channel sees both lines and
 * resolves it immediately. It costs nothing and it makes a bad translation
 * self-correcting instead of silently wrong.
 */
export function formatOutbound(
  translated: string,
  original: string,
  sourceLanguage: string,
  appendOriginal: boolean,
): string {
  if (!appendOriginal) return translated;
  return `${translated}\n\n> (${sourceLanguage.toUpperCase()}) ${original}`;
}
