"use strict";

/**
 * HTTP tests for the running site — boots index.js for real, with Baileys stubbed.
 *
 *   NODE_PATH=<dir with express/qrcode/pino/body-parser> node test/server.js
 *
 * Verifies the routes the bot and the browser touch: the page, /version,
 * /health, and the /session/<id> contract the bot fetches with SESSION_ID.
 */

const os = require("os");
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const assert = require("assert");
const Module = require("module");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pair-http-"));
const PORT = 8137;

process.env.DATA_DIR = TMP;
process.env.SESSION_PREFIX = "Astro-X~";
process.env.SESSION_BODY_LENGTH = "12";
process.env.SESSION_KEEP_MINUTES = "0";
process.env.PORT = String(PORT);
delete process.env.VAULT_URL;
delete process.env.VAULT_KEY;

// The site requires Baileys at module load; none of the routes under test reach it.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@whiskeysockets/baileys") return path.join(__dirname, "fake-baileys.js");
  return originalResolve.call(this, request, ...rest);
};

require("../index.js"); // boots the server on PORT
const vault = require("../localVault");

const CREDS_TEXT = JSON.stringify({
  me: { id: "254705894984:1@s.whatsapp.net" },
  registered: true,
  noiseKey: { type: "Buffer", data: Buffer.from("noise-key-bytes").toString("base64") },
});
const SNAPSHOT = {
  version: 1,
  createdAt: Date.now(),
  sessionCreds: [{ key: "creds", value: CREDS_TEXT, updated_at: Date.now() }],
  sessionKeys: [{ type: "pre-key", id: "1", value: JSON.stringify({ a: 1 }), updated_at: Date.now() }],
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

const base = "http://127.0.0.1:" + PORT;

async function waitForServer(attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(base + "/health");
      if (res.ok) return true;
    } catch (_) {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

(async () => {
  console.log("\n[server] booting index.js on port " + PORT);
  const up = await waitForServer();
  check("server answers /health after boot", () => assert.ok(up, "server never came up"));

  const health = await (await fetch(base + "/health")).json();
  check("/health reports local minting (no vault configured)", () => assert.strictEqual(health.minting, "local"));
  check("/health reports the Astro-X~ prefix", () => assert.strictEqual(health.prefix, "Astro-X~"));
  check("/health reports ok:true", () => assert.strictEqual(health.ok, true));

  const version = await (await fetch(base + "/version")).json();
  check("/version serves the build marker", () => assert.ok(String(version.version).startsWith("astro-extra"), version.version));

  const page = await fetch(base + "/");
  const html = await page.text();
  check("GET / serves the page", () => assert.strictEqual(page.status, 200));
  check("the page is the Astro Extra build", () => assert.ok(html.includes("Astro Extra"), "branding missing"));
  check("the page references the hero image", () => assert.ok(html.includes("astro-hero.jpg"), "hero image missing"));
  check("the page ships the token block and copy button", () => {
    assert.ok(html.includes('id="token-block"'), "token block missing");
    assert.ok(html.includes('id="copy-btn"'), "copy button missing");
    assert.ok(html.includes("copyToken"), "copy handler missing");
  });
  check("the page polls /status for the finished token", () => assert.ok(html.includes("'/status/'"), "no status polling"));

  const pairRedirect = await fetch(base + "/pair", { redirect: "manual" });
  check("GET /pair redirects to /", () => assert.ok([301, 302, 307, 308].includes(pairRedirect.status), "got " + pairRedirect.status));

  console.log("\n[server] /status — what the copy button polls");

  const requests = require("../requests");
  const record = requests.create({ number: "254705894984", mode: "code" });

  const pending = await (await fetch(base + "/status/" + record.requestId)).json();
  check("a fresh request reports pending", () => assert.strictEqual(pending.status, "pending"));
  check("no token before the link completes", () => assert.strictEqual(pending.token, null));
  check("the phone number is masked, never raw", () => assert.strictEqual(pending.number, "2547****84"));

  requests.update(record.requestId, { status: "code-ready", code: "ABCD1234" });
  const ready = await (await fetch(base + "/status/" + record.requestId)).json();
  check("the pairing code is exposed once issued", () => assert.strictEqual(ready.code, "ABCD1234"));

  const token = vault.mintFromSnapshot({ phone: "254705894984", snapshot: SNAPSHOT, label: "copy-button" });
  requests.update(record.requestId, { status: "paired", token });
  const statusRes = await fetch(base + "/status/" + record.requestId);
  const paired = await statusRes.json();
  check("the token appears once the link completes", () => assert.strictEqual(paired.token, token));
  check("status is paired", () => assert.strictEqual(paired.status, "paired"));
  check("/status is not cacheable", () => assert.ok(String(statusRes.headers.get("cache-control")).includes("no-store")));
  check("the payload carries no JID or credentials", () =>
    assert.ok(!JSON.stringify(paired).includes("@s.whatsapp.net") && !JSON.stringify(paired).includes("registered")));

  const unknownStatus = await fetch(base + "/status/definitely-not-a-request");
  check("an unknown request id -> 404", () => assert.strictEqual(unknownStatus.status, 404));

  console.log("\n[server] the contract the bot fetches");

  const minted = vault.mintFromSnapshot({ phone: "254705894984", snapshot: SNAPSHOT, label: "http-test" });
  check("a snapshot mints an Astro-X~ ID", () => assert.ok(/^Astro-X~[A-Za-z0-9]{12}$/.test(minted), minted));

  const served = await fetch(base + "/session/" + encodeURIComponent(minted));
  const text = (await served.text()).trim();
  check("GET /session/<id> serves 200", () => assert.strictEqual(served.status, 200));
  check("content-type is text/plain", () => assert.ok(String(served.headers.get("content-type")).includes("text/plain")));
  check("body decodes to the creds that were harvested", () => {
    const tilde = text.indexOf("~");
    assert.ok(tilde > 0, "no ~ separator");
    const creds = JSON.parse(zlib.gunzipSync(Buffer.from(text.slice(tilde + 1), "base64")).toString("utf8"));
    assert.strictEqual(creds.me.id, "254705894984:1@s.whatsapp.net");
    assert.strictEqual(creds.registered, true);
  });
  check("the label before the first ~ uses _ (bot splits on the first tilde)", () => {
    const label = text.slice(0, text.indexOf("~"));
    assert.strictEqual(label, minted.replace(/~/g, "_"));
    assert.ok(!label.includes("~"));
  });
  const folded = await fetch(base + "/session/" + encodeURIComponent(minted.toLowerCase()));
  check("case-folded ID resolves too", () => assert.strictEqual(folded.status, 200));

  const unknown = await fetch(base + "/session/" + encodeURIComponent("Astro-X~ZZZZZZZZZZZZ"));
  check("unknown ID -> 404", () => assert.strictEqual(unknown.status, 404));
  const junk = await fetch(base + "/session/nonsense");
  check("malformed ID -> 404", () => assert.strictEqual(junk.status, 404));
  const oldPrefix = await fetch(base + "/session/" + encodeURIComponent("JUNE-X~ABCDEFGHIJKL"));
  check("the old legacy prefix is no longer served -> 404", () => assert.strictEqual(oldPrefix.status, 404));

  console.log("\n[server] " + pass + " passed, " + fail + " failed\n");
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
