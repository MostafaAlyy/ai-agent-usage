// SPDX-FileCopyrightText: 2026 Mostafa Aly
// SPDX-License-Identifier: MIT OR GPL-2.0-or-later

/* Gather AI agent usage into one cached JSON snapshot.
 *
 * Run as its own process -- `gjs -m collector.js` -- never inside GNOME Shell.
 * It talks to a local CLI over stdio and makes one HTTPS request, neither of
 * which belongs on the compositor's thread. The extension spawns this
 * asynchronously and learns the result by watching the snapshot file.
 *
 *     gjs -m collector.js [--force] [--print]
 *
 * Security
 * --------
 * Only access tokens are read, straight from the stores their own CLIs
 * write: Claude Code's token and `agy`'s Google OAuth session (login
 * keyring, service "gemini"). Refresh tokens are never touched, so this
 * cannot mint or rotate a credential. Each token goes to exactly one place:
 * the Claude token to api.anthropic.com, the Google token to
 * cloudcode-pa.googleapis.com, the OpenCode key to opencode.ai. Nothing but
 * percentages, reset times and a plan label is ever logged or written to the
 * snapshot.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const SCHEMA_VERSION = 1;
const STATE_DIR = GLib.build_filenamev([GLib.get_user_state_dir(), 'agent-usage']);
const SNAPSHOT = GLib.build_filenamev([STATE_DIR, 'usage.json']);
const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'agent-usage']);

/* Anthropic rate-limits the usage endpoint itself, so a recent answer is
 * reused unless the user explicitly asked for fresh numbers. */
const CLAUDE_PROBE_MIN_INTERVAL_SECONDS = 120;
const RPC_TIMEOUT_MS = 8000;

const STATUS = {
    ok: 'ok',
    notConfigured: 'not_configured',
    auth: 'auth',
    error: 'error',
};

function log_(message) {
    printerr(`agent-usage: ${message}`);
}

/* ------------------------------------------------------------------ shared */

function searchPath() {
    /* A systemd user unit starts with a minimal PATH, so a CLI installed by
     * npm, bun or mise is invisible to it. This is also the PATH a located CLI
     * must be *run* with: finding `codex` is no use if the child process then
     * cannot find the runtime it shells out to. */
    const home = GLib.get_home_dir();
    const extra = [
        `${home}/.local/bin`, `${home}/bin`, '/usr/local/bin', '/usr/bin', '/bin',
        `${home}/.npm-global/bin`, `${home}/.bun/bin`,
        `${home}/.local/share/mise/shims`,
    ];
    const seen = new Set();
    return [...(GLib.getenv('PATH') ?? '').split(':'), ...extra]
        .filter(part => part && !seen.has(part) && seen.add(part))
        .join(':');
}

const SEARCH_PATH = searchPath();

function which(name) {
    for (const dir of SEARCH_PATH.split(':')) {
        const candidate = GLib.build_filenamev([dir, name]);
        if (GLib.file_test(candidate, GLib.FileTest.IS_EXECUTABLE))
            return candidate;
    }
    return null;
}

