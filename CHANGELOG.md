# Changelog

All notable changes to **Discord Mass Deleter** are documented here.

This project deletes **your own** Discord messages from a single channel/DM, an entire
server, or all your open DMs, from a small panel injected into the Discord web app.

**Credits:** original tool ("deleteDiscordMessages" / Undiscord) created by **victornpb**;
this release is improved from a fork maintained by **gen3vra**. Maintained here by **HoodedJustice**.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project aims to follow [Semantic Versioning](https://semver.org/).

---

## [1.6] — 2026-09-25

A reliability release. v1.5 could quietly leave messages behind while reporting that it had
finished; v1.6 rewrites the search and paging engine so a run only ends once every message it can
delete is gone. Tested against a mock Discord API with 154 automated checks. On the same
300-message test channel, **v1.5 deleted 112 of 217 deletable messages; v1.6 deleted all 217.**

### ⚠️ Behaviour changes

- **Pinned messages are now kept unless you tick "Include pinned".** The checkbox used to have no
  effect on normal messages, so pinned messages were always deleted. It now does what it says.
- **The script file is renamed to `DiscordMassDelete.user.js` and now updates itself** through
  Tampermonkey / Violentmonkey. If you installed 1.5, remove it and install 1.6 from the link in
  the README. This is a one-time step; later versions arrive automatically.

### Fixed

- **Replies were never deleted.** Replies are their own message type, and the old filter treated
  them as system messages and skipped them. The filter now uses Discord's list of deletable types.
- **Runs ended early and left messages behind.** A message that couldn't be deleted — or one that
  still showed in Discord's search results just after being deleted — came back on every page, was
  counted as a failure again, and pushed the run to "finished" too soon. Search now pages by
  message ID instead of by offset: every message is handled exactly once, search-index lag can't
  cause repeats, and there is no offset ceiling on very large channels.
- **One network hiccup or Discord server error ended the whole channel.** Searches and deletes now
  retry with back-off (up to 5 times) before giving up.
- **Memory grew on long runs.** The engine is now a loop instead of recursion, so a whole-server
  run over thousands of pages no longer keeps every page in memory.
- **"Already deleted" responses were counted as failures.** They now count as deleted.
- **Stop** takes effect within a fraction of a second, even during a rate-limit wait. Start stays
  locked (the button reads "Stopping…") until the run has actually wound down, instead of
  re-enabling immediately and then ignoring clicks.
- **The log was wiped after every page and its scrollbar was hidden.** It now keeps the last 500
  lines and shows a thin scrollbar, so earlier pages and per-channel summaries stay readable.
- **The time estimate never went down.** It's now based on what is left, not the grand total.
- **Skipped and failed are separate.** Pinned, system and archived-thread messages count as
  skipped (amber bar) rather than failed (red bar).
- **The resize corner felt backwards.** The panel is now anchored by its left edge, so the corner
  follows the mouse, and it's pulled back on-screen if the browser window shrinks.
- **The token "get" button could fail when opening the panel worked.** Both now use the same
  detection, with a second fallback method.
- **Author ID is read straight from the token**, so it no longer depends on Discord's internal
  modules (those remain as a fallback).
- **Opening the panel overwrote a hand-typed target.** It now refills the IDs only while
  "Follow current channel" is on.
- **Cloudflare handling:** Cloudflare's temporary 502/503 error pages are no longer mistaken for a
  block (they're retried). Real blocks — 1015 rate limiting and 1020 access denied — stop the
  whole queue immediately, and so does an invalid or expired token.
- **Log safety:** API error responses are escaped before being shown in the log.

### Added

- **Live status line** — Deleted · Skipped · Failed · Throttled · ETA, plus "Target 3/12" during
  bulk runs and an overall summary when they finish.
- **Clearer bulk confirmations** — "All my open DMs" lists the DMs by name, "Whole server" shows
  the server's name, and a blank Author ID says "EVERYONE" instead of "you".
- **Screenshot mode** now also blurs the 📍 location line (it showed server and channel IDs).
- **Keyboard shortcut:** Ctrl+Alt+Shift+D opens and closes the panel. The toolbar button also
  works with Enter / Space.
- **Floating button fallback:** if Discord changes its toolbar and the button can't be placed
  there, it appears in the bottom-right corner instead, so the panel can always be opened.
- **Automatic updates** via `@updateURL` / `@downloadURL`.
- **Discord PTB and Canary** support.
- The confirmation preview shows display names (no more `name#0`) and shortens long messages.
- A short pause between targets in bulk runs.
- `@noframes`, and the toolbar watcher now reacts at most once per frame instead of on every
  change Discord makes to the page.

### Notes

- The engine intentionally stays on `/api/v6`, where `retry_after` is in milliseconds.
- Messages that can't be deleted are listed as failed at the end of the run — run it again to
  retry them.

---

## [1.5] — 2026-09-21

The biggest release since the fork: a proper **delete-scope switch**, **live channel
auto-follow**, a **resizable/movable window**, and a batch of correctness & safety fixes.
No functionality from earlier versions was removed.

### Added

- **Delete-scope switch** — a clear, mutually-exclusive selector under the Guild/Channel
  fields. Every bulk mode is opt-in; the default is the safe one:
  - **This channel / DM only** *(default)* — deletes only the channel or DM you have selected.
  - **Whole server** — sweeps every channel & thread you can read in the current server
    (runs the guild-wide search with `channel_id` omitted). Refuses to run from a DM.
  - **All my open DMs** — fetches your open DM / group-DM list and clears each one.
  - Picking a bulk mode greys out the Channel ID box and requires a single up-front
    confirmation that names exactly what will be deleted.
- **Auto-follow navigation** — the Guild/Channel IDs now update live as you click around
  servers, channels and DMs (Discord is a single-page app, so the URL changes without a
  reload). Implemented by patching `history.pushState`/`replaceState` + `popstate` with a
  lightweight poll as a safety net.
  - A **Follow current channel** toggle (on by default) controls it.
  - It **auto-locks** the instant you hand-edit an ID, start a run, or import a list, so a
    deliberate target is never overwritten.
  - A `📍 Server › channel` line shows where the fields currently point.
- **Resizable & movable window**
  - Drag the **header** to move it; drag the **bottom-right corner** to resize.
  - **⟲ reset window** button (and **double-click the header**) restores the default
    position and size.
  - The panel **snaps back on-screen every time it's opened**, so it can't get lost.
  - The form area scrolls when cramped and the log is guaranteed usable space.
- **Native theming** — the panel now uses Discord's own CSS variables, so it matches
  light, dark and custom themes instead of being hardcoded black.
- **Remember settings** — non-sensitive fields (filters, dates, checkboxes) persist between
  opens. The **auth token and Author ID are never saved**, and the scope always resets to
  "single," so a bulk mode can never persist by accident.
- **Load all open DMs** in one action (via `GET /users/@me/channels`, keeping direct DMs
  and group DMs).
- **Inline help tooltips** on each section (hover the `?`), replacing external doc links.
- **Screenshot safety** — the token field now carries the `priv` attribute so it is also
  masked in screenshot/redact mode.

### Fixed

- **Multi-channel / bulk runs only processed the first target.** The Start loop reset the
  stop flag *inside* the loop, so every channel after the first aborted immediately. Bulk
  DM/server runs now work. The loop uses `try/finally`, resets the buttons exactly once, and
  a real **Stop** halts the entire queue.
- **UI could get permanently wedged.** A Cloudflare `1015` block (or any non-JSON error
  body) returned HTML; calling `.json()` on it threw and, with no guard, left Start hidden
  until a page reload. Response bodies are now read defensively; a Cloudflare/global limit is
  detected and the run stops cleanly instead of hammering the API.
- **Opening the panel on Home/Friends crashed setup.** The URL regex could return `null`,
  throwing before the token/author were filled. All URL parsing is now guarded.
- **Fragile token/author auto-detection** no longer throws — the webpack lookups are wrapped
  and fall back to a "paste it manually" message.
- **Malformed search responses** are handled instead of throwing mid-run.
- **Rate-limit backoff hardened** — a missing `retry_after` can no longer collapse the delay,
  and delete retries are capped so a permanently limited message can't loop forever.
- **Date-range accuracy** — message-ID (snowflake) conversion now uses `BigInt`, fixing the
  precision loss that made the After/Before filters off by thousands of milliseconds.
- **File import fixed** — the import listener was registered *inside* the Start handler, so
  importing did nothing until Start was clicked once and then leaked a listener per click. It
  is now registered once, and it no longer force-overwrites your Guild ID.
- **Double-click safety** — a re-entrancy guard prevents two overlapping runs from starting.

### Changed

- Blank **Author ID** now shows an explicit confirmation (it deletes *everyone's* messages —
  a moderator purge) instead of silently proceeding. The capability is kept, but made
  deliberate.
- Disabled buttons are now **dimmed** instead of hidden, so controls stop appearing and
  disappearing mid-run.

### Notes & known limitations

- **Large channels:** Discord's message-search API caps pagination (roughly ~10k results /
  ~5k offset). For any channel with more than a few thousand of your messages, use the
  **After/Before** date range to clear it in chunks (e.g. one year at a time).
- **All open DMs** covers DMs that are currently open in your sidebar; reopen a closed DM to
  include it.
- **Auto-detection is best-effort.** Discord's internals change over time; if the token or
  Author ID can't be grabbed automatically, paste them in manually.
- **API version:** the engine intentionally stays on `/api/v6`, where `retry_after` is in
  milliseconds (matching the timing math). A future move to `/api/v9`/`v10` must convert
  `retry_after` from seconds in the same change, or the delays would collapse.
- Auto-follow turns itself off after a run or an import (so it can't clobber your next
  target) — re-check **Follow current channel** to resume live tracking.

---

## [1.4] and earlier

Earlier versions predate this repository and come from the upstream fork maintained by
**gen3vra**, which is itself based on the original **deleteDiscordMessages** / **Undiscord**
by **victornpb**. Those releases focused on the core deletion engine: message search with
offset paging, per-message deletion, adaptive rate-limit backoff, archived-thread handling,
system-message skipping, date/ID ranges, content/link/file/NSFW/pinned filters, and the
original injected UI.

---

## Disclaimer

This tool automates actions against your own account. Deleting your own messages is normal
self-service, but heavy bulk automation is a grey area under Discord's Terms of Service — go
slow, keep the built-in delays, and use it at your own risk. It only targets your own
messages by default and never touches other users' messages unless you deliberately run a
blank-Author moderator purge in a channel you manage.
