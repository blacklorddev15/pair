# Astro Extra — session generator

A pairing site for WhatsApp bots: enter a number, get a pairing code (or scan a
QR), link the device, and the session ID arrives in that account's own chat.

This build mints the ID **itself** (`Astro-X~…`) and serves it back from the same
service, so nothing about the credential leaves this server. The upstream lineage
this was imported from delegated the mint to a third-party vault, which is what
fixed its ID prefix to theirs.

## Endpoints

| Route | What it does |
|---|---|
| `GET /` , `GET /pair` , `GET /qr` | The page (Pair Code / QR tabs). `/pair` redirects to `/` |
| `GET /code?number=` | Baileys pairing code for that number, JSON `{ code }` |
| `GET /qr?t=` | QR image for linking by scan |
| `GET /session/:id` | The blob the **bot** downloads: `text/plain`, `<id with ~ → _>~<base64(gzip(creds.json))>` |
| `GET /health` | `{ ok, version, minting, prefix, sessions, uptimeSeconds }` |
| `GET /version` | Build marker — `curl` it to see which code a deployment runs |

After linking, the account receives exactly two messages: `⚡ Generating session
token...` and then the token on its own line. Nothing is sent anywhere else.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SESSION_PREFIX` | `Astro-X~` | Start of every issued ID (`~` separates; keep exactly one) |
| `SESSION_BODY_LENGTH` | `12` | Random characters after the prefix (the bot's pattern allows 4–20) |
| `SESSION_KEEP_MINUTES` | `0` | `0` = keep issued sessions until the process restarts |
| `DATA_DIR` | `./data` | Where issued sessions persist (`sessions.json`) |
| `VAULT_URL` | *(unset)* | **Optional.** Mint on a remote vault instead of locally |
| `VAULT_KEY` | *(unset)* | **Optional.** The vault's shared secret — required with `VAULT_URL` |

`VAULT_URL`/`VAULT_KEY` are the only way to leave local mode, and both must be
set; `JUNE_SESSION_SERVER_URL`, `INTAKE_KEY` and `JUNE_INTAKE_KEY` are accepted as
aliases so an existing setup can be pointed here unchanged. With no vault
configured, no external service is contacted at all.

## Wiring the bot

```
JUNE_SESSION_SERVER_URL=https://<this-service>.onrender.com
SESSION_ID=Astro-X~XXXXXXXXXXXX
```

The bot only needs this service while bootstrapping; after the first restore it
keeps its own copy of the credentials. Point the bot at whichever host issued its
ID — if a session was minted by a remote vault, the bot must fetch it from there.

## Deploy on Render

`render.yaml` is Blueprint-ready (service `astro-extra-session`, free plan,
health check `/health`):

```
https://render.com/deploy?repo=https://github.com/blacklorddev15/pair
```

The free plan sleeps after ~15 minutes idle and its disk is ephemeral: a restart
forgets issued sessions, so an ID has to be re-issued. Attach a Render disk and
point `DATA_DIR` at its mount path if IDs must survive restarts.

## Tests

```
npm install
npm test           # local vault: minting, blob format, store (26 checks, offline)
npm run test:server # boots index.js and exercises the HTTP routes (needs deps)
```

`test/server.js` stubs Baileys (`test/fake-baileys.js`) because no route under
test reaches the WhatsApp protocol code, and the library is ~100 MB.

## Licence

GPL-3.0. Derived from the JuneX Ultra generator lineage; the licence and a
derivation note are kept in `package.json`, as GPL requires.