function readJson(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return null;
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

function saveJson(path, value) {
    try {
        Gio.File.new_for_path(path).get_parent().make_directory_with_parents(null);
    } catch (error) {
        if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            throw error;
    }
    /* replace_contents with a backing swap gives an atomic rename, so a reader
     * never sees a half-written snapshot. */
    Gio.File.new_for_path(path).replace_contents(
        new TextEncoder().encode(`${JSON.stringify(value)}\n`),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

function isoOrNull(value) {
    if (value === null || value === undefined || value === '' || value === 0)
        return null;
    if (typeof value === 'number') {
        const stamp = GLib.DateTime.new_from_unix_utc(value);
        return stamp ? stamp.format_iso8601() : null;
    }
    const parsed = GLib.DateTime.new_from_iso8601(String(value), null);
    return parsed ? parsed.format_iso8601() : null;
}

function windowLabel(minutes) {
    const mins = Number(minutes) || 0;
    if (mins === 10080)
        return 'Weekly';
    if (mins === 1440)
        return 'Daily';
    if (mins && mins % 60 === 0)
        return `${mins / 60}h`;
    if (mins)
        return `${mins}m`;
    return 'Limit';
}

/* `percent` is already on a 0..100 scale; callers settle the scale for their
 * whole payload first, because a lone 0.0 or 1.0 cannot. */
function limit(key, label, percent, resetsAt, group = 'primary') {
    const value = Number(percent);
    if (!Number.isFinite(value) || value < 0)
        return null;
    return {
        key,
        label,
        percent: Math.round(Math.min(value, 999) * 10) / 10,
        resetsAt: isoOrNull(resetsAt),
        group,
    };
}

function record(id, name, fields) {
    return {
        schemaVersion: SCHEMA_VERSION,
        id,
        name,
        available: fields.status === STATUS.ok,
        status: STATUS.error,
        plan: '',
        message: '',
        limits: [],
        balance: null,
        updatedAt: GLib.DateTime.new_now_local().format_iso8601(),
        ...fields,
        ...{limits: (fields.limits ?? []).filter(entry => entry)},
    };
}

function windowStillOpen(entry) {
    /* A cached percentage describes a window; once it has rolled over the
     * figure describes a period that is over, and a stale 78% would misreport
     * an allowance that is now untouched. */
    if (!entry?.resetsAt)
        return true;
    const resets = GLib.DateTime.new_from_iso8601(entry.resetsAt, null);
    if (!resets)
        return true;
    return resets.difference(GLib.DateTime.new_now_utc()) > 0;
}

/* ------------------------------------------------------------- antigravity */

const AGY_PORT_CACHE = GLib.build_filenamev([CACHE_DIR, 'antigravity-port.json']);
/* The cloudcode endpoint the IDE's language server itself proxies to. Calling
 * it directly means quotas work without the IDE running -- `agy` keeps the
 * OAuth token below fresh on every run and via its remote-control daemon. */
const AGY_QUOTA_ENDPOINT = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';

function findAntigravityCandidatePorts() {
    const candidates = [];
    const cached = readJson(AGY_PORT_CACHE)?.port;
    if (cached && typeof cached === 'number')
        candidates.push(cached);

    try {
        const inodes = new Set();
        const procDir = Gio.File.new_for_path('/proc');
        const enumerator = procDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let fileInfo;
        while ((fileInfo = enumerator.next_file(null)) !== null) {
            const pid = fileInfo.get_name();
            if (!/^\d+$/.test(pid))
                continue;
            try {
                const commPath = `/proc/${pid}/comm`;
                const [ok, commBytes] = GLib.file_get_contents(commPath);
                if (!ok)
                    continue;
                const comm = new TextDecoder().decode(commBytes).trim().toLowerCase();
                if (comm.includes('agy') || comm.includes('antigravity') || comm.includes('localharness')) {
                    const fdDir = Gio.File.new_for_path(`/proc/${pid}/fd`);
                    const fdEnum = fdDir.enumerate_children('standard::name,standard::symlink-target', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
                    let fdInfo;
                    while ((fdInfo = fdEnum.next_file(null)) !== null) {
                        const target = fdInfo.get_symlink_target();
                        if (target && target.startsWith('socket:[')) {
                            inodes.add(target.slice(8, -1));
                        }
                    }
                }
            } catch {}
        }

        for (const netPath of ['/proc/net/tcp', '/proc/net/tcp6']) {
            try {
                const [ok, tcpBytes] = GLib.file_get_contents(netPath);
                if (!ok)
                    continue;
                const lines = new TextDecoder().decode(tcpBytes).split('\n');
                for (let i = 1; i < lines.length; i++) {
                    const parts = lines[i].trim().split(/\s+/);
                    if (parts.length >= 10) {
                        const localAddr = parts[1];
                        const st = parts[3];
                        const inode = parts[9];
                        if (st === '0A') { // TCP_LISTEN
                            const [, portHex] = localAddr.split(':');
                            const port = parseInt(portHex, 16);
                            if (inodes.has(inode)) {
                                candidates.push(port);
                            }
                        }
                    }
                }
            } catch {}
        }
    } catch {}

    return [...new Set(candidates)];
}

function probeAntigravityRpc(port, method) {
    const session = new Soup.Session({timeout: 2, user_agent: 'agent-usage/1'});
    const uri = `http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/${method}`;
    const message = Soup.Message.new('POST', uri);
    message.request_headers.append('Content-Type', 'application/json');
    message.set_request_body_from_bytes('application/json', new GLib.Bytes(new TextEncoder().encode('{}')));

    try {
        const bytes = session.send_and_read(message, null);
        if (message.get_status() === 200 && bytes) {
            return JSON.parse(new TextDecoder().decode(bytes.get_data()));
        }
    } catch {}
    return null;
}

/* `agy` persists its Google OAuth session in the login keyring under
 * service "gemini" / username "antigravity". Only the access token is read;
 * it is sent to exactly one place (cloudcode-pa.googleapis.com) and never
 * logged, cached, or written anywhere. A missing or locked keyring is not an
 * error -- the language-server probe below is tried next. */
function readAgyAccessToken() {
    let Secret = null;
    try {
        Secret = imports.gi.Secret;
    } catch {
        return null;
    }
    try {
        const schema = new Secret.Schema('org.freedesktop.Secret.Generic',
            Secret.SchemaFlags.NONE, {
                service: Secret.SchemaAttributeType.STRING,
                username: Secret.SchemaAttributeType.STRING,
            });
        const password = Secret.password_lookup_sync(
            schema, {service: 'gemini', username: 'antigravity'}, null);
        if (!password)
            return null;
        const stored = JSON.parse(password);
        const token = String(stored?.token?.access_token ?? '').trim();
        return token || null;
    } catch {
        return null;
    }
}

/* Same payload the IDE's RetrieveUserQuotaSummary RPC returns, fetched over
 * plain HTTPS. Returns the quota object or null when the token is missing,
 * expired, or the network failed. */
function fetchAgyQuotaDirect() {
    const accessToken = readAgyAccessToken();
    if (!accessToken)
        return null;
    /* The endpoint only answers its own clients; this request carries the
     * user's own `agy` OAuth token, so it identifies as one. */
    const session = new Soup.Session({timeout: 12, user_agent: 'antigravity/linux/amd64'});
    const message = Soup.Message.new('POST', AGY_QUOTA_ENDPOINT);
    message.request_headers.append('Authorization', `Bearer ${accessToken}`);
    message.request_headers.append('Content-Type', 'application/json');
    message.set_request_body_from_bytes('application/json', new GLib.Bytes(new TextEncoder().encode('{}')));
    let bytes;
    try {
        bytes = session.send_and_read(message, null);
    } catch {
        return null;
    }
    if (message.get_status() !== 200 || !bytes)
        return null;
    try {
        const payload = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        const quota = payload?.groups ? payload : payload?.response;
        return quota?.groups ? quota : null;
    } catch {
        return null;
    }
}

/* Buckets shared by both quota paths (direct HTTPS and language-server RPC).
 * Disabled buckets describe windows that do not currently apply -- showing a
 * 0% bar for one while its sibling window is exhausted would misreport. */
function antigravityLimitsFromQuota(quotaData) {
    const limits = [];
    for (const group of (quotaData.groups ?? [])) {
        const isPrimary = group.displayName?.toLowerCase().includes('gemini');
        const groupType = isPrimary ? 'primary' : 'scoped';

        for (const bucket of (group.buckets ?? [])) {
            if (bucket.disabled)
                continue;
            const fraction = Number(bucket.remainingFraction ?? 1);
            const usedPercent = Math.max(0, Math.min(100, (1 - fraction) * 100));
            const resetsAt = bucket.resetTime ?? null;

            let label = bucket.displayName ?? 'Limit';
            if (bucket.bucketId === 'gemini-5h' || bucket.window === '5h') {
                label = isPrimary ? 'Gemini · 5h' : 'Claude & GPT · 5h';
            } else if (bucket.bucketId === 'gemini-weekly' || bucket.window === 'weekly') {
                label = isPrimary ? 'Gemini · Weekly' : 'Claude & GPT · Weekly';
            } else if (group.displayName) {
                label = `${group.displayName} · ${bucket.displayName}`;
            }

            const item = limit(bucket.bucketId ?? label, label, usedPercent, resetsAt, groupType);
            if (item)
                limits.push(item);
        }
    }
    return limits;
}

async function collectAntigravity(force) {
    const fallbackCache = GLib.build_filenamev([CACHE_DIR, 'antigravity-usage.json']);
    const cached = readJson(fallbackCache) ?? {};
    const fallback = (cached.limits ?? []).filter(entry => windowStillOpen(entry));
    const cachedPlan = cached.plan ?? '';

    /* Fresh quotas straight from the account: the keyring holds `agy`'s own
     * OAuth session, so this works whether or not the IDE (or any language
     * server) is running. */
    const direct = fetchAgyQuotaDirect();
    if (direct) {
        const limits = antigravityLimitsFromQuota(direct);
        if (limits.length) {
            saveJson(fallbackCache, {limits, plan: cachedPlan, updatedAt: GLib.DateTime.new_now_local().format_iso8601()});
            return record('antigravity', 'Google Antigravity', {
                status: STATUS.ok,
                limits,
                plan: cachedPlan || 'Google AI',
            });
        }
    }

    /* Second route in: the IDE's language server, when it is running. */
    const candidatePorts = findAntigravityCandidatePorts();
    let workingPort = null;
    let quotaData = null;

    for (const port of candidatePorts) {
        const res = probeAntigravityRpc(port, 'RetrieveUserQuotaSummary');
        if (res?.response?.groups) {
            workingPort = port;
            quotaData = res.response;
            break;
        }
    }

    if (!workingPort || !quotaData) {
        if (fallback.length) {
            return record('antigravity', 'Google Antigravity', {
                status: STATUS.ok,
                limits: fallback,
                plan: cachedPlan || 'Google AI Pro',
                stale: true,
                message: 'Could not reach Google quotas; showing last known limits. Run `agy` to refresh the sign-in.',
            });
        }
        return record('antigravity', 'Google Antigravity', {
            status: STATUS.notConfigured,
            message: 'agy is not signed in. Run `agy` once to log in with Google.',
        });
    }

    saveJson(AGY_PORT_CACHE, {port: workingPort});

    let plan = cachedPlan || '';
    try {
        const userStatus = probeAntigravityRpc(workingPort, 'GetUserStatus');
        if (userStatus?.userTier?.name)
            plan = userStatus.userTier.name;
    } catch {}

    const limits = antigravityLimitsFromQuota(quotaData);

    if (limits.length === 0) {
        if (fallback.length) {
            return record('antigravity', 'Google Antigravity', {
                status: STATUS.ok,
                limits: fallback,
                plan,
                stale: true,
                message: 'No quota buckets returned by Antigravity; showing last known limits.',
            });
        }
        return record('antigravity', 'Google Antigravity', {
            status: STATUS.error,
            plan,
            message: 'Antigravity reported no active rate limits.',
        });
    }

    saveJson(fallbackCache, {limits, plan, updatedAt: GLib.DateTime.new_now_local().format_iso8601()});

    return record('antigravity', 'Google Antigravity', {
        status: STATUS.ok,
        limits,
        plan: plan || 'Google AI',
    });
}

/* ------------------------------------------------------------------- codex */

/* The Codex CLI ships an `app-server` subcommand speaking JSON-RPC over stdio,
 * the same transport its editor integrations use. Two calls give us the plan
 * and every rate-limit window.
 *
 * This is NOT a documented public API, so it is fenced into this one function:
 * if OpenAI renames the methods, only this has to change. No credential is
 * involved -- the CLI is already authenticated and the RPC never returns one. */
async function collectCodex() {
    const codex = which('codex');
    if (!codex) {
        return record('codex', 'Codex', {
            status: STATUS.notConfigured,
            message: 'The codex CLI was not found in PATH.',
        });
    }

    let proc = null;
    try {
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDIN_PIPE
                 | Gio.SubprocessFlags.STDOUT_PIPE
                 | Gio.SubprocessFlags.STDERR_SILENCE,
        });
        // The CLI shells out to its own runtime, so it needs the same
        // augmented PATH we found it on, not the unit's minimal one.
        launcher.setenv('PATH', SEARCH_PATH, true);
        // read-only sandbox and untrusted approvals: this process must never
        // be able to touch the filesystem or act on our behalf.
        proc = launcher.spawnv([codex, '-s', 'read-only', '-a', 'never', 'app-server']);

        const stdin = proc.get_stdin_pipe();
        const stdout = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});

        const send = payload => {
            const line = `${JSON.stringify(payload)}\n`;
            stdin.write_all(new TextEncoder().encode(line), null);
            stdin.flush(null);
        };

        const request = (id, method, params = {}) => new Promise((resolve, reject) => {
            const deadline = GLib.get_monotonic_time() + RPC_TIMEOUT_MS * 1000;
            const readNext = () => {
                if (GLib.get_monotonic_time() > deadline) {
                    reject(new Error(`${method} timed out`));
                    return;
                }
                stdout.read_line_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
                    let bytes;
                    try {
                        [bytes] = source.read_line_finish(result);
                    } catch (error) {
                        reject(error);
                        return;
                    }
                    if (bytes === null) {
                        reject(new Error(`${method}: the app server closed the stream`));
                        return;
                    }
                    let message;
                    try {
                        message = JSON.parse(new TextDecoder().decode(bytes));
                    } catch {
                        readNext();   // notifications and log lines share the stream
                        return;
                    }
                    if (message.id !== id) {
                        readNext();
                        return;
                    }
                    if (message.error) {
                        reject(new Error(String(message.error.message ?? 'RPC error')));
                        return;
                    }
                    resolve(message.result ?? {});
                });
            };
            send({id, method, params});
            readNext();
        });

        await request(1, 'initialize', {clientInfo: {name: 'agent-usage', version: '1'}});
        send({method: 'initialized', params: {}});
        const accountResult = await request(2, 'account/read');
        const rateResult = await request(3, 'account/rateLimits/read');

        const account = accountResult.account ?? {};
        const rateLimits = rateResult.rateLimits ?? {};
        const byId = rateResult.rateLimitsByLimitId;

        const windows = (prefix, title, bucket) => {
            const out = [];
            const cleanTitle = title.replace(/^GPT-[\d.]+-Codex-/, '').trim();
            for (const slot of ['primary', 'secondary']) {
                const win = bucket?.[slot];
                if (!win)
                    continue;
                const label = cleanTitle ? `${cleanTitle} · ${windowLabel(win.windowDurationMins)}` : windowLabel(win.windowDurationMins);
                out.push(limit(`${prefix}.${slot}`, label, win.usedPercent, win.resetsAt, title ? 'scoped' : 'primary'));
            }
            return out.filter(entry => entry);
        };

        const limits = windows('codex', '', rateLimits);

        /* rateLimitsByLimitId carries model-scoped allowances -- a Spark-only
         * weekly window, say -- that the flat primary/secondary pair never
         * shows. Only named buckets other than the account-wide one are added. */
        const mainId = String(rateLimits.limitId ?? '');
        if (byId && typeof byId === 'object') {
            for (const limitId of Object.keys(byId).sort()) {
                if (limitId === mainId)
                    continue;
                const bucket = byId[limitId];
                limits.push(...windows(limitId, String(bucket?.limitName ?? limitId).trim(), bucket));
            }
        }

        const planRaw = String(rateLimits.planType ?? account.planType ?? account.type ?? '');
        const plan = planRaw ? planRaw.charAt(0).toUpperCase() + planRaw.slice(1) : '';

        if (limits.length === 0) {
            return record('codex', 'Codex', {
                status: account.requiresOpenaiAuth && !account.email ? STATUS.auth : STATUS.error,
                plan,
                message: account.requiresOpenaiAuth && !account.email
                    ? 'Run `codex login` to authenticate.'
                    : 'Codex reported no rate limits.',
            });
        }

        const credits = rateLimits.credits;
        let balance = null;
        if (credits?.unlimited)
            balance = {label: 'Credits', text: 'Unlimited'};
        else if (credits?.hasCredits)
            balance = {label: 'Credits', text: String(credits.balance ?? '0')};

        return record('codex', 'Codex', {
            status: STATUS.ok,
            plan,
            limits,
            balance,
            message: rateLimits.spendControlReached ? 'Spend control reached.' : '',
        });
    } catch (error) {
        return record('codex', 'Codex', {
            status: STATUS.error,
            message: `Could not read Codex usage: ${error.message}`,
        });
    } finally {
        try {
            proc?.force_exit();
        } catch { /* already gone */ }
    }
}

