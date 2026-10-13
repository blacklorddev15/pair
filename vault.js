'use strict';

/**
 * Where a pairing gets its session ID from.
 *
 * Local (the default): localVault.js mints the ID and serves the blob from this
 * service. Nothing leaves the server, and the prefix is whatever SESSION_PREFIX
 * says — Astro-X~ out of the box.
 *
 * Remote: only when a vault is configured explicitly, both URL and key:
 *
 *   VAULT_URL=https://<vault-host>      (JUNE_SESSION_SERVER_URL also accepted)
 *   VAULT_KEY=<shared secret>           (INTAKE_KEY / JUNE_INTAKE_KEY also accepted)
 *
 * The upstream build shipped a third-party URL and site key as built-in
 * defaults, which is precisely why its prefix could not be changed: the ID was
 * always minted on someone else's server. Those defaults are gone — with no
 * vault configured, nothing remote is contacted at all.
 */

const { waitForKeysToSettle, harvestSnapshot, mintJuneToken, prewarmJuneServer } = require('./juneSession');
const local = require('./localVault');

function remoteConfig() {
  const url = String(process.env.VAULT_URL || process.env.JUNE_SESSION_SERVER_URL || '')
    .trim()
    .replace(/\/+$/, '');
  const key = String(process.env.VAULT_KEY || process.env.INTAKE_KEY || process.env.JUNE_INTAKE_KEY || '').trim();
  return url && key ? { url, key } : null;
}

function mode() {
  return remoteConfig() ? 'remote' : 'local';
}

/** Mint the session ID for a freshly harvested snapshot. */
async function mintToken({ phone, snapshot, label }) {
  if (remoteConfig()) return mintJuneToken({ phone, snapshot, label });
  return local.mintFromSnapshot({ phone, snapshot, label });
}

/** Wake a remote vault early (free-tier hosts sleep); no-op in local mode. */
async function prewarm() {
  if (remoteConfig()) await prewarmJuneServer();
}

module.exports = Object.assign(
  { mintToken, prewarm, mode, remoteConfig, waitForKeysToSettle, harvestSnapshot },
  local
);
