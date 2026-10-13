"use strict";

/**
 * Stand-in for @whiskeysockets/baileys, used only by test/server.js.
 *
 * The pairing site requires the real library at module load, so booting the
 * server in a test would pull ~100 MB of WhatsApp protocol code that no route
 * under test actually reaches (`/session`, `/health`, `/`, `/version`). This
 * exports the same names the modules destructure, and nothing else.
 */

const makeWASocket = () => ({
  ev: { on() {} },
  ws: { isOpen: false, close() {} },
  sendMessage: async () => ({}),
  requestPairingCode: async () => "ABCD1234",
  authState: { creds: { registered: false } },
});

const useMultiFileAuthState = async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} });
const Browsers = { ubuntu: (name) => ["ubuntu", name], macOS: (name) => ["macOS", name] };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const makeCacheableSignalKeyStore = (keys) => keys;
const fetchLatestBaileysVersion = async () => ({ version: [2, 3000, 0], isLatest: true });
const DisconnectReason = { loggedOut: 401, restartRequired: 515, connectionClosed: 428 };
const jidNormalizedUser = (jid) => String(jid || "").split(":")[0] + "@s.whatsapp.net";

module.exports = {
  default: makeWASocket,
  makeWASocket,
  useMultiFileAuthState,
  Browsers,
  delay,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  jidNormalizedUser,
};
