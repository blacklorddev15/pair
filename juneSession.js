'use strict';

/**
 * Remote vault bridge — used ONLY when a vault is configured explicitly in
 * vault.js. Local minting (localVault.js) is the default and does not touch any
 * of this.
 *
 * After WhatsApp links, the site harvests the Baileys auth folder into a
 * snapshot and uploads it to a vault's intake endpoint, which stores the creds
 * blob and returns the session handle that vault mints. The handle then belongs
 * to that vault: it is resolved against that host, and its prefix is whatever
 * that operator chose — which is why nothing here has a built-in default.
 *
 * Environment variables:
 *   VAULT_URL      Where to upload (JUNE_SESSION_SERVER_URL also accepted).
 *   VAULT_KEY      The vault's shared secret (INTAKE_KEY / JUNE_INTAKE_KEY
 *                  also accepted).
 *
 * Both are required: half a configuration silently falls back to local minting
 * rather than contacting a half-known host.
 */

const fs = require('fs');
const path = require('path');

// No baked-in defaults on purpose. The upstream build shipped a third-party URL
// and site key here, which is exactly why the ID prefix could never be changed:
// every handle was minted on someone else's server. This module is now only
// reached in remote mode — a vault configured explicitly in vault.js.
const DEFAULT_SERVER_URL = '';

// Same order as the June Ultra client: longest/most-specific prefixes first.
const KEY_TYPES = [
    'app-state-sync-version',
    'app-state-sync-key',
    'sender-key-memory',
    'sender-key',
    'identity-key',
    'device-list',
    'lid-mapping',
    'pre-key',
    'session',
    'tctoken',
];

function parseKeyFilename(filename) {
    if (!filename.endsWith('.json') || filename === 'creds.json') return null;
    const base = filename.slice(0, -'.json'.length);
    const type = KEY_TYPES.find((candidate) => base.startsWith(`${candidate}-`));
    if (!type) return null;
    const encodedId = base.slice(type.length + 1);
    if (!encodedId) return null;
    return { type, id: encodedId.replace(/__/g, '/').replace(/-/g, ':') };
}

function scanKeyFiles(sessionDir) {
    try {
        let count = 0;
        let bytes = 0;
        for (const name of fs.readdirSync(sessionDir)) {
            if (name === 'creds.json' || !name.endsWith('.json')) continue;
            count += 1;
            bytes += fs.statSync(path.join(sessionDir, name)).size;
        }
        return { count, bytes };
    } catch (_) {
        return { count: 0, bytes: 0 };
    }
}

/**
 * Wait until the Signal key files stop changing (pre-key bundles etc. are
 * written right after linking). Bounded at maxWaitMs.
 *
 * Polls every 400ms and requires 3 consecutive identical scans (~1.6s when
 * keys land instantly). Both the file count AND total bytes are compared, so
 * a key file being rewritten in place also counts as "still moving".
 */
async function waitForKeysToSettle(sessionDir, { stablePolls = 3, intervalMs = 400, maxWaitMs = 40000 } = {}) {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const start = Date.now();
    let last = { count: -1, bytes: -1 };
    let stable = 0;
    while (Date.now() - start < maxWaitMs) {
        await delay(intervalMs);
        const scan = scanKeyFiles(sessionDir);
        if (scan.count === last.count && scan.bytes === last.bytes && scan.count > 0) {
            stable += 1;
            if (stable >= stablePolls) return { count: scan.count, settled: true, waitedMs: Date.now() - start };
        } else {
            stable = 0;
        }
        last = scan;
    }
    return { count: last.count, settled: false, waitedMs: Date.now() - start };
}

/**
 * Build the snapshot in the exact shape June Ultra's restore path expects
 * (mirrors the official session server's harvest, including the verified
 * auth meta rows).
 */
function harvestSnapshot(sessionDir) {
    const credsPath = path.join(sessionDir, 'creds.json');
    if (!fs.existsSync(credsPath)) throw new Error('creds.json missing after pairing');
    const credsValue = fs.readFileSync(credsPath, 'utf8');
    JSON.parse(credsValue); // validate

    const now = Date.now();
    const sessionKeys = [];
    for (const name of fs.readdirSync(sessionDir)) {
        const parsed = parseKeyFilename(name);
        if (!parsed) continue;
        const value = fs.readFileSync(path.join(sessionDir, name), 'utf8');
        JSON.parse(value); // validate
        sessionKeys.push({ type: parsed.type, id: parsed.id, value, updated_at: now });
    }
    if (sessionKeys.length === 0) throw new Error('no signal key files were generated');

    return {
        version: 1,
        createdAt: now,
        sessionCreds: [{ key: 'creds', value: credsValue, updated_at: now }],
        sessionKeys,
        sessionAuthMeta: [
            { key: 'status', value: 'verified' },
            { key: 'source', value: 'june-session-server' },
            { key: 'paired_at', value: String(now) },
        ],
    };
}

/** The June session server base URL (env override or primary default). */
function juneServerUrl() {
    return String(process.env.VAULT_URL || process.env.JUNE_SESSION_SERVER_URL || DEFAULT_SERVER_URL).trim().replace(/\/+$/, '');
}

/**
 * Wake the June session server early. Free-tier hosting (Koyeb) sleeps the
 * instance after ~1h idle and the wake-up can take seconds — that must not
 * land between "Generating session..." and the token. Called fire-and-forget
 * the moment a visitor starts pairing (tens of seconds before the mint),
 * so the server is warm by the time the user has typed the code.
 * Never throws.
 */
async function prewarmJuneServer() {
    try {
        await fetch(`${juneServerUrl()}/health`, { signal: AbortSignal.timeout(20000) });
    } catch (_) { /* best effort only */ }
}

/**
 * Upload the snapshot and mint the official JUNE-X~ handle.
 * Returns the canonical handle string.
 */
async function mintJuneToken({ phone, label, snapshot }) {
    const serverUrl = juneServerUrl();
    const key = String(process.env.VAULT_KEY || process.env.INTAKE_KEY || process.env.JUNE_INTAKE_KEY || '').trim();
    if (!key) throw new Error('no vault key is configured — set VAULT_KEY (or INTAKE_KEY for a vault that speaks the same intake API)');

    const post = () => fetch(`${serverUrl}/intake/session`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ phone, label: label || undefined, snapshot }),
        signal: AbortSignal.timeout(30000),
    });

    let response;
    try {
        response = await post();
    } catch (networkError) {
        // A network hiccup (typically the server still waking up) must not
        // kill an otherwise good pairing — retry once after a short pause.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        response = await post();
    }
    const data = await response.json().catch(() => null);
    const token = data && (data.token || data.handle);
    if (!response.ok || !data || !data.ok || !token) {
        throw new Error(`session server intake failed: ${data && data.message ? data.message : `HTTP ${response.status}`}`);
    }
    return token;
}

module.exports = { waitForKeysToSettle, harvestSnapshot, mintJuneToken, prewarmJuneServer, juneServerUrl, parseKeyFilename };
