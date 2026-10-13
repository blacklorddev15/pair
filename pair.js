const { makeid } = require('./id');
const express = require('express');
const fs = require('fs');
const pino = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    Browsers,
    delay,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    DisconnectReason,
    jidNormalizedUser,
} = require("@whiskeysockets/baileys");
const { waitForKeysToSettle, harvestSnapshot, mintJuneToken, prewarmJuneServer } = require('./juneSession');

const router = express.Router();

function removeFile(filePath) {
    if (!fs.existsSync(filePath)) return false;
    fs.rmSync(filePath, { recursive: true, force: true });
}

/** Resolves once client.ws is open, or rejects after `timeoutMs` */
function waitForWsOpen(client, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
            if (client.ws && client.ws.isOpen) return resolve();
            if (Date.now() > deadline) return reject(new Error('WS open timeout'));
            setTimeout(tick, 150);
        };
        tick();
    });
}

router.get('/', async (req, res) => {
    const id = makeid();
    let num = req.query.number;

    // Wake the June session server NOW — the user will spend the next
    // 30-60s typing the pairing code, and the server must be warm by the
    // time we mint the token (free-tier instances sleep when idle).
    prewarmJuneServer().catch(() => {});

    // Exactly ONE pairing code per request. A reconnect must never request a
    // second code: the new request invalidates the code the user is already
    // typing into WhatsApp — the cause of "Couldn't link device" after flaky
    // disconnects.
    let codeIssued = false;
    let reconnects = 0;
    const MAX_RECONNECTS = 3;

    async function JUNEX() {
        const { state, saveCreds } = await useMultiFileAuthState('./temp/' + id);
        try {
            // No hardcoded fallback version — a stale one makes WhatsApp
            // reject the pairing code ("Couldn't link device"). If the fetch
            // fails, let Baileys use its bundled (current) version instead.
            const version = (await fetchLatestBaileysVersion().catch(() => null))?.version;
            const logger = pino({ level: 'silent' });

            const client = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger),
                },
                printQRInTerminal: false,
                logger,
                browser: Browsers.ubuntu('Chrome'),
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 10000,
            });

            client.ev.on('creds.update', saveCreds);

            // Request pairing code as soon as the WS noise handshake finishes
            // (before WhatsApp enters QR mode with pair-device IQ).
            // We poll ws.isOpen then add ~800ms for the noise handshake to settle.
            waitForWsOpen(client)
                .then(() => delay(800))
                .then(async () => {
                    if (res.headersSent || client.authState.creds.registered) return;
                    if (codeIssued) return; // keep the already-shown code live
                    try {
                        const cleanNum = num.replace(/[^0-9]/g, '');
                        const code = await client.requestPairingCode(cleanNum);
                        codeIssued = true;
                        if (!res.headersSent) res.send({ code });
                    } catch (e) {
                        console.log('Pairing code request error:', e.message);
                        if (!res.headersSent) res.send({ code: 'Service Currently Unavailable' });
                        removeFile('./temp/' + id);
                    }
                })
                .catch(e => {
                    console.log('WS open error:', e.message);
                    if (!res.headersSent) res.send({ code: 'Service Currently Unavailable' });
                    removeFile('./temp/' + id);
                });

            client.ev.on('connection.update', async (s) => {
                const { connection, lastDisconnect } = s;

                if (connection === 'open') {
                    try {
                        const startedAt = Date.now();
                        // Normalize JID: strips device suffix (:X) so messages reach the user's chat
                        const userJid = jidNormalizedUser(client.user.id);
                        const dir = __dirname + '/temp/' + id;

                        // Re-warm the June server right now in case the wake-up
                        // from the code request is stale or failed — the mint is
                        // seconds away and must not pay a cold start.
                        prewarmJuneServer().catch(() => {});

                        // Watch the key files; send the intro WITHOUT waiting for
                        // WhatsApp to acknowledge it — the pipeline (harvest →
                        // mint) must not queue behind the intro delivery.
                        const settlePromise = waitForKeysToSettle(dir);
                        client.sendMessage(userJid, { text: '⚡ Generating session...' }).catch(() => {});
                        const settle = await settlePromise;

                        const snapshot = harvestSnapshot(dir);
                        const phone = String(client.user.id).split(':')[0].split('@')[0].replace(/\D/g, '');
                        const token = await mintJuneToken({ phone, snapshot });
                        console.log(`[pair] ${id} session delivered in ${Date.now() - startedAt}ms (settle ${settle.settled ? 'ok' : 'timeout'} ${settle.waitedMs}ms, ${settle.count} key files)`);

                        // The bare token — one-tap copy.
                        const session = await client.sendMessage(userJid, { text: token });
                        await client.sendMessage(userJid, {
                            text: "```🟢 Session Linked..\n\n🟢 Paste it as SESSION_ID during deploy.\n🟢 Support: https://wa.me/message/254798952773```"
                        }, { quoted: session });
                        await delay(500);
                        await client.ws.close();
                        removeFile('./temp/' + id);
                    } catch (e) {
                        console.log('Error sending session messages:', e.message);
                        try {
                            await client.sendMessage(jidNormalizedUser(client.user.id), {
                                text: `⚠️ Session could not be completed (${e.message}). Please pair again.`
                            });
                        } catch (_) {}
                        try { await client.ws.close(); } catch (_) {}
                        removeFile('./temp/' + id);
                    }
                } else if (connection === 'close') {
                    const code = lastDisconnect?.error?.output?.statusCode;
                    if (code !== DisconnectReason.loggedOut) {
                        // Reconnecting with the SAME auth folder keeps the
                        // already-issued pairing code valid; the cap stops a
                        // dead network from looping forever.
                        reconnects += 1;
                        if (reconnects <= MAX_RECONNECTS) {
                            await delay(5000);
                            JUNEX();
                        } else {
                            removeFile('./temp/' + id);
                        }
                    } else {
                        removeFile('./temp/' + id);
                    }
                }
            });

        } catch (err) {
            console.log('Pair service error:', err.message);
            removeFile('./temp/' + id);
            if (!res.headersSent) res.send({ code: 'Service Currently Unavailable' });
        }
    }

    await JUNEX();
});

module.exports = router;
