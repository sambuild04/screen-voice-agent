# Samuel trial proxy

Cloudflare Worker that lets the Samuel DMG ship without bundling an OpenAI API key. New users get a small daily trial through this proxy; once they enter their own key in Settings the app routes directly to OpenAI and bypasses this proxy entirely.

## What it does

- Relays a fixed allowlist of OpenAI endpoints:
  - `POST /v1/realtime/client_secrets` (mints ephemeral keys for voice)
  - `POST /v1/audio/transcriptions` (Whisper)
  - `POST /v1/chat/completions`
  - `POST /v1/responses`
- Adds the `Authorization: Bearer <OPENAI_KEY>` header upstream — the key lives only in the Worker's encrypted secrets, never on the user's disk.
- Rate-limits per installation (UUID generated on first launch in the app), with a per-IP secondary cap and a global daily USD spend circuit breaker.
- Exposes `GET /trial/status` so the app can show "Trial: 7m of 10m used today".

## Trial limits

| Endpoint | Per installation per day | Per IP per day | Approx cost charged |
|---|---|---|---|
| `/v1/realtime/client_secrets` | 3 mints | 15 | $1.50/mint estimate |
| `/v1/audio/transcriptions` | 30 calls | 200 | $0.01/call |
| `/v1/chat/completions` | 100 calls | 600 | $0.005/call |
| `/v1/responses` | 5 calls | 30 | $0.50/call |

A "mint" is one realtime session. The audio itself flows directly between the user's machine and OpenAI (the proxy never sees it) but billing is on your account.

The global circuit breaker stops minting/relaying when total spend that day reaches `DAILY_BUDGET_USD` (default `$10`).

## Deploy

```bash
cd proxy
npm install

# 1. Authenticate to Cloudflare (opens a browser)
npx wrangler login

# 2. Create the KV namespace and paste the ID into wrangler.toml
npx wrangler kv:namespace create "RATE_LIMIT_KV"
# → Output: id = "abc123..."  put that in wrangler.toml

# 3. Set the OpenAI key (encrypted; not stored in repo)
npx wrangler secret put OPENAI_KEY
# → paste sk-... when prompted

# 4. (Optional) adjust DAILY_BUDGET_USD in wrangler.toml

# 5. Deploy
npx wrangler deploy
```

After deploy you'll get a URL like `https://samuel-proxy.<your-account>.workers.dev`. Update the bundled default in [`electron/handlers/config.ts`](../electron/handlers/config.ts) (`DEFAULT_PROXY_URL`) to point at your deployed Worker, then rebuild and re-package the DMG.

## Local dev

```bash
npx wrangler dev
# Worker runs at http://localhost:8787
```

In the app, set `SAMUEL_PROXY_URL=http://localhost:8787` in your shell before running `pnpm electron:dev` to route through your local Worker.

## Operational notes

- Counter keys auto-expire after 48 hours, so KV doesn't grow.
- Tail live logs: `npx wrangler tail`.
- Update the OpenAI key without redeploying: `npx wrangler secret put OPENAI_KEY` again.
- A user that wants to "reset" their trial can `rm ~/.samuel/installation-id` (mints a new UUID on next launch). The per-IP cap is the floor that keeps that from being a one-line bypass; tune it down if abuse shows up in `wrangler tail`.
- Cost estimates in `LIMITS` are upper bounds; refine after a week of real traffic by reading actual OpenAI billing.

## Threat model

The proxy is **not** a hard security boundary. It exists to:

1. Keep the OpenAI key out of the DMG (which is a public, unzippable artifact).
2. Bound your maximum daily spend exposure to `DAILY_BUDGET_USD`.
3. Make casual abuse expensive enough that BYOK becomes the easier path.

It does **not**:

- Authenticate users (anyone with the URL can hit it; the rate limits are the defense).
- Encrypt request bodies beyond TLS.
- Prevent a determined attacker from generating fresh installation IDs and rotating IPs to drain the daily budget.

If your DMG goes wide and the daily budget keeps tripping, the right fix is to lower the per-IP cap, lower the daily budget, or add Cloudflare Turnstile / Bot Management in front. BYOK is always the unlimited path.