/* ------------------------------------------------------------------ claude */

const CLAUDE_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

function claudeDir() {
    const configured = (GLib.getenv('CLAUDE_CONFIG_DIR') ?? '').trim();
    return configured || GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
}

function planLabel(tier, subscription) {
    const match = /max[_-]?(\d+x)/i.exec(String(tier ?? ''));
    if (match)
        return `Max ${match[1].toLowerCase()}`;
    for (const name of [tier, subscription]) {
        const text = String(name ?? '').trim();
        if (text) {
            return text.replace('default_claude_', '').replace(/_/g, ' ')
                .replace(/\b\w/g, character => character.toUpperCase());
        }
    }
    return '';
}

function scopedWindow(kind) {
    const text = String(kind ?? '').toLowerCase();
    if (text.includes('month'))
        return 'Monthly';
    if (text.includes('week') || text.includes('day'))
        return 'Weekly';
    if (text.includes('hour') || text.includes('session'))
        return '5h';
    return '';
}

/* One payload speaks one convention, so the scale is settled once for every
 * field rather than guessed per field. */
function usesPercentScale(payload) {
    const samples = [];
    for (const key of ['five_hour', 'seven_day', 'seven_day_oauth_apps'])
        samples.push(payload?.[key]?.utilization);
    if (Array.isArray(payload?.limits))
        samples.push(...payload.limits.map(entry => entry?.percent));
    return samples.some(value => Number(value) > 1);
}

