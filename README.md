# Astro Extra — session generator

A pairing site for WhatsApp bots: enter a number, get a pairing code (or scan a
QR), link the device, and the session ID arrives in that account's own chat.

This build mints the ID **itself** (`Astro-X~…`) and hands it back from the same
service, so nothing about the credential leaves this server. The upstream lineage
this was imported from delegated the mint to a third-party vault, which is what
fixed its ID prefix to theirs.

## Formats

| `SESSION_FORMAT` | The token looks like | The bot needs |
|---|---|---|
| `raw` **(default)** | `Astro-X~<base64(creds.json)>` — the credentials are inside the token | nothing from this service. Paste it as `SESSION_ID` and it connects. |
| `handle` | `Astro-X~A1B2C3D4E5F6` — a short pointer | to download the credentials from `GET /session/<id>` **while this instance is still up** |

`raw` is the default because a free instance restarts: in `handle` mode every issued
ID dies with the process, which is exactly how a paired session ends up as
`404 unknown session` a few minutes later.

## Endpoints

| Route | What it does |
|---|---|
| `GET /` , `GET /pair` , `GET /qr` | The page (Pair Code / QR tabs). `/pair` redirects to `/` |
| `GET /code?number=` | Baileys pairing code for that number, JSON `{ code }` |
| `GET /qr?t=` | QR image for linking by scan |
| `GET /session/:id` | **`handle` format only.** The blob the bot downloads: `text/plain`, `<id with ~ → _>~<base64(gzip(creds.json))>` |
| `GET /status/:requestId` | What the page polls after a pairing starts: `{ status, code, token, error }` — see the copy button below |
| `GET /health` | `{ ok, version, minting, prefix, format, sessions, uptimeSeconds }` |
| `GET /version` | Build marker — `curl` it to see which code a deployment runs |

After linking, the account receives exactly two messages: `⚡ Generating session
token...` and then the token on its own line. Nothing is sent anywhere else.

### Copy button

`/code` returns a `requestId` alongside the code, and `/qr` returns one in the
`X-Request-Id` header (the page fetches the image as a blob, because an `<img>`
cannot read headers). The page then polls `/status/<requestId>` every 3s and,
when the link completes, shows the token with a **Copy session token** button —
same for both tabs. If the Clipboard API is unavailable (plain http), the button
selects the text instead so a long-press or Ctrl+C still works.

The token in that response is the same bearer credential the chat receives, and
`/status` is public like the rest of the pairing surface. So: request ids are 12
random characters, the phone number in the payload is masked (`2547****84`), no
JID or credential is ever included, records expire (`REQUEST_TTL_MINUTES`,
default 15) and the registry is capped (`MAX_REQUESTS`, default 200). If you would
rather the token only ever reach the phone, delete the token block from
`main.html` — the server side stays harmless.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SESSION_PREFIX` | `Astro-X~` | Start of every issued ID (`~` separates; keep exactly one) |
| `SESSION_FORMAT` | `raw` | `raw` = the token carries the credentials; `handle` = short id + `/session/<id>` fetch |
| `SESSION_BODY_LENGTH` | `12` | Random characters after the prefix — `handle` format only (the bot's pattern allows 4–20) |
| `SESSION_KEEP_MINUTES` | `0` | `handle` format only: `0` = keep issued sessions until the process restarts |
| `DATA_DIR` | `./data` | `handle` format only: where issued sessions persist (`sessions.json`) |
| `VAULT_URL` | *(unset)* | **Optional.** Mint on a remote vault instead of locally |
| `VAULT_KEY` | *(unset)* | **Optional.** The vault's shared secret — required with `VAULT_URL` |
| `REQUEST_TTL_MINUTES` | `15` | How long a `/status` record (and the token in it) stays readable |
| `MAX_REQUESTS` | `200` | Oldest `/status` records are dropped past this |

`VAULT_URL`/`VAULT_KEY` are the only way to leave local mode, and both must be
set (`INTAKE_KEY` is accepted in place of `VAULT_KEY`, matching the vault in
`../session-service`). With no vault configured, no external service is
contacted at all.

The legacy-brand aliases were removed along with the old prefix — a deployment
still carrying only those two variable names now silently mints locally instead
of uploading to a vault.

## Wiring the bot

The variable names below are the **bot's own** (`astro/utils/astroDb/sessionServer.js`
and its panel config); they are deliberately not renamed here, because the
deployed panel already holds those names.

```
# raw format — self-contained, no SESSION_SERVER_URL needed at all
SESSION_ID=Astro-X~<base64(creds.json)>

# handle format — this service must be awake when the bot first fetches
ASTRO_SESSION_SERVER_URL=https://<this-service>.onrender.com
SESSION_ID=Astro-X~XXXXXXXXXXXX
```

The bot accepts `Astro-X~` IDs only. Its `HANDLE_PATTERN`,
`HANDLE_BODY_STRIP` and `SESSION_ID_PREFIX_RE` no longer carry a
prefix alternative at all, so an ID in the old format is refused outright.

In `raw` mode the bot needs nothing from this service after pairing. In `handle`
mode it downloads the credentials once while bootstrapping and then keeps its own
copy — but that one download has to happen while this instance is still up. Point
the bot at whichever host issued its ID.

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
npm run test:server # boots index.js and exercises the HTTP routes (29 checks)
```

`test/server.js` stubs Baileys (`test/fake-baileys.js`) because no route under
test reaches the WhatsApp protocol code, and the library is ~100 MB.

## Licence

GPL-3.0. Derived from the upstream pairing-site lineage — the attribution lives
in [`NOTICE`](NOTICE), which GPL-3.0 requires to be preserved in source
distributions.
