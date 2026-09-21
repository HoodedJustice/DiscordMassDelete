// ==UserScript==
// @name          Discord Mass Deleter
// @description   Mass-delete your OWN Discord messages from a single channel/DM, a whole server, or all your DMs. Scope switch, auto-follow, resizable UI, safer rate-limit handling.
// @namespace     https://github.com/HoodedJustice/DiscordMassDelete
// @version       1.5
// @match         https://discord.com/*
// @grant         none
// @license       MIT
// ==/UserScript==

/*
 * Discord Mass Deleter
 * ----------------------------------------------------------------------------
 * Credits
 *   - Original tool ("deleteDiscordMessages" / Undiscord) created by victornpb.
 *   - Improved from a fork maintained by gen3vra.
 * MIT licensed. Deletes only your own messages by default. See CHANGELOG.md for
 * the full feature and fix list.
 * ----------------------------------------------------------------------------
 */

/**
 * Delete all messages in a Discord channel or DM
 * @param {string} authToken Your authorization token
 * @param {string} authorId Author of the messages you want to delete
 * @param {string} guildId Server were the messages are located
 * @param {string} channelId Channel were the messages are located (leave blank with a real guildId to sweep the whole server)
 * @param {string} minId Only delete messages after this, leave blank do delete all
 * @param {string} maxId Only delete messages before this, leave blank do delete all
 * @param {string} content Filter messages that contains this text content
 * @param {boolean} hasLink Filter messages that contains link
 * @param {boolean} hasFile Filter messages that contains file
 * @param {boolean} includeNsfw Search in NSFW channels
 * @param {function(string, Array)} extLogger Function for logging
 * @param {function} stopHndl stopHndl used for stopping
 * @param {boolean} askConfirm When true (default) the engine shows its own preview confirm; the UI sets it false for mass runs that already confirmed once
 * @see README.md / CHANGELOG.md for usage and options.
 */