function asPercent(value, isPercentScale) {
    const number = Number(value);
    if (!Number.isFinite(number))
        return null;
    return isPercentScale ? number : number * 100;
}

/* The one function that knows Anthropic's OAuth usage endpoint. Undocumented,
 * so it is deliberately isolated. */
function probeClaudeUsage(accessToken) {
    const session = new Soup.Session({timeout: 12, user_agent: 'agent-usage/1'});
    const message = Soup.Message.new('GET', CLAUDE_USAGE_ENDPOINT);
    message.request_headers.append('Authorization', `Bearer ${accessToken}`);
    message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');
    message.request_headers.append('Accept', 'application/json');

    let body;
    try {
        body = session.send_and_read(message, null);
    } catch {
        // No server was reached at all -- no route, no DNS.
        return {ok: false, status: STATUS.error, message: "Couldn't reach Anthropic. Check your connection."};
    }

    const code = message.get_status();
    if (code === 429) {
        const retry = message.response_headers.get_one('retry-after');
        return {
            ok: false,
            status: STATUS.error,
            message: `Anthropic is rate limiting usage checks.${retry ? ` Retry after ${retry}s.` : ''}`,
        };
    }
    if (code === 401 || code === 403) {
        return {
            ok: false,
            status: STATUS.auth,
            message: "Claude Code's sign-in was rejected. Start Claude Code to refresh it.",
        };
    }
    if (code < 200 || code >= 300)
        return {ok: false, status: STATUS.error, message: `Usage endpoint returned status ${code}.`};

    let payload;
    try {
        payload = JSON.parse(new TextDecoder().decode(body.get_data()));
    } catch {
        return {ok: false, status: STATUS.error, message: 'Anthropic returned unreadable usage data.'};
    }

    const isPercent = usesPercentScale(payload);
    const limits = [];

    if (payload.five_hour) {
        limits.push(limit('session', '5h',
            asPercent(payload.five_hour.utilization, isPercent), payload.five_hour.resets_at));
    }
    const weekly = payload.seven_day_oauth_apps ?? payload.seven_day;
    if (weekly)
        limits.push(limit('weekly', 'Weekly', asPercent(weekly.utilization, isPercent), weekly.resets_at));

    /* Model-scoped allowances only ever appear in the `limits` array -- the
     * matching flat keys (seven_day_opus, ...) stay null even when the account
     * is actively spending against them. */
    const seen = new Set();
    if (Array.isArray(payload.limits)) {
        for (const entry of payload.limits) {
            const model = entry?.scope?.model;
            if (!model)
                continue;
            const name = String(model.display_name ?? model.id ?? '').trim();
            const kind = String(entry.kind ?? '').trim();
            if (!name || seen.has(`${name}|${kind}`))
                continue;
            seen.add(`${name}|${kind}`);
            const window = scopedWindow(kind);
            limits.push(limit(`scoped.${name}.${kind}`, window ? `${name} · ${window}` : name,
                asPercent(entry.percent, isPercent), entry.resets_at, 'scoped'));
        }
    }

    const usable = limits.filter(entry => entry);
    if (usable.length === 0)
        return {ok: false, status: STATUS.error, message: 'Anthropic returned no usage limits.'};
    return {ok: true, limits: usable};
}

