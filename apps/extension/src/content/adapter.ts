/**
 * The only platform-specific surface (PLAN.md §4.1 of v1, kept through the
 * rewrites). Detection, routing, caching, the render loop and the layer are all
 * shared; a new platform is an implementation of this and nothing else.
 *
 * v1 ships exactly one implementation. Four adapters was the single biggest
 * scope error in the first plan, because each one is a permanent maintenance
 * cost against an unversioned, obfuscated, frequently-shipped web app.
 */

export interface ExtractedMessage {
  /** Stable per-message id from the platform. */
  id: string;
  /** Body text only: no embeds, no quoted reply, no timestamp. */
  text: string;
  /** Present when the platform exposes it; used for per-author language stickiness. */
  author?: string;
  /** (guild, channel) or equivalent — settings and dominant language key off this. */
  conversationId: string;
}

export interface PlatformAdapter {
  readonly name: string;
  /** Does this adapter handle the current page? */
  matches(url: URL): boolean;
  /** The scrolling container to observe. Null when the app hasn't rendered it yet. */
  observeRoot(doc: Document): Element | null;
  /** All currently mounted message elements, in document order. */
  findMessages(root: Element): HTMLElement[];
  /** Pull the translatable body out of a message element. */
  extract(el: HTMLElement): ExtractedMessage | null;
  /** Where the translation layer goes relative to the message. */
  injectionPoint(el: HTMLElement): { parent: Element; before: Node | null } | null;
  /**
   * The message box, when the platform has one on screen.
   *
   * Separate from the message list because outbound is a separate feature with
   * a separate failure mode: a broken adapter here means a translation is
   * silently dropped instead of being sent.
   */
  findComposer(doc: Document): HTMLElement | null;
  /**
   * Cheap health check (PLAN.md §10). Run on load: if the page looks like this
   * platform but the adapter finds nothing, the selectors have rotted and the
   * user must be told, rather than silently getting an extension that does
   * nothing.
   */
  selfCheck(doc: Document): AdapterHealth;
}

export interface AdapterHealth {
  ok: boolean;
  rootFound: boolean;
  messagesFound: number;
  extractableFound: number;
  detail: string;
}
