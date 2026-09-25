// ==UserScript==
// @name          Discord Mass Deleter
// @description   Mass-delete your OWN Discord messages from a single channel/DM, a whole server, or all your DMs. Scope switch, auto-follow, resizable UI, reliable paging and safer rate-limit handling.
// @namespace     https://github.com/HoodedJustice/DiscordMassDelete
// @homepageURL   https://github.com/HoodedJustice/DiscordMassDelete
// @supportURL    https://github.com/HoodedJustice/DiscordMassDelete/issues
// @downloadURL   https://raw.githubusercontent.com/HoodedJustice/DiscordMassDelete/main/DiscordMassDelete.user.js
// @updateURL     https://raw.githubusercontent.com/HoodedJustice/DiscordMassDelete/main/DiscordMassDelete.user.js
// @version       1.6
// @match         https://discord.com/*
// @match         https://ptb.discord.com/*
// @match         https://canary.discord.com/*
// @grant         none
// @noframes
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

//---- Deletion engine ----//

// Message types Discord allows to be deleted (the "Deletable" column of the API docs). Every other
// type (calls, recipient add/remove, name/icon changes, thread starter, ...) is a system message that
// can never be deleted, so it is skipped without spending a request on it.
const DELETABLE_TYPES = new Set([0, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 22, 23, 24, 25, 26, 27, 28, 29, 31, 32, 36, 37, 38, 39, 44, 46]);
// Types that hold someone's own content: DEFAULT (0) and REPLY (19). When Discord refuses to delete
// any other (system) type, e.g. a join or boost notice, it is reported as skipped rather than failed.
const CONTENT_TYPES = new Set([0, 19]);

// API base on the same origin as the client (so PTB / Canary work too), falling back to discord.com.
function apiBase() {
    const onDiscord = typeof location !== 'undefined' && /(^|\.)discord\.com$/.test(location.hostname);
    return (onDiscord ? location.origin : 'https://discord.com') + '/api/v6';
}

/**
 * Delete messages in one channel / DM, or across a whole server (blank channelId + a real guildId).
 * @param {string} authToken Your authorization token
 * @param {string} authorId Author whose messages get deleted (blank = every author, i.e. a moderator purge)
 * @param {string} guildId Server id, or '@me' for DMs
 * @param {string} channelId Channel id (leave blank with a real guildId to sweep the whole server)
 * @param {string} minId Only delete messages after this message id or date
 * @param {string} maxId Only delete messages before this message id or date
 * @param {string} content Only messages containing this text
 * @param {boolean} hasLink Only messages that contain a link
 * @param {boolean} hasFile Only messages that contain a file
 * @param {boolean} includeNsfw Also search NSFW channels
 * @param {boolean} includePinned Also delete pinned messages (otherwise they are kept)
 * @param {function(string, Array)} extLogger Logging callback
 * @param {function(): boolean} stopHndl Returns false once the user pressed Stop
 * @param {function(number, number, boolean, object)} onProgress (processed, total, anySkippedOrFailed, stats)
 * @param {boolean} askConfirm Show the preview confirmation first (the UI turns it off for bulk runs it already confirmed)
 * @returns {Promise<{deleted:number, skipped:number, failed:number, throttled:number, stopped:boolean, aborted:(string|null), finished:boolean}>}
 * @see README.md / CHANGELOG.md for usage and options.
 */