async function collectClaude(force) {
    const credentials = readJson(GLib.build_filenamev([claudeDir(), '.credentials.json']));
    const login = credentials?.claudeAiOauth;
    const accessToken = String(login?.accessToken ?? '');
    const expiresAt = Number(login?.expiresAt ?? 0);
    const plan = planLabel(login?.rateLimitTier, login?.subscriptionType);

    const probeCache = GLib.build_filenamev([CACHE_DIR, 'claude-usage.json']);
    const cached = readJson(probeCache) ?? {};
    const fallback = (cached.limits ?? []).filter(entry => windowStillOpen(entry));

    if (!accessToken) {
        return record('claude', 'Claude Code', {
            status: GLib.file_test(claudeDir(), GLib.FileTest.IS_DIR) ? STATUS.auth : STATUS.notConfigured,
            message: 'Claude Code is not signed in. Run `claude` to log in.',
            limits: fallback,
            plan,
        });
    }

    /* Only the Claude Code CLI can mint a token: it refreshes the credential
     * file when it runs, so a machine left alone long enough finds the saved
     * token lapsed. Say so, and keep showing the last numbers whose window has
     * not since reset. */
    if (expiresAt > 0 && expiresAt <= Date.now()) {
        return record('claude', 'Claude Code', {
            status: STATUS.auth,
            message: `Claude Code's saved sign-in expired.${fallback.length ? ' Showing the last known limits.' : ''} Start Claude Code to refresh it.`,
            limits: fallback,
            plan,
            stale: fallback.length > 0,
        });
    }

    const fetchedAt = Number(cached.fetchedAt ?? 0);
    if (fallback.length && !force && Date.now() / 1000 - fetchedAt < CLAUDE_PROBE_MIN_INTERVAL_SECONDS)
        return record('claude', 'Claude Code', {status: STATUS.ok, limits: fallback, plan, balance: cached.balance ?? null});

    const probe = probeClaudeUsage(accessToken);
    if (probe.ok) {
        saveJson(probeCache, {fetchedAt: Date.now() / 1000, limits: probe.limits, balance: null});
        return record('claude', 'Claude Code', {status: STATUS.ok, limits: probe.limits, plan});
    }
    if (fallback.length) {
        return record('claude', 'Claude Code', {
            status: STATUS.ok, limits: fallback, plan, stale: true, message: probe.message,
        });
    }
    return record('claude', 'Claude Code', {status: probe.status, message: probe.message, plan});
}

