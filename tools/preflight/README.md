# Preflight

A single self-contained page that answers one question before anyone installs
anything: **can this browser translate chat messages on its own machine?**

Open `index.html` in the browser being tested. No build, no dependencies, no
network calls of its own.

## Why it exists

The extension fails closed. If the on-device path is unavailable, the only
fallback is a cloud provider with the user's own API key, which nobody
installing a tool from a friend is going to set up. So the difference between
"works" and "does nothing at all" is decided before install, by facts about the
machine — and 0a measured that *nothing* is `available` on a fresh profile
(PLAN.md §4.1). Without this page, a friend's first sign that their machine
cannot run it is a chat window that stays stubbornly untranslated.

## What it checks

1. **Browser and platform.** Chromium desktop only; Firefox and Safari have no
   equivalent API.
2. **`Translator` and `LanguageDetector` presence.**
3. **Per-pair `availability()`** for the languages the person actually reads.
4. **An actual download**, on a click — the only definitive check.

That last point matters. Chrome's documented requirements (~22 GB free disk,
16 GB RAM, 4+ cores) gate the *download*, not the presence of the API: this
project measured both APIs present on a machine nowhere near those numbers
(PLAN.md §4.1). So `availability()` returning `downloadable` is an offer, not a
promise. A completed download is the promise.

## It also warms the packs

Language packs are a browser-level resource, not per-site data, so a pack
downloaded here is the same pack the extension finds later. Downloading two or
three languages on this page is the closest thing to "pick your languages at
install time" that the platform allows — the extension itself cannot do it,
because `create()` needs a user gesture and there is no install-time gesture to
hang it on.

Worth confirming once on a real profile rather than taking it on trust:
download a pack here, then open the extension's options page and look at the
availability counters.

## The summary block

The page prints a copyable summary — browser, platform, API presence, per-pair
results. No message content, no personal data. Collected from a handful of real
machines it is the evidence PLAN.md §2 asks for and has never had: what share
of people can actually run the free path. That question gates whether the
4–8 week public-release process is worth starting at all.

## Testing it

```
node tools/preflight/smoke.mjs
```

Drives the page in real Chromium: renders, checks four pairs, handles an
invalid language code, and produces a summary. It needs the full Chromium
binary rather than the headless shell, which has no built-in AI APIs and would
report a false negative about the very thing being measured.
