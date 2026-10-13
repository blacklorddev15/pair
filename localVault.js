'use strict';

/**
 * Local vault — this site's own session store.
 *
 * Without this, the only way to get an ID back was to hand the harvested
 * credentials to someone else's server, and that server decided the prefix.
 * In local mode the ID is minted HERE and the blob is served from HERE, so the
 * bot fetches it from this service's own URL and the prefix is ours:
 *
 *   SESSION_PREFIX        default "Astro-X~"
 *   SESSION_BODY_LENGTH   default 12 (the bot's handle pattern allows 4-20)
 *   DATA_DIR              default ./data (sessions.json lives here)
 *   SESSION_KEEP_MINUTES  0 = keep issued sessions until the process restarts
 *
 * Endpoint contract the bot depends on (unchanged):
 *   GET /session/<id> -> text/plain
 *   <id with ~ replaced by _>~<base64(gzip(creds.json))>
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const sessions = new Map(); // id -> { id, blob, createdAt, number, jid, keys, label }

function sessionPrefix() {
  return String(process.env.SESSION_PREFIX || 'Astro-X~').trim();
}

function bodyLength() {
  return Number(process.env.SESSION_BODY_LENGTH || 12);
}

function dataDir() {
  return process.env.DATA_DIR || path.join(__dirname, 'data');
}

function storeFile() {
  return path.join(dataDir(), 'sessions.json');
}

// Same shape the bot itself enforces: ^<prefix>[A-Za-z0-9]{4,20}$, i-flagged.
function idPattern() {
  const escaped = sessionPrefix().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped + '[A-Za-z0-9]{' + bodyLength() + '}$', 'i');
}

function mintSessionId() {
  const body = crypto.randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return sessionPrefix() + body.slice(0, bodyLength());
}

function isSessionId(value) {
  return idPattern().test(String(value || '').trim());
}

function maskNumber(number) {
  const digits = String(number || '').replace(/\D/g, '');
  if (digits.length < 6) return '****';
  return digits.slice(0, 4) + '****' + digits.slice(-2);
}

// The snapshot holds creds.json verbatim, BufferJSON escapes included, so it is
// gzipped exactly as received. Re-encoding it (the way buildBlob() does for creds
// this service generated itself) would base64 every { type: "Buffer", data }
// field a second time and hand the bot a corrupt key.
function blobFromCredsText(text) {
  return zlib.gzipSync(Buffer.from(text, 'utf8')).toString('base64');
}

// The bot splits on the FIRST "~", so the label must not contain one.
function renderSessionBody(id, blob) {
  return String(id).replace(/~/g, '_') + '~' + blob + '\n';
}

function credsTextFromSnapshot(snapshot) {
  const entries = Array.isArray(snapshot?.sessionCreds) ? snapshot.sessionCreds : [];
  const entry = entries.find((candidate) => candidate?.key === 'creds') || entries[0];
  if (!entry) return null;
  const raw = entry.value;
  if (typeof raw === 'string') return raw.trim() ? raw : null;
  // Anything that arrived as JSON is already in its transport encoding.
  if (raw && typeof raw === 'object') return JSON.stringify(raw);
  return null;
}

let saveTimer = null;
function persistSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(dataDir(), { recursive: true });
      const payload = { savedAt: new Date().toISOString(), sessions: Object.fromEntries(sessions) };
      const tmp = storeFile() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, storeFile());
    } catch (error) {
      console.log('[local vault] write failed: ' + error.message);
    }
  }, 500);
}

function loadStore() {
  try {
    if (!fs.existsSync(storeFile())) return;
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    for (const entry of Object.values(raw.sessions || {})) {
      if (entry?.id && entry?.blob) sessions.set(entry.id, entry);
    }
    console.log('[local vault] restored ' + sessions.size + ' session(s) from disk');
  } catch (error) {
    console.log('[local vault] could not read ' + storeFile() + ': ' + error.message);
  }
}

// Case-insensitive on purpose: the bot's own pattern is i-flagged, so a
// case-folded paste passes the bot's check and would otherwise 404 here as
// "unknown or revoked" for what is only a wrong capital.
function findSession(id) {
  const key = String(id || '').trim();
  if (sessions.has(key)) return sessions.get(key);
  const folded = key.toLowerCase();
  for (const [stored, entry] of sessions) {
    if (stored.toLowerCase() === folded) return entry;
  }
  return null;
}

function saveSession(id, credsText, meta) {
  const entry = Object.assign({ id, blob: blobFromCredsText(credsText), createdAt: Date.now() }, meta);
  sessions.set(id, entry);
  persistSoon();
  const keep = Number(process.env.SESSION_KEEP_MINUTES || 0);
  if (keep > 0) {
    setTimeout(() => {
      sessions.delete(id);
      persistSoon();
    }, keep * 60_000).unref?.();
  }
  return entry;
}

/**
 * Mint an ID for a snapshot harvested by the pairing flow.
 * Throws (with a message worth showing) if the creds are missing or incomplete —
 * `registered` is the completeness signal; `me.id` alone is written when a
 * pairing code is merely *requested*.
 */
function mintFromSnapshot({ phone, snapshot, label }) {
  const credsText = credsTextFromSnapshot(snapshot);
  if (!credsText) throw new Error('the harvested creds are missing');
  let creds = null;
  try {
    creds = JSON.parse(credsText);
  } catch (_) {
    throw new Error('the harvested creds are not valid JSON');
  }
  if (!creds?.me?.id) throw new Error('the harvested creds are incomplete (no me.id)');
  if (creds.registered !== true) throw new Error('the harvested creds are incomplete (not registered)');
  const keys = Array.isArray(snapshot?.sessionKeys) ? snapshot.sessionKeys : [];
  const digits = String(phone || '').replace(/\D/g, '');
  const id = mintSessionId();
  saveSession(id, credsText, {
    number: maskNumber(digits),
    jid: creds.me.id,
    keys: keys.length,
    label: typeof label === 'string' ? label.slice(0, 40) : undefined,
  });
  return id;
}

function stats() {
  return { prefix: sessionPrefix(), bodyLength: bodyLength(), sessions: sessions.size, dataDir: dataDir() };
}

function reset() {
  sessions.clear();
}

module.exports = {
  sessions,
  mintSessionId,
  isSessionId,
  findSession,
  saveSession,
  mintFromSnapshot,
  credsTextFromSnapshot,
  blobFromCredsText,
  renderSessionBody,
  maskNumber,
  loadStore,
  persistSoon,
  stats,
  reset,
  sessionPrefix,
  bodyLength,
};
