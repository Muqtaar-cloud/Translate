import type { Availability, LanguageCode, TranslationRequest } from "./types.js";

/**
 * Where a message should go. Every arm is terminal — there is no implicit
 * fallthrough, which is the whole point (see `needs-pack-download`).
 */
export type Route =
  | { kind: "skip"; reason: "known-language" | "too-short" | "undetected" }
  | { kind: "on-device"; source: LanguageCode; target: LanguageCode }
  | {
      kind: "needs-pack-download";
      source: LanguageCode;
      target: LanguageCode;
      state: Extract<Availability, "downloadable" | "downloading">;
    }
  | { kind: "cloud-mt"; provider: string; source: LanguageCode; target: LanguageCode }
  | { kind: "unsupported"; source: LanguageCode; target: LanguageCode };

export interface RoutingPolicy {
  knownLanguages: readonly LanguageCode[];
  cloudEnabled: boolean;
  cloudProvider?: string;
  /**
   * Injected, per PLAN.md §11: the package must not assume an on-device
   * provider exists. A consumer with no built-in Translator (the bot, §8)
   * supplies a function that always returns "unavailable".
   */
  availability: (source: LanguageCode, target: LanguageCode) => Availability;
}

/**
 * PLAN.md §4.3.
 *
 * The `downloadable` / `downloading` arm is safety-critical. Chrome reports
 * four availability states; collapsing them to a boolean means a user who has
 * enabled cloud translation but has not yet clicked through a language-pack
 * download would silently have their messages sent to DeepL — on the automatic
 * path, for a pair that was about to be free and local. That is exactly the
 * event §5 exists to bound, and it would be reached by falling through a table
 * rather than by anyone deciding it. So it returns its own terminal route and
 * the caller must prompt.
 */
export function route(req: TranslationRequest, policy: RoutingPolicy): Route {
  const { source, target } = req;

  if (policy.knownLanguages.includes(source)) {
    return { kind: "skip", reason: "known-language" };
  }

  const availability = policy.availability(source, target);

  if (availability === "available") {
    return { kind: "on-device", source, target };
  }

  if (availability === "downloadable" || availability === "downloading") {
    return { kind: "needs-pack-download", source, target, state: availability };
  }

  // availability === "unavailable" — only now may cloud be considered.
  if (policy.cloudEnabled && policy.cloudProvider) {
    return { kind: "cloud-mt", provider: policy.cloudProvider, source, target };
  }

  return { kind: "unsupported", source, target };
}

/** True when taking this route sends message content off the device (PLAN.md §5). */
export function leavesDevice(r: Route): boolean {
  return r.kind === "cloud-mt";
}
