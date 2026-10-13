'use strict';

/**
 * Pairing request registry.
 *
 * The pairing socket lives inside the /code and /qr routes, but the *page* needs
 * to know when a link finished so it can offer the session token with a copy
 * button. This record is what connects the two: the route creates one and hands
 * its id to the page, and the page polls GET /status/<id>.
 *
 * The token held here is a bearer credential, and /status is public like the
 * rest of the pairing surface — so ids are 12 random characters, never logged in
 * full, and expire (REQUEST_TTL_MINUTES, default 15).
 */

const crypto = require('crypto');

const records = new Map();
const MAX_RECORDS = Number(process.env.MAX_REQUESTS || 200);
const TTL_MS = Number(process.env.REQUEST_TTL_MINUTES || 15) * 60_000;

function maskNumber(number) {
  const digits = String(number || '').replace(/\D/g, '');
  if (digits.length < 6) return '****';
  return digits.slice(0, 4) + '****' + digits.slice(-2);
}

function sweep(now = Date.now()) {
  for (const [id, record] of records) {
    if (now - record.createdAt > TTL_MS) records.delete(id);
  }
  if (records.size > MAX_RECORDS) {
    const byAge = [...records.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const record of byAge.slice(0, records.size - MAX_RECORDS)) records.delete(record.requestId);
  }
}

function create({ number, mode } = {}) {
  const requestId = crypto.randomBytes(9).toString('base64url');
  const record = {
    requestId,
    mode: mode === 'qr' ? 'qr' : 'code',
    number: maskNumber(number),
    status: 'pending', // pending | code-ready | paired | failed
    code: null,
    token: null,
    error: null,
    createdAt: Date.now(),
  };
  records.set(requestId, record);
  sweep();
  return record;
}

function get(requestId) {
  const record = records.get(String(requestId || ''));
  if (!record) return null;
  if (Date.now() - record.createdAt > TTL_MS) {
    records.delete(record.requestId);
    return null;
  }
  return record;
}

function update(requestId, patch) {
  const record = get(requestId);
  if (!record) return null;
  Object.assign(record, patch, { updatedAt: Date.now() });
  return record;
}

/** The shape the page sees — masked number, and never an internal socket. */
function publicView(record) {
  return {
    requestId: record.requestId,
    status: record.status,
    mode: record.mode,
    number: record.number,
    code: record.code,
    token: record.token,
    error: record.error,
    createdAt: record.createdAt,
  };
}

function size() {
  return records.size;
}

function reset() {
  records.clear();
}

module.exports = { create, get, update, publicView, sweep, size, reset };
