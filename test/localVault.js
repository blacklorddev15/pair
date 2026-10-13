"use strict";

/**
 * Local vault tests — pure, no network, no Baileys, no express.
 *
 *   node test/localVault.js        (or: npm run test:vault)
 *
 * Covers what the prefix change actually depends on: the ID that gets minted,
 * the blob that gets served, and the store in between.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const assert = require("assert");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pair-vault-"));
process.env.DATA_DIR = TMP;
process.env.SESSION_PREFIX = "Astro-X~";
process.env.SESSION_BODY_LENGTH = "12";
process.env.SESSION_KEEP_MINUTES = "0";

const vault = require("../localVault");

// The bot's own handle check, copied verbatim.
const BOT_HANDLE_PATTERN = /^(?:JUNE-X|ASTRO-X)~[A-Za-z0-9]{4,20}$/i;

const CREDS_TEXT = JSON.stringify({
  me: { id: "254705894984:1@s.whatsapp.net", name: "Astro" },
  registered: true,
  platform: "smba",
  noiseKey: { type: "Buffer", data: Buffer.from("noise-key-bytes").toString("base64") },
  signedIdentityKey: { type: "Buffer", data: Buffer.from("identity-bytes").toString("base64") },
});
const SNAPSHOT = {
  version: 1,
  createdAt: Date.now(),
  sessionCreds: [{ key: "creds", value: CREDS_TEXT, updated_at: Date.now() }],
  sessionKeys: [
    { type: "pre-key", id: "1", value: JSON.stringify({ private: "x" }), updated_at: Date.now() },
    { type: "session", id: "2:3", value: JSON.stringify({ session: "y" }), updated_at: Date.now() },
  ],
  sessionAuthMeta: [{ key: "status", value: "verified" }],
};

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log("  \u2714 " + name);
  } catch (error) {
    fail += 1;
    console.log("  \u2718 " + name + " \u2014 " + error.message);
  }
}

(async () => {
  console.log("\n[vault] minting");

  check("SESSION_PREFIX is what gets minted", () => assert.strictEqual(vault.sessionPrefix(), "Astro-X~"));
  const id = vault.mintSessionId();
  check("minted ID starts with Astro-X~", () => assert.ok(id.startsWith("Astro-X~"), id));
  check("minted ID satisfies the bot's handle pattern", () => assert.ok(BOT_HANDLE_PATTERN.test(id), id));
  check("minted body is 12 characters", () => assert.strictEqual(id.slice("Astro-X~".length).length, 12));
  check("two mints differ", () => assert.notStrictEqual(vault.mintSessionId(), vault.mintSessionId()));

  check("isSessionId accepts the minted ID", () => assert.ok(vault.isSessionId(id)));
  check("isSessionId accepts a case-folded paste (bot pattern is i-flagged)", () =>
    assert.ok(vault.isSessionId(id.toLowerCase())));
  check("isSessionId rejects the old JUNE-X~ prefix", () => assert.ok(!vault.isSessionId("JUNE-X~ABCDEFGHIJKL")));
  check("isSessionId rejects a 3-char body (bot needs 4-20)", () => assert.ok(!vault.isSessionId("Astro-X~ABC")));

  process.env.SESSION_PREFIX = "ASTRO X:~";
  check("a different prefix is honoured (env-driven, no code change)", () => {
    assert.ok(vault.mintSessionId().startsWith("ASTRO X:~"));
    assert.ok(vault.isSessionId("ASTRO X:~ABCD1234EFGH"));
  });
  process.env.SESSION_PREFIX = "Astro-X~";

  console.log("\n[vault] snapshot -> ID");

  check("a complete snapshot mints an Astro-X~ ID", () => assert.ok(BOT_HANDLE_PATTERN.test(vault.mintFromSnapshot({ phone: "254705894984", snapshot: SNAPSHOT }))));
  check("missing creds is refused", () => {
    assert.throws(() => vault.mintFromSnapshot({ phone: "2547", snapshot: { sessionCreds: [] } }), /creds are missing/);
  });
  check("creds that are not JSON are refused", () => {
    assert.throws(
      () => vault.mintFromSnapshot({ phone: "2547", snapshot: { sessionCreds: [{ key: "creds", value: "{nope" }] } }),
      /not valid JSON/
    );
  });
  check("creds without me.id are refused", () => {
    assert.throws(
      () => vault.mintFromSnapshot({ phone: "2547", snapshot: { sessionCreds: [{ key: "creds", value: JSON.stringify({ registered: true }) }] } }),
      /no me.id/
    );
  });
  check("creds without registered:true are refused (me.id alone is not proof)", () => {
    assert.throws(
      () => vault.mintFromSnapshot({ phone: "2547", snapshot: { sessionCreds: [{ key: "creds", value: JSON.stringify({ me: { id: "2547:1@s.whatsapp.net" } }) }] } }),
      /not registered/
    );
  });

  console.log("\n[vault] what the bot downloads");

  const minted = vault.mintFromSnapshot({ phone: "254705894984", snapshot: SNAPSHOT, label: "test" });
  const entry = vault.findSession(minted);
  check("the minted ID is in the store", () => assert.ok(entry && entry.id === minted));
  check("lookup is case-insensitive", () => assert.ok(vault.findSession(minted.toLowerCase())));
  check("an unknown ID is not found", () => assert.strictEqual(vault.findSession("Astro-X~ZZZZZZZZZZZZ"), null));

  const body = vault.renderSessionBody(entry.id, entry.blob).trim();
  check("body is <label>~<base64>", () => assert.ok(body.indexOf("~") > 0));
  check("the label carries the ID with ~ replaced by _ (bot splits on the first ~)", () =>
    assert.strictEqual(body.slice(0, body.indexOf("~")), minted.replace(/~/g, "_")));

  let decodedText = null;
  check("payload gunzips to the creds byte-for-byte", () => {
    decodedText = zlib.gunzipSync(Buffer.from(body.slice(body.indexOf("~") + 1), "base64")).toString("utf8");
    assert.strictEqual(decodedText, CREDS_TEXT);
  });
  check("Buffer fields are not double-encoded", () => {
    const creds = JSON.parse(decodedText);
    assert.strictEqual(creds.noiseKey.data, JSON.parse(CREDS_TEXT).noiseKey.data);
    assert.strictEqual(creds.registered, true);
  });
  check("meta is recorded without the raw number", () => {
    assert.strictEqual(entry.number, "2547****84");
    assert.strictEqual(entry.jid, "254705894984:1@s.whatsapp.net");
    assert.strictEqual(entry.keys, 2);
  });

  console.log("\n[vault] persistence");

  await new Promise((resolve) => setTimeout(resolve, 900));
  check("sessions.json is written under DATA_DIR", () => assert.ok(fs.existsSync(path.join(TMP, "sessions.json"))));
  check("the store file holds the minted ID", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(TMP, "sessions.json"), "utf8"));
    assert.ok(raw.sessions[minted], "minted ID missing from the store file");
    assert.strictEqual(raw.sessions[minted].blob, entry.blob);
  });

  check("stats reports the prefix and the count", () => {
    const stats = vault.stats();
    assert.strictEqual(stats.prefix, "Astro-X~");
    assert.ok(stats.sessions >= 1);
  });

  console.log("\n[vault] " + pass + " passed, " + fail + " failed\n");
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
