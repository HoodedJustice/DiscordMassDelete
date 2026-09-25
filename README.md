# Discord Mass Deleter

A userscript that lets you **mass-delete your own Discord messages** — from a single channel or
DM, an entire server, or all your open DMs — from a small panel added to the Discord web app.

> **Deletes only your own messages by default.** Bulk modes are opt-in and ask for confirmation.
> Use responsibly and at your own risk (see [Safety](#safety)).

**[⬇ Install](https://raw.githubusercontent.com/HoodedJustice/DiscordMassDelete/main/DiscordMassDelete.user.js)** ·
[Changelog](CHANGELOG.md)

---

## Features

- **Delete-scope switch** — choose exactly how much to delete:
  - **This channel / DM only** *(default, safest)*
  - **Whole server** — every channel & thread you can read
  - **All my open DMs** — the confirmation lists every DM by name first
- **Auto-follow** — the Guild/Channel IDs update live as you click around servers, channels and
  DMs. It locks automatically the moment you type an ID, start a run, or import a list.
- **Reliable** — pages through search results by message ID, so every message is handled once,
  nothing is skipped on large channels, and runs don't end early. Replies, pin notices and other
  deletable message types are included; pinned messages are kept unless you choose otherwise.
- **Recovers on its own** — retries network drops and Discord server errors, follows Discord's
  rate limits, and stops immediately on a Cloudflare block or an invalid token.
- **Live status** — Deleted · Skipped · Failed · Throttled · ETA, with a colour-coded progress bar
  (blue running, amber something skipped, red something failed, green done).
- **Filters** — author, date range (After/Before), message-ID range, text content, has-link,
  has-file, NSFW channels, include-pinned.
- **Comfortable panel** — matches Discord's light / dark theme, drag the header to move it, drag
  the corner to resize, **⟲ reset window** if it ever drifts. Remembers your filter settings
  (never your token or Author ID).
- **Always reachable** — a trash-can button in the channel toolbar, the **Ctrl+Alt+Shift+D**
  shortcut, and a floating button if Discord ever moves its toolbar.
- **Screenshot mode** hides tokens, IDs and message content before you share a screenshot.
- **Updates itself** through Tampermonkey / Violentmonkey. Works on Discord, PTB and Canary.

See [CHANGELOG.md](CHANGELOG.md) for everything that changed in each version.

---

## Install

1. Install a userscript manager: **[Tampermonkey](https://www.tampermonkey.net/)** or
   **[Violentmonkey](https://violentmonkey.github.io/)**.
2. Click **[Install](https://raw.githubusercontent.com/HoodedJustice/DiscordMassDelete/main/DiscordMassDelete.user.js)**
   — your userscript manager opens its install page. Click **Install**.
3. Open **discord.com/app**. A trash-can icon appears in the toolbar at the top of a channel —
   click it (or press **Ctrl+Alt+Shift+D**) to open the panel.

Updates are picked up automatically from then on.

> **Upgrading from 1.5?** Version 1.5 was installed from a differently named file, so it can't
> update itself. Remove "Discord Mass Deleter" 1.5 from your userscript manager's dashboard, then
> install 1.6 with the link above. You only need to do this once.

---

## Quick start

1. Open the channel or DM you want to clean (leave **Follow current channel** on so the IDs fill
   in automatically).
2. Open the panel. **Auth Token** and **Author ID** fill in automatically; if they don't, use the
   **get** buttons or paste them in.
3. Leave the scope on **This channel / DM only** for your first run.
4. Click **Start**, review the preview, and confirm.

- **Clear a whole server:** open the server, pick **Whole server**, click **Start**.
- **Clear all your DMs:** open the DMs you want in your sidebar, pick **All my open DMs**, click
  **Start** — the confirmation lists them by name.
- **Pinned messages** are kept unless you tick **Include pinned**.
- **Very long jobs:** use the **After / Before** dates to work through a large history in chunks
  (e.g. a year at a time), so each run is shorter and easy to pick up later.

---

## Safety

- Only **your own** messages are targeted by default (Author ID = you). Nothing here deletes
  other people's messages unless you deliberately leave Author blank in a channel you moderate —
  and that asks for explicit confirmation.
- Keep the built-in randomized delays. Sustained bulk deletion is exactly the pattern that can
  trigger stricter rate limits, so **go slow** and don't run it in more than one tab at a time.
- Your **token is a full account credential** — it is never saved or written to the log. Don't
  paste it anywhere else or share screenshots of it (use **Screenshot mode**).
- Automating actions on your account is a **grey area** under Discord's Terms of Service. Deleting
  your own messages is normal self-service, but you use this tool at your own risk.

---

## Credits

- **victornpb** — original creator of the tool ("deleteDiscordMessages" / **Undiscord**).
- **gen3vra** — maintained the fork this version was improved from.
- Maintained here by **HoodedJustice**.

## License

Released under the **MIT License**.
