# Discord Mass Deleter 

A userscript that lets you **mass-delete your own Discord messages** — from a single
channel or DM, an entire server, or all your open DMs — from a small panel injected into the
Discord web app.

> **Deletes only your own messages by default.** Bulk modes are opt-in and ask for
> confirmation. Use responsibly and at your own risk (see [Safety](#safety)).

---

## Features

- **Delete-scope switch** — choose exactly how much to delete:
  - **This channel / DM only** *(default, safest)*
  - **Whole server** — every channel & thread you can read
  - **All my open DMs**
- **Auto-follow** — the Guild/Channel IDs update live as you click around servers, channels
  and DMs; a **Follow current channel** toggle turns it on/off and it auto-locks the moment
  you edit a field or start a run.
- **Resizable, movable window** — drag the header to move, drag the corner to resize, and a
  **⟲ reset** button (or double-click the header) if it ever drifts. It always opens on-screen.
- **Native theming** — matches Discord's light / dark / custom themes.
- **Filters** — by author, date range (After/Before), message ID range, text content,
  has-link, has-file, NSFW channels, and include-pinned.
- **Safer by design** — one up-front confirmation for bulk runs, adaptive rate-limit backoff,
  Cloudflare/global-limit detection that stops cleanly, and randomized human-like delays.
- **Remembers your filter settings** between opens — but **never** your token or Author ID.
- **Screenshot mode** to hide sensitive info before sharing.

See [CHANGELOG.md](CHANGELOG.md) for the full feature and fix list.

---

## Install

1. Install a userscript manager: **[Tampermonkey](https://www.tampermonkey.net/)** or
   **[Violentmonkey](https://violentmonkey.github.io/)**.
2. Open your userscript manager's dashboard → **Create a new script**.
3. Delete the template, paste the full contents of the `.user.js` file from this repo, and
   **Save**.
4. Open **discord.com/app** in your browser. A trash-can icon appears in the toolbar near the
   top of a channel — click it to open the panel.

> Tip: you can also enable one-click install/updates by opening the raw `.user.js` file on
> GitHub (the **Raw** button) — Tampermonkey/Violentmonkey will offer to install it.

---

## Quick start

1. Open the channel or DM you want to clean (leave **Follow current channel** on so the IDs
   fill in automatically).
2. Click the toolbar icon to open the panel. **Auth Token** and **Author ID** auto-fill; if
   they don't, use the **get** buttons or paste them manually.
3. Leave the scope on **This channel / DM only** for your first run.
4. Click **Start**, review the confirmation preview, and confirm.

**To clear a whole server:** open the server, pick **Whole server**, click **Start**.
**To clear all your DMs:** pick **All my open DMs** (make sure the DMs you want are open in
your sidebar first), click **Start**.

**Big channel?** Discord's search only pages back so far, so for channels with many thousands
of your messages, use the **After/Before** date range to delete a year at a time.

---

## Safety

- Only **your own** messages are targeted by default (Author ID = you). Nothing here deletes
  other people's messages unless you deliberately run a blank-Author purge in a channel you
  moderate — which asks for explicit confirmation.
- Keep the built-in randomized delays. Sustained bulk deletion is exactly the pattern that
  can trigger stricter rate limits, so **go slow** and don't run multiple copies in parallel.
- Your **token is a full account credential** — it is never saved to disk or logged in plain
  text. Don't paste it anywhere else or share screenshots of it (use **Screenshot mode**).
- Automating actions on your account is a **grey area** under Discord's Terms of Service.
  Deleting your own messages is normal self-service, but you use this tool at your own risk.

---

## Credits

- **victornpb** — original creator of the tool ("deleteDiscordMessages" / **Undiscord**).
- **gen3vra** — maintained the fork this version was improved from.
- Maintained here by **HoodedJustice**.

## License

Released under the **MIT License**.
