# Changelog

All notable changes to **Discord Mass Deleter** are documented here.

This project deletes **your own** Discord messages from a single channel/DM, an entire
server, or all your open DMs, from a small panel injected into the Discord web app.

**Credits:** original tool ("deleteDiscordMessages" / Undiscord) created by **victornpb**;
this release is improved from a fork maintained by **gen3vra**. Maintained here by **HoodedJustice**.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project aims to follow [Semantic Versioning](https://semver.org/).

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