/* -------------------------------------------------------------- opencode go */

/* OpenCode Go is a $10/month subscription with spend-based windows: $12 per
 * rolling 5 hours, $30 per week, $60 per month. The official usage endpoint
 * reports each window's used percent and reset time directly.
 *
 * This is the one function that knows the endpoint, so it is deliberately
 * isolated. Only the API key OpenCode itself stores is read; it is sent to
 * exactly one place (opencode.ai) and never logged. */
const OPENCODE_GO_USAGE_ENDPOINT = 'https://opencode.ai/zen/go/v1/usage';
const OPENCODE_GO_WINDOWS = [
    {key: 'rolling', label: '5h · $12'},
    {key: 'weekly', label: 'Weekly · $30'},
    {key: 'monthly', label: 'Monthly · $60'},
];

function opencodeGoApiKey() {
    const auth = readJson(GLib.build_filenamev([GLib.get_user_data_dir(), 'opencode', 'auth.json']));
    const key = String(auth?.['opencode-go']?.key ?? '').trim();
    return key || null;
}

function probeOpencodeGoUsage(apiKey) {
    const session = new Soup.Session({timeout: 12, user_agent: 'agent-usage/1'});
    const message = Soup.Message.new('GET', OPENCODE_GO_USAGE_ENDPOINT);
    message.request_headers.append('Authorization', `Bearer ${apiKey}`);
    message.request_headers.append('Accept', 'application/json');

    let body;
    try {
        body = session.send_and_read(message, null);
    } catch {
        return {ok: false, status: STATUS.error, message: "Couldn't reach opencode.ai. Check your connection."};
    }

    const code = message.get_status();
    if (code === 401 || code === 403) {
        return {
            ok: false,
            status: STATUS.auth,
            message: 'The OpenCode Go key was rejected. Run `/connect` in opencode to reconnect it.',
        };
    }
    if (code < 200 || code >= 300)
        return {ok: false, status: STATUS.error, message: `Usage endpoint returned status ${code}.`};

    let payload;
    try {
        payload = JSON.parse(new TextDecoder().decode(body.get_data()));
    } catch {
        return {ok: false, status: STATUS.error, message: 'opencode.ai returned unreadable usage data.'};
    }

    const usage = payload?.usage ?? {};
    const limits = [];
    let message_ = '';
    for (const window of OPENCODE_GO_WINDOWS) {
        const entry = usage[window.key];
        if (entry && String(entry.status ?? 'ok') !== 'ok' && !message_)
            message_ = `The ${window.key} window reports: ${entry.status}.`;
        const item = limit(window.key, window.label, Number(entry?.percent), entry?.resetsAt ?? null);
        if (item)
            limits.push(item);
    }
    if (!limits.length)
        return {ok: false, status: STATUS.error, message: 'opencode.ai returned no usage windows.'};
    return {ok: true, limits, message: message_};
}