async function deleteMessages(authToken, authorId, guildId, channelId, minId, maxId, content, hasLink, hasFile, includeNsfw, includePinned, extLogger, stopHndl, onProgress, askConfirm = true) {
    const start = new Date();
    const ArchivedThreads = new Set();
    let deleteDefault = Math.floor(Math.random() * (2000 - 1000 + 1) + 1000);
    let deleteDelay = deleteDefault;
    let randomizeDelay = true;
    let searchDelay = Math.floor(Math.random() * (2000 - 1000 + 1) + 1000);
    let delCount = 0;
    let archivedSkipCount = 0;
    let failCount = 0;
    let avgPing;
    let lastPing;
    let grandTotal;
    let throttledCount = 0;
    let throttledTotalTime = 0;
    let offset = 0;
    let iterations = -1;
    let ended = false;
    let failInRow = 0;
    let successInRow = 0;

    const wait = async ms => new Promise(done => setTimeout(done, ms));
    const msToHMS = s => `${s / 3.6e6 | 0}h ${(s % 3.6e6) / 6e4 | 0}m ${(s % 6e4) / 1000 | 0}s`;
    const escapeHTML = html => html.replace(/[&<"']/g, m => ({'&': '&amp;', '<': '&lt;', '"': '&quot;', '\'': '&#039;'})[m]);
    const redact = str => `<span class="priv">${escapeHTML(str)}</span><span class="mask">REDACTED</span>`;
    const queryString = params => params.filter(p => p[1] !== undefined).map(p => p[0] + '=' + encodeURIComponent(p[1])).join('&');
    const ask = async msg => new Promise(resolve => setTimeout(() => resolve(window.confirm(msg)), 10));
    const printDelayStats = () => log.verb(`Delete delay: ${deleteDelay}ms, Search delay: ${searchDelay}ms`, `Last Ping: ${lastPing}ms, Average Ping: ${avgPing | 0}ms`);
    // BigInt-safe snowflake conversion (ms * 2^22 overflows Number, silently rounding off the low bits)
    const toSnowflake = (date) => {
        if (!/[:T]/.test(date)) return date;          // already a raw snowflake id
        const ms = new Date(date).getTime();
        if (isNaN(ms)) return date;
        return ((BigInt(ms) - 1420070400000n) << 22n).toString();
    };

    // Read a response body ONCE and try to parse it as JSON. A Cloudflare 1015 block or a
    // gateway error returns HTML, so calling resp.json() directly would throw and (with no
    // guard upstream) wedge the whole run. This never throws.
    const readBody = async (resp) => {
        let t = '';
        try { t = await resp.text(); } catch { }
        let j = null;
        try { j = JSON.parse(t); } catch { }
        return { t, j };
    };
    const isCloudflareBlock = (t, resp) => /error code:? ?101\d/i.test(t || '') ||
        (((resp.headers.get('content-type') || '').includes('text/html')) && /cloudflare|attention required/i.test(t || ''));

    const log = {
        debug() {extLogger ? extLogger('debug', arguments) : console.debug.apply(console, arguments);},
        info() {extLogger ? extLogger('info', arguments) : console.info.apply(console, arguments);},
        verb() {extLogger ? extLogger('verb', arguments) : console.log.apply(console, arguments);},
        warn() {extLogger ? extLogger('warn', arguments) : console.warn.apply(console, arguments);},
        error() {extLogger ? extLogger('error', arguments) : console.error.apply(console, arguments);},
        success() {extLogger ? extLogger('success', arguments) : console.info.apply(console, arguments);},
    };

    async function recurse() {
        let API_SEARCH_URL;
        if (guildId === '@me') {
            API_SEARCH_URL = `https://discord.com/api/v6/channels/${channelId}/messages/`; // DMs
        }
        else {
            API_SEARCH_URL = `https://discord.com/api/v6/guilds/${guildId}/messages/`; // Server
        }

        const headers = {
            'Authorization': authToken
        };

        let resp;
        try {
            const s = Date.now();
            resp = await fetch(API_SEARCH_URL + 'search?' + queryString([
                ['author_id', authorId || undefined],
                ['channel_id', (guildId !== '@me' && channelId) ? channelId : undefined],
                ['min_id', minId ? toSnowflake(minId) : undefined],
                ['max_id', maxId ? toSnowflake(maxId) : undefined],
                ['sort_by', 'timestamp'],
                ['sort_order', 'desc'],
                ['offset', offset],
                ['has', hasLink ? 'link' : undefined],
                ['has', hasFile ? 'file' : undefined],
                ['content', content || undefined],
                ['include_nsfw', includeNsfw ? true : undefined],
            ]), {headers});
            lastPing = (Date.now() - s);
            avgPing = avgPing > 0 ? (avgPing * 0.9) + (lastPing * 0.1) : lastPing;
        } catch (err) {
            return log.error('Search request threw an error:', err);
        }

        // Not indexed yet
        if (resp.status === 202) {
            const { j } = await readBody(resp);
            const w = (j && j.retry_after) || 1000;
            throttledCount++;
            throttledTotalTime += w;
            log.warn(`This channel wasn't indexed, waiting ${w}ms for discord to index it...`);
            await wait(w);
            return await recurse();
        }

        if (!resp.ok) {
            // Searching messages too fast
            if (resp.status === 429) {
                const { t, j } = await readBody(resp);
                if (isCloudflareBlock(t, resp)) {
                    return log.error('Cloudflare is rate-limiting your IP (error 1015). This is an IP-level block, NOT a normal Discord limit. STOP and wait ~1 hour before retrying — hammering it risks your account.');
                }
                if (j && j.global) log.warn('GLOBAL rate limit hit while searching — you are being limited account-wide. Consider stopping.');
                const w = (j && j.retry_after) || 1000;
                throttledCount++;
                throttledTotalTime += w;
                searchDelay = w * 1.1; // set delay
                log.warn(`Discord said don't search for ${w}ms!`);
                printDelayStats();

                //this seems like a bug in the original script
                //await wait(w * 2);
                await wait(searchDelay);
                return await recurse();
            } else {
                const { j } = await readBody(resp);
                return log.error(`Error searching messages, API responded with status ${resp.status}!\n`, j);
            }
        }

        const data = await resp.json();
        if (!data || !Array.isArray(data.messages)) {
            // NB: end() is a const declared further down (TDZ) — match the other early error returns in recurse() instead
            return log.error('Unexpected search response (no messages array):', data);
        }
        const total = data.total_results;
        if (!grandTotal) grandTotal = total;
        const discoveredMessages = data.messages
            .map(convo => convo.find(message => message.hit === true))
            .filter(Boolean);
        // filter out system messages and optionally pinned ones
        let messagesToDelete = discoveredMessages.filter(msg => {
            return msg.type === 0 || msg.type === 6 || (msg.pinned && includePinned);
        });
        // skip message if in archived thread
        messagesToDelete = messagesToDelete.filter(msg => {
            if (ArchivedThreads.has(msg.channel_id)) {
                log.verb(`Skipping message in archived thread ${msg.channel_id}`);
                return false;
            }
            return true;
        });
        const skippedMessages = discoveredMessages.filter(msg => !messagesToDelete.find(m => m.id === msg.id));
        // count skipped messages as not deleted
        failCount += skippedMessages.length;
        const archivedCount = skippedMessages.filter(msg => ArchivedThreads.has(msg.channel_id)).length;
        const systemCount = skippedMessages.length - archivedCount;
        archivedSkipCount += archivedCount;
        // signal progress UI that undeletable messages were found
        if (skippedMessages.length > 0) {
            try {if (onProgress) onProgress(delCount, grandTotal || 1, true);} catch (e) { }
        }

        const end = () => {
            if (ended)
                return;
            log.success(`Ended at ${new Date().toLocaleString()}! Total time: ${msToHMS(Date.now() - start.getTime())}`);
            // unnecessary
            // printDelayStats();
            log.verb(`Rate Limited: ${throttledCount} times. Total time throttled: ${msToHMS(throttledTotalTime)}.`);
            log.debug(`Deleted ${delCount} messages, ${failCount} failed.\n`);
            ended = true;
        }

        const isRunComplete = () => (delCount + failCount) >= grandTotal;

        const deletableMessages = grandTotal - archivedSkipCount;
        const etr = msToHMS((searchDelay * Math.round(deletableMessages / 25)) + ((deleteDelay + avgPing) * deletableMessages));
        // systemCount already computed above when updating counters
        log.info(`Total messages found: ${data.total_results}`,
            `(Hits: ${data.messages.length}, Delete: ${messagesToDelete.length}, Skipped: ${skippedMessages.length} (system ${systemCount}))`,
            `offset: ${offset}`);
        printDelayStats();
        log.verb(`Estimated time remaining: ${etr}`)

        if (messagesToDelete.length > 0) {

            if (askConfirm && ++iterations < 1) {
                log.verb(`Waiting for your confirmation...`);
                const previewMessages = messagesToDelete; // [...messagesToDelete].reverse(); (use if you want the preview to match discords ui)
                if (!await ask(`Do you want to delete ~${total} messages?\nEstimated time: ${etr}\n\n---- Preview ----\n` +
                    previewMessages.map(m => `${m.author.username}#${m.author.discriminator}: ${m.attachments.length ? '[ATTACHMENTS]' : m.content}`).join('\n')))
                    return end(log.error('Aborted by you!'));
                log.verb(`OK`);
            }

            for (let i = 0; i < messagesToDelete.length; i++) {
                const message = messagesToDelete[i];
                // if already marked, skip
                if (ArchivedThreads.has(message.channel_id)) {
                    log.verb(`Skipping message in archived thread ${message.channel_id}`);
                    continue;
                }
                if (stopHndl && stopHndl() === false) return end(log.error('Stopped by you!'));

                // Too big to read, too much information to be useful to end user
                // if you care about individual IDs being deleted or your username, there ya go:
                //log.debug(`${((delCount + 1) / grandTotal * 100).toFixed(2)}% (${delCount + 1}/${grandTotal})` + `Delete ID:${redact(message.id)} <b>${redact(message.author.username + '#' + message.author.discriminator)} <small>(${redact(new Date(message.timestamp).toLocaleString())})</small>:</b> <i>${redact(message.content).replace(/\n/g, '↵')}</i>`, message.attachments.length ? redact(JSON.stringify(message.attachments)) : '');
                const processed = delCount + failCount;
                log.debug(`${((processed + 1) / grandTotal * 100).toFixed(2)}% (${processed + 1}/${grandTotal})` + ` | <b>DEL</b> <small>(${redact(new Date(message.timestamp).toLocaleDateString() + " - " + new Date(message.timestamp).toLocaleTimeString())})</small>: ${redact(message.content).replace(/\n/g, '↵')}`, message.attachments.length ? redact(JSON.stringify(message.attachments)) : '');

                let resp;
                try {
                    const s = Date.now();
                    const API_DELETE_URL = `https://discord.com/api/v6/channels/${message.channel_id}/messages/${message.id}`;
                    resp = await fetch(API_DELETE_URL, {
                        headers,
                        method: 'DELETE'
                    });
                    lastPing = (Date.now() - s);
                    avgPing = (avgPing * 0.9) + (lastPing * 0.1);
                } catch (err) {
                    log.error('Delete request throwed an error:', err); // Too long to be read in the console
                    log.verb('Related object:', redact(JSON.stringify(message))); // Too long to be read in the console
                    failCount++;
                    if (i < messagesToDelete.length - 1) {
                        await wait(deleteDelay);
                    }
                    continue;
                }

                if (!resp.ok) {
                    // failed
                    const { t: rawText, j: err } = await readBody(resp);

                    failInRow++;
                    successInRow = 0;
                    randomizeDelay = false;

                    // Cloudflare IP block masquerading as a 429 with an HTML body — stop immediately.
                    if (isCloudflareBlock(rawText, resp)) {
                        return end(log.error('Cloudflare 1015 IP block hit during delete. Stopping now to protect your account. Wait ~1 hour before retrying.'));
                    }

                    // Thread archived or can't be opened due to missing permissions or rate limits (Program can't discern between the two)
                    if ((resp.status === 400 && err?.code === 50083) ||
                        (resp.status === 403 && err?.message && /archiv/i.test(err.message)) ||
                        (resp.status === 404 && err?.message && /archiv/i.test(err.message))) {
                        log.warn(`Archived thread detected (status ${resp.status}${err?.code ? ', code ' + err.code : ''}), marking channel ${message.channel_id} as archived`);
                        ArchivedThreads.add(message.channel_id);
                        continue;
                    }

                    // deleting messages too fast
                    else if (resp.status === 429) {
                        if (err && err.global) log.warn('GLOBAL rate limit during delete — slowing down hard.');
                        const w = (err && err.retry_after) || 1000; // v6 reports ms; guard against a missing value (which would collapse the backoff)
                        log.warn(`Failed to delete - Discord said go away for ${w}ms!`);

                        throttledCount++;
                        throttledTotalTime += w;

                        var multi = 1.632;
                        //increase delay if deleteDelay is less
                        if (w * 1.532 > deleteDelay)
                            deleteDelay = w * multi;
                        else {
                            // we would get caught in a loop
                            deleteDelay = deleteDelay * 0.94812;
                            if (deleteDelay < w)
                                deleteDelay = w * multi;
                            log.warn("Delete delay is already greater than wait time. Reduce instead.");
                        }

                        printDelayStats();

                        await wait(deleteDelay);
                        // retry, but cap so a permanently-limited message can't loop forever
                        message.__retries = (message.__retries || 0) + 1;
                        if (message.__retries <= 30) {
                            i--;
                        } else {
                            log.error('Giving up on a message after 30 rate-limit retries.');
                            failCount++;
                        }
                    }
                    //nonspecific error handler
                    else {
                        log.error(`Error deleting message, API responded with status ${resp.status}!`, err);
                        log.verb('Related object:', redact(JSON.stringify(message)));
                        failCount++;
                    }
                }
                else {
                    // success
                    failInRow = 0;
                    successInRow++;
                    delCount++;
                    // update progress after a successful delete
                    try {if (onProgress) onProgress(delCount, grandTotal || 1);} catch (e) { }
                    if (randomizeDelay) {
                        deleteDefault = Math.floor(Math.random() * (2000 - 1000 + 1) + 1000);
                        deleteDelay = deleteDefault;
                    }
                    // make sure we eventually speed back up
                    if (successInRow > 4 && deleteDelay > deleteDefault && !randomizeDelay) {
                        deleteDelay = deleteDelay * 0.94812;
                        log.verb(`Lowering delay to ${deleteDelay}ms`);
                    }
                    else if (deleteDelay < deleteDefault) {
                        deleteDefault = Math.floor(Math.random() * (2000 - 1000 + 1) + 1000);
                        deleteDelay = deleteDefault;
                        randomizeDelay = true;
                        log.verb(`Default delay, ${deleteDefault}.`);
                    }
                }

                if (i < messagesToDelete.length - 1) {
                    await wait(deleteDelay);
                }
            }

            if (skippedMessages.length > 0) {
                /*grandTotal -= skippedMessages.length;*/
                offset += skippedMessages.length;
                log.verb(`Found ${skippedMessages.length} system messages! Increasing offset to ${offset}.`);
            }

            if (isRunComplete()) {
                return end();
            }

            log.verb(`Searching next messages in ${searchDelay}ms...`, (offset ? `(offset: ${offset})` : ''));

            deleteDefault = Math.floor(Math.random() * (2000 - 1000 + 1) + 1000);
            deleteDelay = deleteDefault;
            searchDelay = Math.floor(Math.random() * (2000 - 1000 + 1) + 1000);
            // Turn back on randomize since we are searching next page anyway
            randomizeDelay = true;

            await wait(searchDelay);
            if (logArea) logArea.innerHTML = '';

            if (stopHndl && stopHndl() === false) return end(log.error('Cancelled by you!'));

            return await recurse();
        } else {
            // Nothing on this page could be deleted (either system or archived)
            if (skippedMessages.length > 0) {
                const archivedCount = skippedMessages.filter(msg => ArchivedThreads.has(msg.channel_id)).length;
                const systemCount = skippedMessages.length - archivedCount;
                log.verb(`No deletables on this page (${systemCount} system, ${archivedCount} archived). Advancing offset by ${skippedMessages.length}.`);
                offset += skippedMessages.length;
                if (isRunComplete()) {
                    return end();
                }
                if (offset >= total) {
                    return end();
                }
                log.verb(`Searching next messages in ${searchDelay}ms...`, `(offset: ${offset})`);
                await wait(searchDelay);
                return await recurse();
            }
            if (total - offset > 0) {
                log.warn('API returned an empty page. Searching next page.');
                offset += 25;
                log.verb(`Searching next messages in ${searchDelay}ms...`, `(offset: ${offset})`);
                await wait(searchDelay);
                await recurse();
                return end();
            } else {
                log.warn("(Total - offset) < 0, ending.");
                return end();
            }
        }
    }

    log.success(`\nStarted at ${start.toLocaleString()}`);
    log.debug(`authorId="${redact(authorId)}" guildId="${redact(guildId)}" channelId="${redact(channelId)}" minId="${redact(minId)}" maxId="${redact(maxId)}" hasLink=${!!hasLink} hasFile=${!!hasFile}`);
    ended = false;
    try {if (onProgress) onProgress(0, 1);} catch (e) { }
    return await recurse();
}