async function deleteMessages(authToken, authorId, guildId, channelId, minId, maxId, content, hasLink, hasFile, includeNsfw, includePinned, extLogger, stopHndl, onProgress, askConfirm = true) {
    const start = new Date();
    const API = apiBase();
    const PAGE_SIZE = 25;       // Discord search returns up to 25 hits per page
    const MAX_RETRIES = 5;      // network errors / 5xx in a row before giving up on one request
    const MAX_WAITS = 40;       // "not indexed yet" / search rate-limit rounds before giving up on a target
    const ArchivedThreads = new Set();
    const seen = new Set();     // ids already handled this run, so a message is never processed twice

    const randDelay = () => Math.floor(Math.random() * (2000 - 1000 + 1) + 1000);
    let deleteDefault = randDelay();
    let deleteDelay = deleteDefault;
    let randomizeDelay = true;
    let searchDelay = randDelay();
    let successInRow = 0;
    let avgPing = 0;
    let lastPing = 0;

    let grandTotal = 0;
    let delCount = 0;
    let skipCount = 0;
    let failCount = 0;
    let throttledCount = 0;
    let throttledTotalTime = 0;
    let stopped = false;
    let abortedByUser = false;
    let aborted = null;         // 'error' (this target is skipped) | 'cloudflare' / 'auth' (the UI stops the whole queue)
    let finished = false;
    let confirmed = !askConfirm;

    const isStopped = () => !!(stopHndl && stopHndl() === false);
    // Sleep that wakes up early when Stop is pressed, so stopping never has to sit out a long back-off.
    const wait = async ms => {
        const until = Date.now() + Math.max(0, ms || 0);
        while (Date.now() < until) {
            if (isStopped()) return;
            await new Promise(done => setTimeout(done, Math.min(250, until - Date.now())));
        }
    };
    const msToHMS = s => { s = Math.max(0, s || 0); return `${s / 3.6e6 | 0}h ${(s % 3.6e6) / 6e4 | 0}m ${(s % 6e4) / 1000 | 0}s`; };
    const escapeHTML = html => String(html).replace(/[&<>"']/g, m => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#039;'})[m]);
    const redact = str => `<span class="priv">${escapeHTML(str)}</span><span class="mask">REDACTED</span>`;
    const queryString = params => params.filter(p => p[1] !== undefined).map(p => p[0] + '=' + encodeURIComponent(p[1])).join('&');
    const ask = async msg => new Promise(resolve => setTimeout(() => resolve(window.confirm(msg)), 10));
    // Dates -> snowflake ids. BigInt, because ms * 2^22 overflows a Number and silently rounds. Raw ids pass through.
    const toSnowflake = (date) => {
        if (!date) return undefined;
        if (!/[:T]/.test(date)) return String(date);
        const ms = new Date(date).getTime();
        if (isNaN(ms)) return String(date);
        const DISCORD_EPOCH = 1420070400000n;
        const t = BigInt(ms);
        return (t > DISCORD_EPOCH ? (t - DISCORD_EPOCH) << 22n : 0n).toString();
    };
    const minSnowflake = toSnowflake(minId);
    let cursor = toSnowflake(maxId); // paging cursor: each search only returns messages older than this id

    // Read a response body ONCE and try to parse it as JSON. Cloudflare blocks and gateway errors
    // return HTML, where resp.json() would throw. This never throws.
    const readBody = async (resp) => {
        let t = '';
        try { t = await resp.text(); } catch { }
        let j = null;
        try { j = JSON.parse(t); } catch { }
        return { t, j };
    };
    // A Cloudflare block (1015 rate limit = 429, 1020 access denied = 403). Cloudflare's temporary 5xx
    // error pages are NOT blocks — those are retried like any other server error.
    const isCloudflareBlock = (t, resp) => (resp.status === 429 || resp.status === 403) && (
        /error code:? ?10(15|20)/i.test(t || '') ||
        ((resp.headers.get('content-type') || '').includes('text/html') && /cloudflare|attention required/i.test(t || '')));
    // /api/v6 reports retry_after in MILLISECONDS. The floor stops a missing or bogus value from collapsing the back-off.
    const retryAfterMs = (j, floor) => Math.max(j && typeof j.retry_after === 'number' ? j.retry_after : 0, floor);
    const backoffMs = attempt => Math.min(60000, 2000 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 1000);

    const log = {
        debug() {extLogger ? extLogger('debug', arguments) : console.debug.apply(console, arguments);},
        info() {extLogger ? extLogger('info', arguments) : console.info.apply(console, arguments);},
        verb() {extLogger ? extLogger('verb', arguments) : console.log.apply(console, arguments);},
        warn() {extLogger ? extLogger('warn', arguments) : console.warn.apply(console, arguments);},
        error() {extLogger ? extLogger('error', arguments) : console.error.apply(console, arguments);},
        success() {extLogger ? extLogger('success', arguments) : console.info.apply(console, arguments);},
    };
    const printDelayStats = () => log.verb(`Delete delay: ${deleteDelay | 0}ms, Search delay: ${searchDelay | 0}ms`, `Last Ping: ${lastPing}ms, Average Ping: ${avgPing | 0}ms`);

    const processed = () => delCount + skipCount + failCount;
    const etaMs = () => {
        const remaining = Math.max(0, grandTotal - processed());
        return remaining * (deleteDelay + avgPing) + Math.ceil(remaining / PAGE_SIZE) * searchDelay;
    };
    const emitProgress = () => {
        const done = processed();
        const max = finished ? Math.max(done, 1) : Math.max(grandTotal, done, 1);
        try {
            if (onProgress) onProgress(finished ? max : done, max, (skipCount + failCount) > 0, {
                deleted: delCount, skipped: skipCount, failed: failCount, throttled: throttledCount,
                total: grandTotal, etaMs: (finished || stopped || aborted) ? 0 : etaMs(), done: finished, stopped, aborted,
            });
        } catch (e) { }
    };
    const recordPing = s => {
        lastPing = Date.now() - s;
        avgPing = avgPing > 0 ? (avgPing * 0.9) + (lastPing * 0.1) : lastPing;
    };

    // One page of search results, retrying transient problems. Resolves to {data} or {end: reason}.
    async function searchPage() {
        const url = (guildId === '@me'
            ? `${API}/channels/${channelId}/messages/search?`   // DMs
            : `${API}/guilds/${guildId}/messages/search?`) +    // Server
            queryString([
                ['author_id', authorId || undefined],
                ['channel_id', (guildId !== '@me' && channelId) ? channelId : undefined],
                ['min_id', minSnowflake],
                ['max_id', cursor],
                ['sort_by', 'timestamp'],
                ['sort_order', 'desc'],
                ['has', hasLink ? 'link' : undefined],
                ['has', hasFile ? 'file' : undefined],
                ['content', content || undefined],
                ['include_nsfw', includeNsfw ? true : undefined],
            ]);
        let failures = 0;
        let waits = 0;
        while (true) {
            if (isStopped()) return { end: 'stopped' };
            let resp;
            try {
                const s = Date.now();
                resp = await fetch(url, { headers: { 'Authorization': authToken } });
                recordPing(s);
            } catch (err) {
                if (++failures > MAX_RETRIES) {
                    log.error(`Search failed ${MAX_RETRIES} times in a row (network: ${escapeHTML(err && err.message || err)}). Skipping this target — run it again later.`);
                    return { end: 'error' };
                }
                const w = backoffMs(failures);
                log.warn(`Network error while searching (attempt ${failures}/${MAX_RETRIES}). Retrying in ${w}ms...`);
                await wait(w);
                continue;
            }

            // Not indexed yet
            if (resp.status === 202) {
                const { j } = await readBody(resp);
                if (++waits > MAX_WAITS) {
                    log.error('Discord still has not indexed this channel. Skipping it — run it again later.');
                    return { end: 'error' };
                }
                const w = retryAfterMs(j, 2000);
                throttledCount++;
                throttledTotalTime += w;
                log.warn(`This channel isn't indexed yet — waiting ${w}ms for Discord to index it...`);
                await wait(w);
                continue;
            }
            // Searching messages too fast
            if (resp.status === 429) {
                const { t, j } = await readBody(resp);
                if (isCloudflareBlock(t, resp)) {
                    log.error('Cloudflare is rate-limiting your IP (error 1015). This is an IP-level block, NOT a normal Discord limit. Stopping now — wait about an hour before trying again.');
                    return { end: 'cloudflare' };
                }
                if (++waits > MAX_WAITS) {
                    log.error('Still rate-limited after many waits. Skipping this target — run it again later.');
                    return { end: 'error' };
                }
                if (j && j.global) log.warn('GLOBAL rate limit hit while searching — you are being limited account-wide. Consider stopping.');
                const w = retryAfterMs(j, 1000);
                throttledCount++;
                throttledTotalTime += w;
                searchDelay = w * 1.1;
                log.warn(`Discord said don't search for ${w}ms!`);
                printDelayStats();
                await wait(searchDelay);
                continue;
            }
            if (resp.status >= 500) {
                if (++failures > MAX_RETRIES) {
                    log.error(`Search failed with HTTP ${resp.status} ${MAX_RETRIES} times in a row. Skipping this target — run it again later.`);
                    return { end: 'error' };
                }
                const w = backoffMs(failures);
                log.warn(`Discord returned HTTP ${resp.status} while searching (attempt ${failures}/${MAX_RETRIES}). Retrying in ${w}ms...`);
                await wait(w);
                continue;
            }
            if (resp.status === 401) {
                log.error('Discord rejected the token (HTTP 401) — it is invalid or expired. Grab a fresh one with Authorization > get.');
                return { end: 'auth' };
            }
            if (!resp.ok) {
                const { t, j } = await readBody(resp);
                if (isCloudflareBlock(t, resp)) {
                    log.error('Cloudflare is blocking your connection (HTTP 403). Stopping now — wait a while before trying again.');
                    return { end: 'cloudflare' };
                }
                log.error(`Error searching messages, API responded with status ${resp.status}!`, j);
                return { end: 'error' };
            }

            const { j: data } = await readBody(resp);
            if (!data || !Array.isArray(data.messages)) {
                if (++failures > MAX_RETRIES) {
                    log.error('Discord kept returning an unexpected search response. Skipping this target.', data);
                    return { end: 'error' };
                }
                await wait(backoffMs(failures));
                continue;
            }
            return { data };
        }
    }

    // Delete one message, retrying transient problems.
    // Resolves to 'deleted' | 'gone' | 'archived' | 'system' | 'failed' | 'stopped' | 'cloudflare' | 'auth'.
    async function deleteOne(message) {
        const url = `${API}/channels/${message.channel_id}/messages/${message.id}`;
        let failures = 0;
        let limited = 0;
        while (true) {
            if (isStopped()) return 'stopped';
            let resp;
            try {
                const s = Date.now();
                resp = await fetch(url, { headers: { 'Authorization': authToken }, method: 'DELETE' });
                recordPing(s);
            } catch (err) {
                successInRow = 0;
                if (++failures > MAX_RETRIES) {
                    log.error(`Delete failed ${MAX_RETRIES} times in a row (network: ${escapeHTML(err && err.message || err)}).`);
                    return 'failed';
                }
                const w = backoffMs(failures);
                log.warn(`Network error while deleting (attempt ${failures}/${MAX_RETRIES}). Retrying in ${w}ms...`);
                await wait(w);
                continue;
            }
            if (resp.ok) return 'deleted';

            const { t, j: err } = await readBody(resp);
            // Cloudflare IP block masquerading as a 429 with an HTML body — stop immediately.
            if (isCloudflareBlock(t, resp)) {
                log.error('Cloudflare 1015 IP block hit while deleting. Stopping now to protect your account — wait about an hour before retrying.');
                return 'cloudflare';
            }
            if (resp.status === 401) {
                log.error('Discord rejected the token (HTTP 401) — grab a fresh one with Authorization > get.');
                return 'auth';
            }
            // Thread archived or locked
            if ((resp.status === 400 && err?.code === 50083) ||
                ((resp.status === 403 || resp.status === 404) && err?.message && /archiv/i.test(err.message))) {
                log.warn(`Archived thread detected (status ${resp.status}${err?.code ? ', code ' + err.code : ''}) — skipping the rest of thread ${redact(message.channel_id)}.`);
                ArchivedThreads.add(message.channel_id);
                return 'archived';
            }
            // Unknown Message: it's already gone (deleted elsewhere in the meantime)
            if (resp.status === 404 && err?.code === 10008) return 'gone';
            // Deleting messages too fast
            if (resp.status === 429) {
                if (err && err.global) log.warn('GLOBAL rate limit during delete — slowing down hard.');
                const w = retryAfterMs(err, 1000);
                log.warn(`Failed to delete - Discord said go away for ${w}ms!`);
                throttledCount++;
                throttledTotalTime += w;
                successInRow = 0;
                randomizeDelay = false;
                const multi = 1.632;
                // increase the delay if it's shorter than what Discord asked for
                if (w * 1.532 > deleteDelay)
                    deleteDelay = w * multi;
                else {
                    // otherwise ease off a little so we don't get stuck at a huge delay
                    deleteDelay = deleteDelay * 0.94812;
                    if (deleteDelay < w)
                        deleteDelay = w * multi;
                    log.warn('Delete delay is already greater than wait time. Reduce instead.');
                }
                printDelayStats();
                // retry, but cap it so a permanently limited message can't loop forever
                if (++limited > 30) {
                    log.error('Giving up on a message after 30 rate-limit retries.');
                    return 'failed';
                }
                await wait(deleteDelay);
                continue;
            }
            if (resp.status >= 500) {
                successInRow = 0;
                if (++failures > MAX_RETRIES) {
                    log.error(`Delete failed with HTTP ${resp.status} ${MAX_RETRIES} times in a row.`);
                    return 'failed';
                }
                const w = backoffMs(failures);
                log.warn(`Discord returned HTTP ${resp.status} while deleting (attempt ${failures}/${MAX_RETRIES}). Retrying in ${w}ms...`);
                await wait(w);
                continue;
            }
            // Discord refused a system message (join / boost notice, ...) — not removable, so it's a skip
            if (err?.code === 50021 || (resp.status === 403 && !CONTENT_TYPES.has(message.type))) return 'system';

            successInRow = 0;
            randomizeDelay = false;
            log.error(`Error deleting message, API responded with status ${resp.status}!`, err);
            log.verb('Related object:', redact(JSON.stringify(message)));
            return 'failed';
        }
    }

    log.success(`\nStarted at ${start.toLocaleString()}`);
    log.debug(`authorId="${redact(authorId || '(any author)')}" guildId="${redact(guildId)}" channelId="${redact(channelId || '(whole server)')}" minId="${redact(minId || '')}" maxId="${redact(maxId || '')}" hasLink=${!!hasLink} hasFile=${!!hasFile} includePinned=${!!includePinned}`);
    emitProgress();

    let noProgress = 0;
    pages:
    while (true) {
        if (isStopped()) { stopped = true; break; }
        const res = await searchPage();
        if (res.end) {
            if (res.end === 'stopped') stopped = true;
            else aborted = res.end;
            break;
        }
        const data = res.data;
        const hits = data.messages
            .map(convo => Array.isArray(convo) ? convo.find(m => m && m.hit === true) : null)
            .filter(Boolean);
        if (!grandTotal) grandTotal = data.total_results || hits.length;

        if (!hits.length) {
            if (data.total_results > 0) log.warn(`Discord reports ${data.total_results} more result(s) but returned none — they may be in channels you can no longer open. Run it again later to retry.`);
            finished = true;
            break;
        }

        // The next page is everything OLDER than the oldest hit on this page. Paging by message id instead
        // of by offset means messages that linger in Discord's search index after being deleted, skipped
        // messages and failures can never shift the window, repeat, or hide messages — and there's no
        // offset ceiling on big channels.
        const oldest = hits.reduce((a, m) => (BigInt(m.id) < BigInt(a) ? m.id : a), hits[0].id);
        const fresh = hits.filter(m => !seen.has(m.id));
        hits.forEach(m => seen.add(m.id));
        if (!fresh.length) {
            // Only messages we already handled came back — step the cursor past them.
            cursor = (BigInt(oldest) - 1n).toString();
            if (++noProgress > 3) { finished = true; break; }
            await wait(searchDelay);
            continue;
        }
        noProgress = 0;

        const toDelete = [];
        let sysSkip = 0, pinSkip = 0, archSkip = 0;
        for (const m of fresh) {
            if (!DELETABLE_TYPES.has(m.type)) sysSkip++;                 // system message, can't be deleted
            else if (m.pinned && !includePinned) pinSkip++;               // pinned messages are kept unless asked
            else if (ArchivedThreads.has(m.channel_id)) archSkip++;       // thread is archived
            else toDelete.push(m);
        }
        skipCount += sysSkip + pinSkip + archSkip;

        log.info(`Remaining matches: ${data.total_results}`,
            `(this page: ${fresh.length} — delete ${toDelete.length}, skip ${sysSkip} system / ${pinSkip} pinned / ${archSkip} archived)`);
        printDelayStats();
        log.verb(`Estimated time remaining: ${msToHMS(etaMs())}`);
        emitProgress();

        if (toDelete.length && !confirmed) {
            log.verb('Waiting for your confirmation...');
            const who = m => (m.author && (m.author.global_name || m.author.username)) || '?';
            const line = m => {
                const text = ((m.attachments && m.attachments.length ? '[ATTACHMENTS] ' : '') + (m.content || '')).replace(/\s+/g, ' ').trim();
                return `${who(m)}: ${text.length > 80 ? text.slice(0, 77) + '...' : text}`;
            };
            if (!await ask(`Do you want to delete ~${grandTotal} messages?\nEstimated time: ${msToHMS(etaMs())}\n\n---- Preview ----\n` + toDelete.map(line).join('\n'))) {
                log.error('Aborted by you!');
                stopped = true;
                abortedByUser = true;
                break;
            }
            confirmed = true;
            log.verb('OK');
        }

        for (let i = 0; i < toDelete.length; i++) {
            const message = toDelete[i];
            if (isStopped()) { stopped = true; break pages; }
            // its thread turned out to be archived earlier on this page
            if (ArchivedThreads.has(message.channel_id)) { skipCount++; emitProgress(); continue; }

            const n = processed() + 1;
            const of = Math.max(grandTotal, n);
            log.debug(`${(n / of * 100).toFixed(2)}% (${n}/${of}) | <b>DEL</b> <small>(${redact(new Date(message.timestamp).toLocaleDateString() + ' - ' + new Date(message.timestamp).toLocaleTimeString())})</small>: ${redact(message.content || '').replace(/\n/g, '↵')}`, message.attachments && message.attachments.length ? redact(JSON.stringify(message.attachments)) : '');

            const outcome = await deleteOne(message);
            if (outcome === 'stopped') { stopped = true; break pages; }
            if (outcome === 'cloudflare' || outcome === 'auth') { aborted = outcome; break pages; }
            if (outcome === 'deleted' || outcome === 'gone') {
                if (outcome === 'gone') log.verb('That message was already gone — counted as deleted.');
                delCount++;
                successInRow++;
                if (randomizeDelay) {
                    deleteDefault = randDelay();
                    deleteDelay = deleteDefault;
                }
                // make sure we eventually speed back up
                if (successInRow > 4 && deleteDelay > deleteDefault && !randomizeDelay) {
                    deleteDelay = deleteDelay * 0.94812;
                    log.verb(`Lowering delay to ${deleteDelay | 0}ms`);
                }
                else if (deleteDelay < deleteDefault) {
                    deleteDefault = randDelay();
                    deleteDelay = deleteDefault;
                    randomizeDelay = true;
                    log.verb(`Default delay, ${deleteDefault}.`);
                }
            } else if (outcome === 'archived' || outcome === 'system') {
                if (outcome === 'system') log.verb('Discord refused to delete a system message — skipped.');
                skipCount++;
            } else {
                failCount++;
            }
            emitProgress();

            if (i < toDelete.length - 1) await wait(deleteDelay);
        }

        cursor = oldest;
        deleteDefault = randDelay();
        deleteDelay = deleteDefault;
        searchDelay = randDelay();
        // turn randomizing back on, since we're searching the next page anyway
        randomizeDelay = true;
        log.verb(`Searching next messages in ${searchDelay}ms...`);
        await wait(searchDelay);
    }

    if (stopped && !abortedByUser) log.error('Stopped by you!');
    log.success(`${finished ? 'Finished' : stopped ? 'Stopped' : 'Ended early'} at ${new Date().toLocaleString()}! Total time: ${msToHMS(Date.now() - start.getTime())}`);
    log.verb(`Rate Limited: ${throttledCount} times. Total time throttled: ${msToHMS(throttledTotalTime)}.`);
    log.debug(`Deleted ${delCount}, skipped ${skipCount} (system / pinned / archived), failed ${failCount}.`);
    if (failCount > 0) log.warn(`${failCount} message(s) could not be deleted — run it again to retry them.`);
    emitProgress();
    return { deleted: delCount, skipped: skipCount, failed: failCount, throttled: throttledCount, stopped, aborted, finished };
}

//---- User interface ----//

let popover;
let btn;
let stop = false;
let logArea;
const version = '1.6';

function initUI() {
    const LOG_LIMIT = 500;       // keep the last N log lines (older ones are trimmed instead of wiping the log)
    const CHANNEL_RE = /\/channels\/([\w@]+)\/(\d+)/;
    const TOKEN_RE = /^(mfa\.[\w-]{20,}|[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,})$/;

    const insertCss = (css) => {
        const style = document.createElement('style');
        style.appendChild(document.createTextNode(css));
        document.head.appendChild(style);
        return style;
    };

    const createElm = (html) => {
        const temp = document.createElement('div');
        temp.innerHTML = html;
        return temp.removeChild(temp.firstElementChild);
    };

    insertCss(`
        #undicord-btn{position:relative;height:24px;width:auto;-webkit-box-flex:0;-ms-flex:0 0 auto;flex:0 0 auto;margin:0 8px;cursor:pointer;color:var(--interactive-normal)}
        #undicord-btn:focus-visible{outline:2px solid #5865f2;outline-offset:2px;border-radius:4px}
        #undicord-btn.floating{position:fixed;right:18px;bottom:88px;z-index:1000;width:40px;height:40px;margin:0;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:var(--background-floating,#18191c);box-shadow:0 4px 12px rgba(0,0,0,.4)}
        #undicord-btn.floating br{display:none}
        #undiscord{position:fixed;top:60px;right:10px;width:min(780px, calc(100vw - 20px));height:min(72vh, calc(100vh - 80px));min-width:320px;min-height:220px;max-width:calc(100vw - 12px);max-height:calc(100vh - 24px);z-index:99;color:var(--text-normal,lightgrey);background-color:var(--background-primary,black);box-shadow:var(--elevation-stroke),var(--elevation-high);border-radius:8px;display:flex;flex-direction:column;overflow:hidden;resize:both}
        #undiscord a{color:#00b0f4}
        #undiscord .help{color:#00b0f4;cursor:help;font-weight:bold}
        #undiscord.redact .priv{display:none!important}
        #undiscord:not(.redact) .mask{display:none!important}
        #undiscord.redact [priv]{-webkit-text-security:disc!important}
        #undiscord.redact .privText{filter:blur(5px)}
        #undiscord button,#undiscord .btn{color:#fff;background:#7289da;border:0;border-radius:4px;font-size:14px;cursor:pointer;padding:0 12px;height:28px}
        #undiscord button:disabled{opacity:.4;cursor:not-allowed;filter:grayscale(.35)}
        #undiscord input[type="text"],#undiscord input[type="search"],#undiscord input[type="password"],#undiscord input[type="datetime-local"]{background-color:var(--input-background,#202225);color:var(--text-normal,#b9bbbe);border-radius:4px;border:1px solid var(--input-border,transparent);padding:0 .5em;height:28px;width:144px;margin:2px}
        #undiscord input#file{display:none}
        #undiscord hr{border-color:rgba(255,255,255,0.1)}
        #undiscord .header{padding:12px 16px;background-color:var(--background-tertiary);color:var(--text-muted)}
        #undiscord .form{padding:8px;background:var(--background-secondary);box-shadow:0 1px 0 rgba(0,0,0,.2),0 1.5px 0 rgba(0,0,0,.05),0 2px 0 rgba(0,0,0,.05);flex:0 1 auto;overflow:auto}
        #undiscord .logarea{overflow:auto;font-size:.75rem;font-family:Consolas,Liberation Mono,Menlo,Courier,monospace;flex:1 1 auto;min-height:90px;padding:10px;color:var(--text-normal,#dcddde);margin:0;scrollbar-width:thin}
        #undiscord .status{margin-top:6px;min-height:16px;font-size:12px;color:var(--text-muted,#b9bbbe)}
        #undiscord .scopeBox{margin:4px 2px;padding:6px 8px;border:1px solid var(--input-border,#40444b);border-radius:4px}
        #undiscord .scopeBox .scopeTitle{font-size:.72rem;color:var(--text-muted,#72767d);margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em}
        #undiscord .scopeBox label{display:block;cursor:pointer;line-height:1.6}
        #undiscord .scopeBox label.mass{color:#faa61a}
        `);

    popover = createElm(`
    <div id="undiscord" role="dialog" aria-label="Discord Mass Deleter" style="display:none;">
        <div class="header">
            <button id="resetWin" title="Reset the window to its default position and size" style="float:right;background:#4f545c;height:22px;padding:0 8px;font-size:12px;">⟲ reset window</button>
            🌹 Discord Mass Deleter ${version}
            <div style="font-size:11px;color:var(--text-muted);font-weight:400;margin-top:2px;">Deletes only your own messages. Default scope is the channel/DM you have open. Bulk modes are opt-in — go slow. Drag the header to move · drag the bottom-right corner to resize · Ctrl+Alt+Shift+D toggles this panel.</div>
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
                    <div id="currentLoc" class="privText" style="font-size:.72rem;color:#b9bbbe;margin:2px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px;"></div>
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
                    <label title="When unticked, pinned messages are kept."><input id="includePinned" type="checkbox">Include pinned</label>
                </span>
            </div>
            <hr>
            <button id="start" style="background:#43b581;width:80px;">Start</button>
            <button id="stop" style="background:#f04747;min-width:80px;" disabled>Stop</button>
            <button id="clear" style="width:80px;">Clear log</button>
            <label><input id="autoScroll" type="checkbox" checked>Auto scroll</label>
            <label title="Hide sensitive information for taking screenshots"><input id="redact" type="checkbox">Screenshot
                mode</label>
            <progress id="progress" aria-label="Deletion progress" style="display:none;"></progress> <span class="percent"></span>
            <div id="status" class="status" aria-live="polite"></div>
        </div>
        <pre class="logarea">
            <center>Discord Mass Deleter ${version} 🌹  ·  original by victornpb  ·  improved from gen3vra's fork
            </center>
        </pre>
    </div>
    `);
    document.body.appendChild(popover);
    const $ = s => popover.querySelector(s);

    btn = createElm(`<div id="undicord-btn" tabindex="0" role="button" aria-label="Delete Messages" title="Delete Messages (Ctrl+Alt+Shift+D)">
    <svg aria-hidden="false" width="24" height="24" viewBox="0 0 24 24">
        <path fill="currentColor" d="M15 3.999V2H9V3.999H3V5.999H21V3.999H15Z"></path>
        <path fill="currentColor" d="M5 6.99902V18.999C5 20.101 5.897 20.999 7 20.999H17C18.103 20.999 19 20.101 19 18.999V6.99902H5ZM11 17H9V11H11V17ZM15 17H13V11H15V17Z"></path>
    </svg>
    <br><progress style="display:none; width:24px;"></progress>
</div>`);

    logArea = $('pre');
    const startBtn = $('#start');
    const stopBtn = $('#stop');
    const autoScroll = $('#autoScroll');
    const progress = $('#progress');
    const progress2 = btn.querySelector('progress');
    const percent = $('.percent');
    const statusEl = $('#status');
    const guildInput = $('#guildId');
    const channelInput = $('#channelId');
    const tokenInput = $('#authToken');
    const authorInput = $('#authorId');

    // ---- log ----
    const escapeUI = s => String(s).replace(/[&<>"']/g, m => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#039;'})[m]);
    const redactUI = s => `<span class="priv">${escapeUI(s)}</span><span class="mask">REDACTED</span>`;
    // Strings from the engine are trusted markup (any message content inside them is already escaped).
    // Objects, e.g. API error bodies, are escaped here before they touch the page.
    const logger = (type = '', args) => {
        const style = {'': '', info: 'color:#00b0f4;', verb: 'color:#72767d;', warn: 'color:#faa61a;', error: 'color:#f04747;', success: 'color:#43b581;'}[type] || '';
        const html = Array.from(args).map(o => (o !== null && typeof o === 'object')
            ? escapeUI(JSON.stringify(o, o instanceof Error ? Object.getOwnPropertyNames(o) : undefined))
            : String(o)).join('\t');
        logArea.insertAdjacentHTML('beforeend', `<div style="${style}">${html}</div>`);
        while (logArea.childElementCount > LOG_LIMIT) logArea.removeChild(logArea.firstElementChild);
        if (autoScroll.checked) logArea.scrollTop = logArea.scrollHeight;
    };
    const setStatus = html => { statusEl.innerHTML = html || ''; };

    // ---- token & author detection ----
    function grabToken() {
        // Discord hides the token from localStorage while it runs; firing 'beforeunload' makes it write it back.
        try {
            window.dispatchEvent(new Event('beforeunload'));
            const iframe = document.body.appendChild(document.createElement('iframe'));
            const raw = iframe.contentWindow.localStorage.token;
            iframe.remove();
            const t = raw ? JSON.parse(raw) : '';
            if (typeof t === 'string' && TOKEN_RE.test(t)) return t;
        } catch (e) { }
        // Fallback: ask Discord's own token module.
        try {
            let found = '';
            webpackChunkdiscord_app.push([[Math.random()], {}, r => {
                for (const id of Object.keys(r.c)) {
                    try {
                        const exp = r.c[id].exports;
                        for (const c of [exp && exp.default, exp]) {
                            if (c && typeof c.getToken === 'function') {
                                const t = c.getToken();
                                if (typeof t === 'string' && TOKEN_RE.test(t)) { found = t; return; }
                            }
                        }
                    } catch (e) { }
                }
            }]);
            if (found) return found;
        } catch (e) { }
        return '';
    }
    // The first part of a user token is the user's id in base64 — no need to dig through Discord's internals.
    function authorIdFromToken(token) {
        try {
            const first = String(token || '').split('.')[0];
            if (!first || first === 'mfa') return '';
            let b64 = first.replace(/-/g, '+').replace(/_/g, '/');
            while (b64.length % 4) b64 += '=';
            const id = atob(b64);
            return /^\d{15,21}$/.test(id) ? id : '';
        } catch (e) { return ''; }
    }
    function grabAuthorId(token) {
        const fromToken = authorIdFromToken(token);
        if (fromToken) return fromToken;
        let userId = '';
        try {
            webpackChunkdiscord_app.push([[Math.random()], {}, r => {
                for (const m of Object.keys(r.c)) {
                    try {
                        const exp = r.c[m].exports;
                        for (const c of [exp && exp.default, exp]) {
                            if (!c) continue;
                            if (typeof c.getCurrentUser === 'function') {
                                const u = c.getCurrentUser();
                                if (u && /^\d{15,21}$/.test(u.id)) { userId = u.id; return; }
                            }
                            if (typeof c.getUsers === 'function') {
                                const u = Object.values(c.getUsers() || {}).find(x => x && x.email);
                                if (u) { userId = u.id; return; }
                            }
                        }
                    } catch (e) { }
                }
            }]);
        } catch (e) { }
        return userId;
    }

    // ---- follow the channel you're viewing ----
    let following = true;
    const showLocation = (g, c) => { $('#currentLoc').textContent = '📍 ' + (g === '@me' ? 'DM' : 'Server ' + g) + ' › ' + c; };
    const syncFromLocation = () => {
        const m = location.href.match(CHANNEL_RE);
        if (!m) return;                 // Settings / Friends / DM home: leave the fields alone
        guildInput.value = m[1];        // '@me' for DMs, which is what the engine expects
        channelInput.value = m[2];
        showLocation(m[1], m[2]);
    };
    const setFollow = on => {
        following = !!on;
        $('#followChannel').checked = following;
        if (following) syncFromLocation();
    };

    // ---- window position & size ----
    // Keep the whole panel inside the viewport (it's also capped to the viewport size in CSS).
    const clampIntoView = () => {
        if (popover.style.display === 'none') return;
        const r = popover.getBoundingClientRect();
        const left = Math.min(Math.max(0, r.left), Math.max(0, window.innerWidth - r.width));
        const top = Math.min(Math.max(0, r.top), Math.max(0, window.innerHeight - r.height));
        if (left !== r.left || top !== r.top) {
            popover.style.left = left + 'px';
            popover.style.top = top + 'px';
            popover.style.right = 'auto';
            popover.style.bottom = 'auto';
        }
    };
    // Back to the default size and place, then pinned by its LEFT edge so the resize corner follows the mouse.
    const resetWin = () => {
        popover.style.left = '';
        popover.style.top = '';
        popover.style.right = '10px';
        popover.style.bottom = '';
        popover.style.width = '';
        popover.style.height = '';
        if (popover.style.display === 'none') return;
        const r = popover.getBoundingClientRect();
        popover.style.left = Math.max(0, r.left) + 'px';
        popover.style.top = Math.max(0, r.top) + 'px';
        popover.style.right = 'auto';
    };
    window.addEventListener('resize', clampIntoView);

    (function makeDraggable(handle) {
        let sx, sy, sl, st, dragging = false;
        handle.style.cursor = 'move';
        handle.style.userSelect = 'none';
        handle.addEventListener('mousedown', ev => {
            if (ev.button !== 0 || ev.target.closest('button,input,a,label')) return;
            const r = popover.getBoundingClientRect();
            popover.style.left = r.left + 'px';
            popover.style.top = r.top + 'px';
            popover.style.right = 'auto';
            popover.style.bottom = 'auto';
            sx = ev.clientX; sy = ev.clientY; sl = r.left; st = r.top;
            dragging = true;
            ev.preventDefault();
        });
        window.addEventListener('mousemove', ev => {
            if (!dragging) return;
            const r = popover.getBoundingClientRect();
            popover.style.left = Math.min(Math.max(0, sl + ev.clientX - sx), Math.max(0, window.innerWidth - r.width)) + 'px';
            popover.style.top = Math.min(Math.max(0, st + ev.clientY - sy), Math.max(0, window.innerHeight - r.height)) + 'px';
        });
        window.addEventListener('mouseup', () => { dragging = false; });
    })($('.header'));
    $('#resetWin').onclick = resetWin;
    $('.header').addEventListener('dblclick', ev => { if (!ev.target.closest('button,input,a')) resetWin(); });

    // ---- open / close ----
    const togglePopover = () => {
        if (popover.style.display !== 'none') {
            popover.style.display = 'none';
            btn.style.color = '';
            return;
        }
        popover.style.display = '';
        btn.style.color = '#f04747';
        resetWin();                                  // always open on-screen at the default size
        if (following) syncFromLocation();           // a locked (hand-typed) target is left alone
        if (!tokenInput.value.trim()) tokenInput.value = grabToken();
        if (!authorInput.value.trim()) authorInput.value = grabAuthorId(tokenInput.value.trim());
    };
    btn.onclick = togglePopover;
    btn.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePopover(); }
    });
    // Keyboard shortcut, also the way in if Discord's toolbar ever changes and the button can't be placed.
    document.addEventListener('keydown', e => {
        if (e.ctrlKey && e.altKey && e.shiftKey && e.code === 'KeyD') {
            e.preventDefault();
            e.stopPropagation();
            togglePopover();
        }
    }, true);

    // ---- toolbar button ----
    // Lives in the channel toolbar. If no toolbar can be found (e.g. Discord renamed it) it floats in the
    // corner instead, so the panel can always be opened.
    let allowFloat = false;
    let mountQueued = false;
    function mountBtn() {
        const toolbar = document.querySelector('[class*="toolbar"]');
        if (toolbar) {
            if (btn.parentNode !== toolbar) {
                btn.classList.remove('floating');
                toolbar.appendChild(btn);
            }
        } else if (allowFloat && !btn.isConnected) {
            btn.classList.add('floating');
            document.body.appendChild(btn);
        }
    }
    const scheduleMount = () => {
        if (mountQueued) return;
        mountQueued = true;
        requestAnimationFrame(() => { mountQueued = false; mountBtn(); });
    };
    // Discord mutates the page constantly, so only react when the button needs (re)placing, at most once a frame.
    new MutationObserver(() => {
        if (!btn.isConnected || btn.classList.contains('floating')) scheduleMount();
    }).observe(document.body, { childList: true, subtree: true });
    mountBtn();
    setTimeout(() => { allowFloat = true; mountBtn(); }, 4000); // give Discord time to render before floating

    // ---- scope switch: grey out the Channel ID box when a bulk mode is picked ----
    const applyScopeUi = () => {
        const scope = (popover.querySelector('input[name="scope"]:checked') || {}).value || 'single';
        const dim = scope !== 'single';
        channelInput.disabled = dim;
        channelInput.style.opacity = dim ? 0.4 : 1;
    };
    popover.querySelectorAll('input[name="scope"]').forEach(r => r.addEventListener('change', applyScopeUi));
    applyScopeUi();

    // ---- import a channel list from a Discord data export (messages/index.json) ----
    const fileSelection = $('#file');
    fileSelection.addEventListener('change', () => {
        const files = fileSelection.files;
        if (!files || !files.length) return;
        files[0].text().then(text => {
            try {
                const keys = Object.keys(JSON.parse(text));
                channelInput.value = keys.join(',');
                // Guild ID is left alone: set it to @me for a DM export, or the server id for a server export
                const single = popover.querySelector('input[name="scope"][value="single"]');
                if (single) { single.checked = true; applyScopeUi(); }
                setFollow(false);
                logger('verb', [`Imported ${keys.length} channels. Set Guild ID to @me (DM export) or the server ID (server export) before Start.`]);
            } catch (e) {
                logger('error', ['Could not parse that file — pick messages/index.json from your Discord data export.']);
            }
            fileSelection.value = ''; // allow picking the same file again
        });
    });

    // ---- lookups used by the bulk modes ----
    async function fetchAllDms(authToken) {
        try {
            const resp = await fetch(`${apiBase()}/users/@me/channels`, { headers: { 'Authorization': authToken } });
            if (resp.status === 429) {
                let j = null;
                try { j = await resp.json(); } catch { }
                window.alert(`Rate limited loading DMs — try again in ~${Math.ceil(((j && j.retry_after) || 1000) / 1000)}s.`);
                return null;
            }
            if (resp.status === 401) { window.alert('Discord rejected the token (HTTP 401). Grab a fresh one with Authorization > get.'); return null; }
            if (!resp.ok) { window.alert(`Failed to load DMs (HTTP ${resp.status}).`); return null; }
            const chans = await resp.json();
            if (!Array.isArray(chans)) { window.alert('Unexpected response loading DMs.'); return null; }
            const nameOf = u => (u && (u.global_name || u.username)) || 'unknown';
            return chans.filter(c => c.type === 1 || c.type === 3).map(c => ({ // 1 = DM, 3 = group DM
                id: c.id,
                label: c.type === 1
                    ? 'DM with ' + nameOf((c.recipients || [])[0])
                    : 'Group: ' + (c.name || (c.recipients || []).map(nameOf).join(', ') || 'unnamed'),
            }));
        } catch (err) {
            window.alert('Error loading DMs: ' + err);
            return null;
        }
    }
    async function fetchGuildName(authToken, guildId) {
        try {
            const resp = await fetch(`${apiBase()}/guilds/${guildId}`, { headers: { 'Authorization': authToken } });
            if (!resp.ok) return '';
            const j = await resp.json();
            return (j && j.name) || '';
        } catch (e) { return ''; }
    }

    // ---- progress & status ----
    let runTotals = { deleted: 0, skipped: 0, failed: 0, throttled: 0 };
    let targetLabel = '';
    const fmtTime = ms => {
        const s = Math.round((ms || 0) / 1000);
        const h = s / 3600 | 0, m = (s % 3600) / 60 | 0, sec = s % 60;
        return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
    };
    const setBar = (value, max, color) => {
        for (const p of [progress, progress2]) {
            p.max = max;
            p.value = value;
            p.style.display = '';
            p.style.accentColor = color;
        }
        percent.textContent = Math.round(value / max * 100) + '%';
    };
    // blue while running, amber if anything was skipped (pinned / system), red if anything failed, green when all done
    const onProg = (value, max, _anyIssues, s) => {
        s = s || {};
        const failed = runTotals.failed + (s.failed || 0);
        const skipped = runTotals.skipped + (s.skipped || 0);
        setBar(value, max, failed ? '#f04747' : skipped ? '#faa61a' : s.done ? '#43b581' : '#5865f2');
        setStatus((targetLabel ? `<b>Target ${targetLabel}</b> · ` : '') +
            `Deleted <b>${runTotals.deleted + (s.deleted || 0)}</b> · Skipped ${skipped} · Failed ${failed} · Throttled ${runTotals.throttled + (s.throttled || 0)}` +
            (s.stopped ? ' · <b>stopped</b>' : s.aborted ? ' · <b>ended early</b>' : !s.done && s.etaMs ? ` · ETA ${fmtTime(s.etaMs)}` : ''));
    };
    const resetProgress = () => {
        for (const p of [progress, progress2]) {
            p.removeAttribute('max');
            p.value = 0;
            p.style.display = 'none';
            p.style.accentColor = '';
        }
        percent.textContent = '';
        setStatus('');
    };
    const setRunning = () => { startBtn.disabled = true; stopBtn.disabled = false; stopBtn.textContent = 'Stop'; };
    const setIdle = () => { startBtn.disabled = false; stopBtn.disabled = true; stopBtn.textContent = 'Stop'; };
    const pause = async ms => {
        const until = Date.now() + ms;
        while (!stop && Date.now() < until) await new Promise(r => setTimeout(r, 200));
    };

    // ---- run ----
    async function startRun() {
        const val = id => $('#' + id).value.trim();
        const authToken = val('authToken');
        const authorId = val('authorId');
        const guildId = val('guildId');
        const minId = val('minId');
        const maxId = val('maxId');
        const minDate = val('minDate');
        const maxDate = val('maxDate');
        const content = val('content');
        const hasLink = $('#hasLink').checked;
        const hasFile = $('#hasFile').checked;
        const includeNsfw = $('#includeNsfw').checked;
        const includePinned = $('#includePinned').checked;
        const scope = (popover.querySelector('input[name="scope"]:checked') || {}).value || 'single';

        // ---- required fields (fail fast, in plain language, before anything starts) ----
        if (!authToken) { window.alert('Authorization token is required — click Authorization > get.'); return; }
        const purge = !authorId;
        // Blank Author = delete EVERY author's messages in scope (moderator purge). Kept, but made deliberate.
        if (purge && !window.confirm('No Author ID is set.\n\nWith Author blank this deletes EVERYONE\'s messages in the selected scope — a full purge, not just your own posts. Only continue if you moderate this channel and intend that.\n\nContinue?')) return;

        // ---- resolve the targets from the chosen scope ----
        let runGuildId = guildId;
        let targets;
        if (scope === 'server') {
            if (!guildId || guildId === '@me') {
                window.alert('Whole-server mode needs a server open (the Guild ID must be a server, not @me).');
                return;
            }
            targets = [{ id: '', label: 'whole server' }]; // '' => channel_id omitted => guild-wide sweep
        } else if (scope === 'dms') {
            runGuildId = '@me';
            setFollow(false);
            setStatus('Loading your open DMs…');
            const dms = await fetchAllDms(authToken);
            setStatus('');
            if (!dms) return; // alert already shown
            if (!dms.length) { window.alert('No open DM channels found. Open the DMs you want to clear first.'); return; }
            targets = dms;
        } else { // single
            const ids = channelInput.value.trim().split(/\s*,\s*/).filter(Boolean);
            if (!ids.length) {
                window.alert('No channel selected. Open the channel or DM you want (with Follow on), or type a Channel ID.');
                return;
            }
            if (!guildId) { window.alert('Guild ID is empty. Use @me for DMs, or the server ID for server channels.'); return; }
            targets = ids.map(id => ({ id, label: id }));
        }

        // ---- one up-front confirmation for any bulk / multi-target run ----
        const multi = targets.length > 1 || scope !== 'single';
        if (multi) {
            const who = purge ? 'EVERYONE (Author is blank — this is a full purge)' : 'you';
            let what;
            if (scope === 'server') {
                setStatus('Looking up the server…');
                const name = await fetchGuildName(authToken, guildId);
                setStatus('');
                what = `the ENTIRE server ${name ? '"' + name + '"' : '(guild ' + guildId + ')'} — every channel & thread you can see.`;
            } else if (scope === 'dms') {
                const list = targets.slice(0, 15).map(t => '  • ' + t.label).join('\n');
                what = `ALL ${targets.length} of your open DMs & group DMs:\n${list}${targets.length > 15 ? `\n  …and ${targets.length - 15} more` : ''}`;
            } else {
                what = `${targets.length} channels/DMs.`;
            }
            if (!window.confirm(`About to delete messages by ${who} across ${what}\n\nThis can take a long time and cannot be undone.\n\nContinue?`)) return;
        }

        setFollow(false); // navigating around can't change the target mid-run
        stop = false;
        const stopHndl = () => !(stop === true);
        runTotals = { deleted: 0, skipped: 0, failed: 0, throttled: 0 };
        let brokenTargets = 0;
        setRunning();
        resetProgress();
        setBar(0, 1, '#5865f2');

        for (let i = 0; i < targets.length; i++) {
            if (stop) break;
            const t = targets[i];
            targetLabel = multi ? `${i + 1}/${targets.length}` : '';
            if (multi) logger('info', [`▶ Target ${i + 1}/${targets.length}: ${redactUI(t.label)}`]);
            let r = null;
            try {
                r = await deleteMessages(authToken, authorId, runGuildId, t.id, minId || minDate, maxId || maxDate, content, hasLink, hasFile, includeNsfw, includePinned, logger, stopHndl, onProg, !multi);
            } catch (err) {
                logger('error', [`Target ${redactUI(t.label)} crashed: ${escapeUI(err && err.message ? err.message : err)}`]);
                brokenTargets++;
            }
            if (r) {
                runTotals.deleted += r.deleted;
                runTotals.skipped += r.skipped;
                runTotals.failed += r.failed;
                runTotals.throttled += r.throttled;
                if (r.aborted === 'error') brokenTargets++;
                if (r.aborted === 'cloudflare' || r.aborted === 'auth') { logger('error', ['Stopping — the remaining targets were not started.']); break; }
                if (r.stopped) break;
            }
            if (multi && i < targets.length - 1) await pause(1500 + Math.random() * 1000); // short breather between targets
        }
        targetLabel = '';
        if (multi) {
            logger('success', [`All done — deleted ${runTotals.deleted}, skipped ${runTotals.skipped}, failed ${runTotals.failed}` +
                (brokenTargets ? `; ${brokenTargets} target(s) could not be searched (see above)` : '') + '.']);
            setStatus(`Deleted <b>${runTotals.deleted}</b> · Skipped ${runTotals.skipped} · Failed ${runTotals.failed} · Throttled ${runTotals.throttled}` +
                (stop ? ' · <b>stopped</b>' : ''));
        }
    }

    let runInProgress = false;
    startBtn.onclick = async () => {
        if (runInProgress) return; // ignore double-clicks and re-entry (some scopes await a lookup before the buttons lock)
        runInProgress = true;
        try {
            await startRun();
        } catch (err) {
            logger('error', ['Unexpected error: ' + escapeUI(err && err.message ? err.message : err)]);
        } finally {
            runInProgress = false;
            setIdle(); // Start comes back only once the run has fully wound down
        }
    };
    stopBtn.onclick = () => {
        if (!runInProgress) return;
        stop = true;
        stopBtn.disabled = true;
        stopBtn.textContent = 'Stopping…';
    };
    $('#clear').onclick = () => {
        logArea.innerHTML = '';
        if (!runInProgress) resetProgress();
    };
    $('#getToken').onclick = () => {
        const t = grabToken();
        if (t) tokenInput.value = t;
        else window.alert('Could not auto-grab the token. Paste it into the Auth Token box manually.');
    };
    $('#getAuthor').onclick = () => {
        const id = grabAuthorId(tokenInput.value.trim());
        if (id) authorInput.value = id;
        else window.alert('Could not auto-detect your Author ID — fill in the token first, or paste the ID manually.');
    };
    $('#getGuildAndChannel').onclick = () => {
        const m = location.href.match(CHANNEL_RE);
        if (!m) { window.alert('Open a channel or DM first — there is no channel id in the current URL.'); return; }
        guildInput.value = m[1];
        channelInput.value = m[2];
        showLocation(m[1], m[2]);
    };
    $('#redact').onchange = () => {
        popover.classList.toggle('redact') &&
            window.alert('This will attempt to hide personal information, but make sure to double check before sharing screenshots.');
    };

    // ===== Live navigation watcher: keep Guild/Channel IDs synced as you click around =====
    $('#followChannel').addEventListener('change', e => setFollow(e.target.checked));
    // hand-editing an ID locks the target (setting .value from code never fires 'input')
    const lockOnEdit = () => { if (following) setFollow(false); };
    guildInput.addEventListener('input', lockOnEdit);
    channelInput.addEventListener('input', lockOnEdit);
    let lastHref = '';
    const onNav = () => {
        if (location.href === lastHref) return; // dedupe (history patch + poll both call this)
        lastHref = location.href;
        if (following) syncFromLocation();
    };
    if (!window.__undiscord_nav) { // patch history only once, even if the script is initialised twice
        window.__undiscord_nav = true;
        const notify = () => { if (window.__undiscord_onNav) window.__undiscord_onNav(); };
        for (const fn of ['pushState', 'replaceState']) {
            const orig = history[fn];
            history[fn] = function () {
                const ret = orig.apply(this, arguments);
                queueMicrotask(notify);
                return ret;
            };
        }
        window.addEventListener('popstate', () => setTimeout(notify, 0));
    }
    window.__undiscord_onNav = onNav;
    setInterval(onNav, 500); // safety net; costs a single string compare
    setTimeout(onNav, 300);  // first fill once the app has settled

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