async function collectOpencodeGo(force) {
    const apiKey = opencodeGoApiKey();

    const probeCache = GLib.build_filenamev([CACHE_DIR, 'opencode-go-usage.json']);
    const cached = readJson(probeCache) ?? {};
    const fallback = (cached.limits ?? []).filter(entry => windowStillOpen(entry));

    if (!apiKey) {
        return record('opencode-go', 'OpenCode Go', {
            status: GLib.file_test(
                GLib.build_filenamev([GLib.get_user_data_dir(), 'opencode']), GLib.FileTest.IS_DIR)
                ? STATUS.auth
                : STATUS.notConfigured,
            message: 'OpenCode Go is not connected. Run `/connect` in opencode and add the Go API key.',
            limits: fallback,
            plan: 'Go',
            stale: fallback.length > 0,
        });
    }

    const fetchedAt = Number(cached.fetchedAt ?? 0);
    if (fallback.length && !force && Date.now() / 1000 - fetchedAt < CLAUDE_PROBE_MIN_INTERVAL_SECONDS)
        return record('opencode-go', 'OpenCode Go', {status: STATUS.ok, limits: fallback, plan: 'Go'});

    const probe = probeOpencodeGoUsage(apiKey);
    if (probe.ok) {
        saveJson(probeCache, {fetchedAt: Date.now() / 1000, limits: probe.limits});
        return record('opencode-go', 'OpenCode Go', {status: STATUS.ok, limits: probe.limits, plan: 'Go', message: probe.message});
    }
    if (fallback.length) {
        return record('opencode-go', 'OpenCode Go', {
            status: STATUS.ok, limits: fallback, plan: 'Go', stale: true, message: probe.message,
        });
    }
    return record('opencode-go', 'OpenCode Go', {status: probe.status, message: probe.message, plan: 'Go'});
}