//---- User interface ----//

let popover;
let btn;
let stop;
let logArea;
let version = "1.5";

function initUI() {

    const insertCss = (css) => {
        const style = document.createElement('style');
        style.appendChild(document.createTextNode(css));
        document.head.appendChild(style);
        return style;
    }

    const createElm = (html) => {
        const temp = document.createElement('div');
        temp.innerHTML = html;
        return temp.removeChild(temp.firstElementChild);
    }

    insertCss(`
        #undicord-btn{position: relative; height: 24px;width: auto;-webkit-box-flex: 0;-ms-flex: 0 0 auto;flex: 0 0 auto;margin: 0 8px;cursor:pointer; color: var(--interactive-normal);}
        #undiscord{position:fixed;top:60px;right:10px;width:min(780px, calc(100vw - 20px));height:min(72vh, calc(100vh - 80px));min-width:320px;min-height:220px;max-width:calc(100vw - 12px);max-height:calc(100vh - 24px);z-index:99;color:var(--text-normal,lightgrey);background-color:var(--background-primary,black);box-shadow:var(--elevation-stroke),var(--elevation-high);border-radius:8px;display:flex;flex-direction:column;overflow:hidden;resize:both}
        #undiscord a{color:#00b0f4}
        #undiscord .help{color:#00b0f4;cursor:help;font-weight:bold}
        #undiscord.redact .priv{display:none!important}
        #undiscord:not(.redact) .mask{display:none!important}
        #undiscord.redact [priv]{-webkit-text-security:disc!important}
        #undiscord .toolbar span{margin-right:8px}
        #undiscord button,#undiscord .btn{color:#fff;background:#7289da;border:0;border-radius:4px;font-size:14px;cursor:pointer;padding:0 12px;height:28px}
        #undiscord button:disabled{opacity:.4;cursor:not-allowed;filter:grayscale(.35)}
        #undiscord input[type="text"],#undiscord input[type="search"],#undiscord input[type="password"],#undiscord input[type="datetime-local"]{background-color:var(--input-background,#202225);color:var(--text-normal,#b9bbbe);border-radius:4px;border:1px solid var(--input-border,transparent);padding:0 .5em;height:28px;width:144px;margin:2px}
        #undiscord input#file{display:none}
        #undiscord hr{border-color:rgba(255,255,255,0.1)}
        #undiscord .header{padding:12px 16px;background-color:var(--background-tertiary);color:var(--text-muted)}
        #undiscord .form{padding:8px;background:var(--background-secondary);box-shadow:0 1px 0 rgba(0,0,0,.2),0 1.5px 0 rgba(0,0,0,.05),0 2px 0 rgba(0,0,0,.05);flex:0 1 auto;overflow:auto}
        #undiscord .logarea{overflow:auto;font-size:.75rem;font-family:Consolas,Liberation Mono,Menlo,Courier,monospace;flex:1 1 auto;min-height:90px;padding:10px;color:var(--text-normal,#dcddde);margin:0}
        #undiscord .scopeBox{margin:4px 2px;padding:6px 8px;border:1px solid var(--input-border,#40444b);border-radius:4px}
        #undiscord .scopeBox .scopeTitle{font-size:.72rem;color:var(--text-muted,#72767d);margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em}
        #undiscord .scopeBox label{display:block;cursor:pointer;line-height:1.6}
        #undiscord .scopeBox label.mass{color:#faa61a}
        #undiscord progress.complete { accent-color: #43b581; }
        #undiscord progress.incomplete { accent-color: #f04747; }
        #undiscord progress.pending { accent-color: #5865f2; }
        /* also style the small progress inside the toolbar button */
        #undicord-btn progress.complete { accent-color: #43b581; }
        #undicord-btn progress.incomplete { accent-color: #f04747; }
        #undicord-btn progress.pending { accent-color: #5865f2; }
        .logarea { scrollbar-width: none;}
        `);

    popover = createElm(`
    <div id="undiscord" role="dialog" aria-label="Discord Mass Deleter" style="display:none;">
        <div class="header">
            <button id="resetWin" title="Reset the window to its default position and size" style="float:right;background:#4f545c;height:22px;padding:0 8px;font-size:12px;">⟲ reset window</button>
            🌹 Discord Mass Deleter ${version}
            <div style="font-size:11px;color:var(--text-muted);font-weight:400;margin-top:2px;">Deletes only your own messages. Default scope is the channel/DM you have open. Bulk modes are opt-in — go slow. Drag the header to move · drag the bottom-right corner to resize.</div>
        </div>
        <div class="form">
            <div style="display:flex;flex-wrap:wrap;">
                <span>Authorization <span class="help" title="Your Discord user token — used to authenticate the API calls. Click 'get' to auto-fill it from this tab. Never share it.">?</span> <button id="getToken">get</button><br>
                    <input type="password" id="authToken" placeholder="Auth Token" autocomplete="off" priv autofocus>*<br>
                    <span>Author <span class="help" title="The user whose messages get deleted. Click 'get' to auto-fill YOUR own ID. Leave blank to delete every author's messages (moderator purge — you will be asked to confirm).">?</span> <button id="getAuthor">get</button></span>
                    <br><input id="authorId" type="text" placeholder="Author ID" priv></span>
                <span>Guild/Channel <span class="help" title="Guild ID + Channel ID of the target. Use @me as the Guild ID for DMs. Turn on 'Follow current channel', or click 'get' to fill from the channel you're viewing.">?</span>
                    <button id="getGuildAndChannel">get</button><br>
                    <input id="guildId" type="text" placeholder="Guild ID" priv><br>
                    <input id="channelId" type="text" placeholder="Channel ID" priv><br>
                    <div class="scopeBox">
                        <div class="scopeTitle">Delete scope</div>
                        <label><input type="radio" name="scope" value="single" checked> This channel / DM only</label>
                        <label class="mass"><input type="radio" name="scope" value="server"> Whole server (all channels &amp; threads)</label>
                        <label class="mass"><input type="radio" name="scope" value="dms"> All my open DMs</label>
                    </div>
                    <label><input id="followChannel" type="checkbox" checked> Follow current channel</label>
                    <div id="currentLoc" style="font-size:.72rem;color:#b9bbbe;margin:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px;"></div>
                    <label><input id="includeNsfw" type="checkbox">NSFW Channel</label><br><br>
                    <label for="file" title="Import list of channels from messages/index.json file"> Import: <span
                            class="btn">...</span> <input id="file" type="file" accept="application/json,.json"></label>
                </span><br>
                <span>Range <span class="help" title="Only delete messages after / before a date or message ID. Leave blank to delete everything. Use the date pickers, or paste raw message IDs.">?</span><br>
                    <input id="minDate" type="datetime-local" title="After" style="width:auto;"><br>
                    <input id="maxDate" type="datetime-local" title="Before" style="width:auto;"><br>
                    <input id="minId" type="text" placeholder="After message with Id" priv><br>
                    <input id="maxId" type="text" placeholder="Before message with Id" priv><br>
                </span>
                <span>Search messages <span class="help" title="Narrow what gets deleted: containing text, has a link, has a file, and whether to include pinned messages.">?</span><br>
                    <input id="content" type="text" placeholder="Containing text" priv><br>
                    <label><input id="hasLink" type="checkbox">has: link</label><br>
                    <label><input id="hasFile" type="checkbox">has: file</label><br>
                    <label><input id="includePinned" type="checkbox">Include pinned</label>
                </span>
            </div>
            <hr>
            <button id="start" style="background:#43b581;width:80px;">Start</button>
            <button id="stop" style="background:#f04747;width:80px;" disabled>Stop</button>
            <button id="clear" style="width:80px;">Clear log</button>
            <label><input id="autoScroll" type="checkbox" checked>Auto scroll</label>
            <label title="Hide sensitive information for taking screenshots"><input id="redact" type="checkbox">Screenshot
                mode</label>
            <progress id="progress" aria-label="Deletion progress" style="display:none;"></progress> <span class="percent"></span>
        </div>
        <pre class="logarea">
            <center>Discord Mass Deleter ${version} 🌹  ·  original by victornpb  ·  improved from gen3vra's fork
            </center>
        </pre>
    </div>
    `);

    document.body.appendChild(popover);

    btn = createElm(`<div id="undicord-btn" tabindex="0" role="button" aria-label="Delete Messages" title="Delete Messages">
    <svg aria-hidden="false" width="24" height="24" viewBox="0 0 24 24">
        <path fill="currentColor" d="M15 3.999V2H9V3.999H3V5.999H21V3.999H15Z"></path>
        <path fill="currentColor" d="M5 6.99902V18.999C5 20.101 5.897 20.999 7 20.999H17C18.103 20.999 19 20.101 19 18.999V6.99902H5ZM11 17H9V11H11V17ZM15 17H13V11H15V17Z"></path>
    </svg>
    <br><progress style="display:none; width:24px;"></progress>
</div>`);

    btn.onclick = function togglePopover() {
        if (popover.style.display !== 'none') {
            popover.style.display = 'none';
            btn.style.color = 'var(--interactive-normal)';
        }
        else {
            popover.style.display = '';
            btn.style.color = '#f04747';

            // always bring the panel back on-screen at its default anchor + size when opened,
            // clearing any left/top/width/height left behind by a previous drag or resize
            resetWin();

            // user experience over extra unneeded security
            // let's grab all needed details when opening (guarded so opening on Home/Friends can't crash)
            const m = location.href.match(/channels\/([\w@]+)\/(\d+)/);
            if (m) {
                $('input#guildId').value = m[1];
                $('input#channelId').value = m[2];
            }

            // token
            try {
                window.dispatchEvent(new Event('beforeunload'));
                const iframe = document.createElement('iframe');
                $('input#authToken').value = JSON.parse(document.body.appendChild(iframe).contentWindow.localStorage.token);
                iframe.remove();
            } catch (err) {
                console.warn('Undiscord: could not auto-grab token — paste it manually.', err);
            }

            // author id
            try {
                webpackChunkdiscord_app.push([
                    [Math.random()],
                    {},
                    (r) => {
                        for (const mod of Object.keys(r.c)) {
                            try {
                                const exp = r.c[mod].exports;
                                if (exp?.default?.getUsers || exp?.getUsers) {
                                    const users = (exp.default || exp).getUsers();
                                    const user = Object.values(users).find(u => u.email);
                                    if (user) {
                                        $('input#authorId').value = user.id;
                                        return;
                                    }
                                }
                            } catch { }
                        }
                    }
                ]);
            } catch (err) {
                console.warn('Undiscord: could not auto-grab author id — paste it manually.', err);
            }

        };
    }

    function mountBtn() {
        const toolbar = document.querySelector('[class*="toolbar"]');
        if (toolbar)
            toolbar.appendChild(btn);
    }

    const observer = new MutationObserver(function (_mutationsList, _observer) {
        if (!document.body.contains(btn)) mountBtn(); // re-mount the button to the toolbar
    });
    observer.observe(document.body, {attributes: false, childList: true, subtree: true});

    mountBtn();

    const $ = s => popover.querySelector(s);
    logArea = $('pre');
    const startBtn = $('button#start');
    const stopBtn = $('button#stop');
    const autoScroll = $('#autoScroll');

    // ---- make the panel draggable by its header ----
    (function makeDraggable(handle, panel) {
        let sx, sy, sl, st, dragging = false;
        handle.style.cursor = 'move';
        handle.style.userSelect = 'none';
        handle.addEventListener('mousedown', ev => {
            if (ev.target.closest('button,input,a,label')) return;
            const r = panel.getBoundingClientRect();
            panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px';
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
            sx = ev.clientX; sy = ev.clientY; sl = r.left; st = r.top;
            dragging = true; ev.preventDefault();
        });
        window.addEventListener('mousemove', ev => {
            if (!dragging) return;
            const x = Math.min(Math.max(0, sl + ev.clientX - sx), window.innerWidth - 120);
            const y = Math.min(Math.max(0, st + ev.clientY - sy), window.innerHeight - 40);
            panel.style.left = x + 'px'; panel.style.top = y + 'px';
        });
        window.addEventListener('mouseup', () => dragging = false);
    })($('.header'), popover);

    // ---- reset the window to its default anchor + size (recovers an off-screen / oversized panel) ----
    function resetWin() {
        popover.style.left = '';
        popover.style.top = '';
        popover.style.right = '10px';
        popover.style.bottom = '';
        popover.style.width = '';
        popover.style.height = '';
    }
    const resetWinBtn = $('#resetWin');
    if (resetWinBtn) resetWinBtn.onclick = resetWin;
    $('.header').addEventListener('dblclick', ev => { if (!ev.target.closest('button,input,a')) resetWin(); });

    // ---- scope switch: grey the Channel ID box when a mass mode is picked ----
    const applyScopeUi = () => {
        const scope = (popover.querySelector('input[name="scope"]:checked') || {}).value || 'single';
        const cf = $('input#channelId');
        const dim = (scope !== 'single');
        cf.disabled = dim;
        cf.style.opacity = dim ? 0.4 : 1;
    };
    popover.querySelectorAll('input[name="scope"]').forEach(r => r.addEventListener('change', applyScopeUi));
    applyScopeUi();

    // ---- one-time file import (was previously registered inside Start, which leaked listeners) ----
    const fileSelection = $('input#file');
    fileSelection.addEventListener('change', () => {
        const files = fileSelection.files;
        if (!files || !files.length) return;
        files[0].text().then(text => {
            try {
                const json = JSON.parse(text);
                const keys = Object.keys(json);
                $('input#channelId').value = keys.join(',');
                // leave Guild ID untouched (v1.4 behaviour) so a server-channel export still works;
                // set it to @me yourself for a DM export, or the server id for a guild export
                const single = popover.querySelector('input[name="scope"][value="single"]');
                if (single) { single.checked = true; applyScopeUi(); }
                window.__undiscord_setFollow && window.__undiscord_setFollow(false);
                logArea.insertAdjacentHTML('beforeend', '<div style="color:#72767d">Imported ' + keys.length + ' channels. Set Guild ID to @me (DM export) or the server ID (server export) before Start.</div>');
            } catch (e) {
                logArea.insertAdjacentHTML('beforeend', '<div style="color:#f04747">Could not parse index.json</div>');
            }
        });
    }, false);

    // ---- fetch every open DM / group-DM channel id (used by the "All my open DMs" scope) ----
    async function fetchAllDmIds(authToken) {
        try {
            const resp = await fetch('https://discord.com/api/v6/users/@me/channels', { headers: { 'Authorization': authToken } });
            if (resp.status === 429) {
                let j = null; try { j = await resp.json(); } catch { }
                window.alert(`Rate limited loading DMs — try again in ~${Math.ceil((j && j.retry_after || 1000) / 1000)}s.`);
                return null;
            }
            if (!resp.ok) { window.alert(`Failed to load DMs (HTTP ${resp.status}).`); return null; }
            const chans = await resp.json();
            if (!Array.isArray(chans)) { window.alert('Unexpected response loading DMs.'); return null; }
            return chans.filter(c => c.type === 1 || c.type === 3).map(c => c.id); // 1 = DM, 3 = group DM
        } catch (err) {
            window.alert('Error loading DMs: ' + err);
            return null;
        }
    }

    let runInProgress = false;
    startBtn.onclick = async e => {
        if (runInProgress) return; // ignore double-clicks and re-entry (the "All my open DMs" scope awaits a fetch before the buttons lock)
        runInProgress = true;
        try {
        const authToken = $('input#authToken').value.trim();
        const authorId = $('input#authorId').value.trim();
        const guildId = $('input#guildId').value.trim();
        const minId = $('input#minId').value.trim();
        const maxId = $('input#maxId').value.trim();
        const minDate = $('input#minDate').value.trim();
        const maxDate = $('input#maxDate').value.trim();
        const content = $('input#content').value.trim();
        const hasLink = $('input#hasLink').checked;
        const hasFile = $('input#hasFile').checked;
        const includeNsfw = $('input#includeNsfw').checked;
        const includePinned = $('input#includePinned').checked;
        const progress = $('#progress');
        const progress2 = btn.querySelector('progress');
        const percent = $('.percent');
        const scope = (popover.querySelector('input[name="scope"]:checked') || {}).value || 'single';

        // ---- required fields (fail fast, in plain language, before anything starts) ----
        if (!authToken) { window.alert('Authorization token is required — click Authorization > get.'); return; }
        if (!authorId) {
            // Blank Author = delete EVERY author's messages in scope (v1.4's moderator purge). Keep it, but make it deliberate.
            if (!window.confirm('No Author ID is set.\n\nWith Author blank this deletes EVERYONE\'s messages in the selected scope — a full purge, not just your own posts. Only continue if you moderate this channel and intend that.\n\nContinue?')) return;
        }

        // ---- resolve the target list + guild from the chosen scope ----
        let runGuildId = guildId;
        let channelIds;
        if (scope === 'server') {
            if (!guildId || guildId === '@me') {
                window.alert('Whole-server mode needs a server open (the Guild ID must be a server, not @me).');
                return;
            }
            channelIds = ['']; // '' => channel_id omitted => guild-wide sweep (every channel & thread)
        } else if (scope === 'dms') {
            runGuildId = '@me';
            if (window.__undiscord_setFollow) window.__undiscord_setFollow(false);
            const ids = await fetchAllDmIds(authToken);
            if (!ids) return; // alert already shown
            if (!ids.length) { window.alert('No open DM channels found. Open the DMs you want to clear first.'); return; }
            channelIds = ids;
        } else { // single
            channelIds = $('input#channelId').value.trim().split(/\s*,\s*/).filter(Boolean);
            if (!channelIds.length) {
                window.alert('No channel selected. Open the channel or DM you want (Follow is on), or type a Channel ID.');
                return;
            }
        }

        // ---- one upfront confirmation for any mass / multi-target run ----
        const multi = channelIds.length > 1 || scope !== 'single';
        if (multi) {
            const what = scope === 'server'
                ? `your ENTIRE server (guild ${guildId}) — every channel & thread you can see`
                : scope === 'dms'
                    ? `ALL ${channelIds.length} of your open DMs & group DMs`
                    : `${channelIds.length} channels/DMs`;
            if (!window.confirm(`About to delete messages by you across ${what}.\n\nThis can take a long time and cannot be undone.\n\nContinue?`)) {
                return;
            }
        }

        // freeze auto-follow so navigating around can't change the target mid-run
        if (window.__undiscord_setFollow) window.__undiscord_setFollow(false);

        const stopHndl = () => !(stop === true);

        let hasUndeletable = false;
        const onProg = (value, max, markUndeletable = false) => {
            if (markUndeletable) hasUndeletable = true;
            if (value && max && value > max) max = value;
            progress.setAttribute('max', max);
            progress.value = value;
            // always keep the progress visible so the final red/green state can be seen
            progress.style.display = '';
            progress2.setAttribute('max', max);
            progress2.value = value;
            progress2.style.display = '';
            // show percentage even when value is 0 (0 is falsy), but only when both numbers are provided
            if (typeof value === 'number' && typeof max === 'number' && max > 0) {
                percent.innerHTML = Math.round(value / max * 100) + '%';
            }

            // blue by default, red if any undeletable was seen, green only when fully complete with no undeletables
            if (hasUndeletable) {
                progress.style.accentColor = '#f04747';  // red
                progress2.style.accentColor = '#f04747';
            } else if (max && value >= max) {
                // all deleted - show green
                progress.style.accentColor = '#43b581';  // green
                progress2.style.accentColor = '#43b581';
            } else if (max) {
                // pending/in-progress with no undeletables
                progress.style.accentColor = '#5865f2';  // blue
                progress2.style.accentColor = '#5865f2';
            } else {
                // reset to default
                progress.style.accentColor = '';
                progress2.style.accentColor = '';
            }
        };

        stop = stopBtn.disabled = !(startBtn.disabled = true);
        // pre-reset progress bar so it starts blue immediately
        progress.setAttribute('max', 1);
        progress.value = 0;
        progress.style.accentColor = '#5865f2';
        progress2.setAttribute('max', 1);
        progress2.value = 0;
        progress2.style.accentColor = '#5865f2';
        percent.innerHTML = '0%';

        try {
            for (let i = 0; i < channelIds.length; i++) {
                if (stop === true) break; // a real Stop halts the whole queue, not just the current channel
                try {
                    await deleteMessages(authToken, authorId, runGuildId, channelIds[i], minId || minDate, maxId || maxDate, content, hasLink, hasFile, includeNsfw, includePinned, logger, stopHndl, onProg, !multi);
                } catch (err) {
                    logger('error', ['Channel ' + (channelIds[i] || '(whole server)') + ' failed: ' + (err && err.message ? err.message : err)]);
                }
            }
        } finally {
            // reset the controls ONCE, after every target finishes (or after a Stop / crash)
            stop = stopBtn.disabled = !(startBtn.disabled = false);
        }
        } finally {
            runInProgress = false;
        }
    };
    stopBtn.onclick = e => stop = stopBtn.disabled = !(startBtn.disabled = false);
    $('button#clear').onclick = e => {
        logArea.innerHTML = '';

        const progress = $('#progress');
        const progress2 = btn.querySelector('progress');
        const percent = $('.percent');

        progress.style.display = 'none';
        progress2.style.display = 'none';
        progress.removeAttribute('max');
        progress2.removeAttribute('max');
        progress.value = 0;
        progress2.value = 0;
        progress.style.accentColor = '';
        progress2.style.accentColor = '';
        percent.textContent = '';
    };
    $('button#getToken').onclick = e => {
        try {
            const iframe = document.createElement('iframe');
            const token = JSON.parse(document.body.appendChild(iframe).contentWindow.localStorage.token);
            iframe.remove();
            $('input#authToken').value = token;
        } catch (err) {
            window.alert('Could not auto-grab the token. Open DevTools and paste it into the Auth Token box manually.');
        }
    };
    $('button#getAuthor').onclick = e => {
        let userId;
        try {
            webpackChunkdiscord_app.push([
                [Math.random()],
                {},
                (r) => {
                    for (const m of Object.keys(r.c)) {
                        try {
                            const mod = r.c[m].exports;
                            if (mod?.default?.getUsers || mod?.getUsers) {
                                const users = (mod.default || mod).getUsers();
                                const user = Object.values(users).find(u => u.email);
                                if (user) {
                                    userId = user.id;
                                    return;
                                }
                            }
                        } catch { }
                    }
                }
            ]);
        } catch (err) {
            console.warn('Undiscord: author auto-detect failed.', err);
        }
        if (userId) $('input#authorId').value = userId;
        else window.alert('Could not auto-detect your Author ID — paste it manually.');
    };
    $('button#getGuildAndChannel').onclick = e => {
        const m = location.href.match(/channels\/([\w@]+)\/(\d+)/);
        if (m) {
            $('input#guildId').value = m[1];
            $('input#channelId').value = m[2];
        } else {
            window.alert('Open a channel or DM first — there is no channel id in the current URL.');
        }
    };
    $('#redact').onchange = e => {
        popover.classList.toggle('redact') &&
            window.alert('This will attempt to hide personal information, but make sure to double check before sharing screenshots.');
    };

    const logger = (type = '', args) => {
        const style = {'': '', info: 'color:#00b0f4;', verb: 'color:#72767d;', warn: 'color:#faa61a;', error: 'color:#f04747;', success: 'color:#43b581;'}[type];
        logArea.insertAdjacentHTML('beforeend', `<div style="${style}">${Array.from(args).map(o => typeof o === 'object' ? JSON.stringify(o, o instanceof Error && Object.getOwnPropertyNames(o)) : o).join('\t')}</div>`);
        if (autoScroll.checked) logArea.querySelector('div:last-child').scrollIntoView(false);
    };

    // ===== Live navigation watcher: keep Guild/Channel IDs synced as you click around =====
    (function () {
        if (window.__undiscord_nav) return; // don't double-patch history if the script re-inits
        window.__undiscord_nav = 1;

        const CHANNEL_RE = /\/channels\/([\w@]+)\/(\d+)/;
        const guildInput = $('input#guildId');
        const channelInput = $('input#channelId');
        let following = true;
        let lastHref = '';

        const syncFromLocation = () => {
            const m = location.href.match(CHANNEL_RE);
            if (!m) return; // Settings / Friends / @me home — leave the fields alone
            guildInput.value = m[1];        // '@me' for DMs — exactly what the engine expects
            channelInput.value = m[2];
            const loc = $('#currentLoc');
            if (loc) loc.textContent = '📍 ' + (m[1] === '@me' ? 'DM' : 'Server ' + m[1]) + ' › ' + m[2];
        };

        const setFollow = (on) => {
            following = on;
            const cb = $('#followChannel');
            if (cb) cb.checked = on;
            if (on) syncFromLocation();
        };

        const onNav = () => {
            if (location.href === lastHref) return; // dedupe (patch + poll both call this)
            lastHref = location.href;
            if (following) syncFromLocation();
        };

        const cb = $('#followChannel');
        if (cb) cb.addEventListener('change', ev => setFollow(ev.target.checked));

        // hand-editing an ID auto-locks (our programmatic .value = never fires 'input')
        const lockOnEdit = () => { if (following) setFollow(false); };
        guildInput.addEventListener('input', lockOnEdit);
        channelInput.addEventListener('input', lockOnEdit);

        // robust SPA navigation detection: patch history + popstate + a cheap poll safety net
        for (const fn of ['pushState', 'replaceState']) {
            const orig = history[fn];
            history[fn] = function () {
                const ret = orig.apply(this, arguments);
                queueMicrotask(onNav);
                return ret;
            };
        }
        window.addEventListener('popstate', () => setTimeout(onNav, 0));
        setInterval(onNav, 500); // safety net; cost is a single string compare

        window.__undiscord_setFollow = setFollow;

        setTimeout(syncFromLocation, 300); // first paint once the app has settled
    })();

    // fixLocalStorage
    window.localStorage = document.body.appendChild(document.createElement('iframe')).contentWindow.localStorage;

    // ---- remember non-sensitive settings between opens (token & authorId are deliberately NOT saved) ----
    const PERSIST_IDS = ['content', 'minId', 'maxId', 'minDate', 'maxDate', 'hasLink', 'hasFile', 'includeNsfw', 'includePinned', 'autoScroll'];
    const savePrefs = () => {
        try {
            const o = {};
            PERSIST_IDS.forEach(id => { const el = $('#' + id); if (el) o[id] = el.type === 'checkbox' ? el.checked : el.value; });
            window.localStorage.setItem('undiscord_prefs', JSON.stringify(o));
        } catch (e) { }
    };
    const loadPrefs = () => {
        try {
            const o = JSON.parse(window.localStorage.getItem('undiscord_prefs') || '{}');
            PERSIST_IDS.forEach(id => {
                const el = $('#' + id);
                if (el && id in o) { if (el.type === 'checkbox') el.checked = o[id]; else el.value = o[id]; }
            });
        } catch (e) { }
    };
    popover.addEventListener('change', savePrefs);
    loadPrefs();

}

initUI();
