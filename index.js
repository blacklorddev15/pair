const express = require('express');
const fs = require('fs');
const app = express();
__path = process.cwd();

// Ensure temp dir exists (Heroku ephemeral FS starts empty)
if (!fs.existsSync('./temp')) fs.mkdirSync('./temp', { recursive: true });
const bodyParser = require("body-parser");
const port = process.env.PORT || 8000;
const { prewarm, mode } = require('./vault');
const localVault = require('./localVault');
const requests = require('./requests');
let server = require('./qr'),
code = require('./pair');
require('events').EventEmitter.defaultMaxListeners = 500;
app.use(express.static(__path));
// Simple version marker so anyone can check which code a deployment runs:
//   curl https://<site>/version
// Bump this on every meaningful change.
const VERSION = 'astro-extra-2026.10.13';

// Baileys' bundled libsignal dumps "Closing session: SessionEntry {...}"
// (including private key buffers) straight to console.log when a pairing
// socket closes — pure noise, and key material does not belong in logs.
const __origLog = console.log;
console.log = (...args) => {
    if (args.length && String(args[0]).startsWith('Closing session:')) return;
    __origLog(...args);
};

app.use('/qr', server);
app.use('/code', code);
app.use('/pair', (req, res) => res.redirect('/'))
app.use('/ping', (req, res) => {
    res.send('alive');
})
app.use('/version', (req, res) => {
    res.json({ version: VERSION, uptimeSeconds: Math.floor(process.uptime()) });
})
// Sessions minted here are served from here too — this is the URL the bot
// fetches with SESSION_ID. Contract: text/plain,
//   <id with ~ replaced by _>~<base64(gzip(creds.json))>
// A trailing newline is included, which the bot's split-then-decode ignores.
app.get('/session/:id', (req, res) => {
    const id = String(req.params.id || '').trim();
    if (!localVault.isSessionId(id)) return res.status(404).type('text/plain').send('unknown session\n');
    const entry = localVault.findSession(id);
    if (!entry) return res.status(404).type('text/plain').send('unknown session\n');
    res.set('Cache-Control', 'no-store');
    res.type('text/plain').send(localVault.renderSessionBody(entry.id, entry.blob));
})
// What the page polls after the pairing code appears, to offer the finished
// token with a copy button. Ids come from requests.js (12 random characters)
// and expire; the token here is the same bearer credential the chat receives.
app.get('/status/:requestId', (req, res) => {
    const record = requests.get(String(req.params.requestId || ''));
    if (!record) return res.status(404).json({ status: 'unknown' });
    res.set('Cache-Control', 'no-store');
    res.json(requests.publicView(record));
})
app.get('/health', (req, res) => {
    const stats = localVault.stats();
    res.json({
        ok: true,
        version: VERSION,
        minting: mode(),          // "local" unless a vault is configured
        prefix: stats.prefix,
        sessions: stats.sessions,
        uptimeSeconds: Math.floor(process.uptime())
    });
})
app.use('/',async (req, res, next) => {
    // Wake a remote vault from the very first page visit — the earliest possible
    // moment (the pairing mint comes minutes later). No-op in local mode.
    prewarm().catch(() => {});
    res.sendFile(__path + '/main.html')
})
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
localVault.loadStore(); // issued sessions survive a restart when DATA_DIR is persistent

app.listen(port, () => {
    console.log(`📡 Connected on http://localhost:` + port +
        ` — ${localVault.stats().prefix} IDs, ${mode()} minting`)
})

module.exports = app