/* -------------------------------------------------------------------- main */

const PROVIDERS = [
    {id: 'antigravity', run: force => collectAntigravity(force)},
    {id: 'codex', run: collectCodex},
    {id: 'claude', run: force => collectClaude(force)},
    {id: 'opencode-go', run: force => collectOpencodeGo(force)},
];

async function main(argv) {
    const force = argv.includes('--force');
    const shouldPrint = argv.includes('--print');

    const previous = (readJson(SNAPSHOT) ?? {}).providers ?? {};
    const providers = {};

    /* One provider must never break the snapshot: each is awaited on its own,
     * and a thrown error becomes that provider's error entry beside the ones
     * that worked. */
    const results = await Promise.all(PROVIDERS.map(async provider => {
        try {
            return [provider.id, await provider.run(force)];
        } catch (error) {
            log_(`${provider.id}: ${error.message}`);
            return [provider.id, record(provider.id, provider.id, {
                status: STATUS.error, message: 'The collector failed for this provider.',
            })];
        }
    }));

    for (const [id, entry] of results) {
        /* Keep the last good numbers when a provider fails transiently: a
         * stale percentage is still true until its window rolls over, and
         * showing it beats blanking a card because the network blinked. */
        if (entry.limits.length === 0 && entry.status !== STATUS.notConfigured) {
            const usable = (previous[id]?.limits ?? []).filter(windowStillOpen);
            if (usable.length) {
                entry.limits = usable;
                entry.stale = true;
                entry.plan ||= previous[id]?.plan ?? '';
            }
        }
        providers[id] = entry;
        log_(`${id}: ${entry.status}`);
    }

    const snapshot = {
        schemaVersion: SCHEMA_VERSION,
        updatedAt: GLib.DateTime.new_now_local().format_iso8601(),
        providers,
    };
    saveJson(SNAPSHOT, snapshot);
    log_(`wrote ${SNAPSHOT}`);
    if (shouldPrint)
        print(JSON.stringify(snapshot, null, 2));
    return 0;
}

const loop = new GLib.MainLoop(null, false);
let exitCode = 0;
main(ARGV)
    .then(code => {
        exitCode = code;
    })
    .catch(error => {
        log_(`fatal: ${error.message}`);
        exitCode = 1;
    })
    .finally(() => loop.quit());
loop.run();
imports.system.exit(exitCode);
