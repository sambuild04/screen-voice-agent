# Samuel Privacy Policy

_Last updated: June 6, 2026._

Samuel is a voice-first AI assistant that runs on your Mac. This document
describes exactly what data Samuel handles, where it goes, and what stays
on your machine. It is written to be technically accurate; if anything in
the app's behavior contradicts this document, please report it as a bug.

## TL;DR

- **Nothing is collected by default.** All listening, screen-reading, and
  computer-control capabilities are OFF until you turn them on in
  Settings, and macOS asks you to grant the underlying permission the
  first time each one is used.
- **All your memory and settings live on your Mac**, in `~/.samuel/` and
  your browser's local storage. Samuel never uploads them anywhere.
- **Voice and screen content is sent to OpenAI** when (and only when) you
  use a feature that needs OpenAI to process it. You choose how:
  - **Bring-your-own-key (BYOK)** — your data goes directly to OpenAI
    using your key. The Samuel servers see nothing.
  - **Free trial mode** — your data passes through a thin Samuel proxy
    that adds the OpenAI key on its way upstream. The proxy keeps a
    short-lived per-day rate-limit counter; it does not store the
    content of your requests.
- **There is no analytics, telemetry, advertising SDK, or third-party
  tracker** in the app.

## What Samuel collects, by capability

Each row corresponds to a toggle in **Settings → Privacy**. If the toggle
is off, Samuel does not collect that data. macOS will independently
prompt you for the underlying system permission the first time the
feature is used, and you can revoke it any time in **System Settings →
Privacy & Security**.

| Setting | What is collected when ON | Where it goes |
|---|---|---|
| Voice Input | Your microphone audio while you speak | OpenAI (Realtime / Whisper) for transcription and conversation |
| Audio Listening | A short rolling buffer of recent ambient audio so Samuel can react when you say "Hey Samuel" | Wake-word detection runs locally; only the segment after the wake word is sent to OpenAI |
| Audio Recording | An on-demand recording you explicitly ask Samuel to make | OpenAI for transcription if you ask Samuel to transcribe it; otherwise stays local |
| Screen Watch | Periodic screenshots of your active screen | OpenAI vision models for analysis; not retained between turns |
| Screen Read | A screenshot of your screen at the moment you ask | OpenAI vision models for analysis; not retained between turns |
| Computer Use | Synthesized keyboard and mouse events that Samuel sends to other apps you have running | Local to your Mac. The screenshots Samuel takes to plan its actions are sent to OpenAI as above. |
| Local Time | Your computer's current time and timezone | OpenAI, only when relevant to a question you asked |
| Location | Your approximate location, via macOS Location Services | OpenAI, only when relevant to a question you asked |

## What is stored on your Mac

Samuel keeps the following on your local disk. None of it is uploaded:

- `~/.samuel/installation-id` — a randomly generated UUID, created the
  first time you run Samuel. It is sent to the Samuel proxy (in trial
  mode only) so the proxy can apply per-installation rate limits.
  Delete the file to reset your trial allotment.
- `~/.samuel/` — your conversation history, learned memory, plugin data,
  and other agent state. You can read or delete any of it.
- `~/.books-reader.json` — your settings file, including your OpenAI API
  key if you provided one. Stored as plaintext JSON; protect it like any
  other secret.
- Browser local storage in the Electron window — your UI preferences
  (window size, accent color, privacy toggle states). Cleared when you
  uninstall the app.

You can wipe Samuel's local state at any time:

```bash
rm -rf ~/.samuel ~/.books-reader.json
```

## What the Samuel proxy does and doesn't do

When you have not provided your own OpenAI API key, Samuel routes a
small set of OpenAI endpoints through a Cloudflare Worker
(`samuel-proxy.boshenfeng.workers.dev`). The proxy exists for one reason
only: so trial users can use the app without needing to sign up for
OpenAI. The full source of the proxy is in the `proxy/` directory of the
Samuel repository — you can audit it.

When the proxy receives a request:

1. It reads two headers: your `X-Installation-Id` (the UUID above) and
   your IP address (provided by Cloudflare as `CF-Connecting-IP`).
2. It checks two daily counters in a short-lived key-value store:
   one keyed by your installation ID, one keyed by your IP. Both
   counters auto-expire after 48 hours. They store an integer count
   only, not request content.
3. If you are within your daily quota, the proxy adds the OpenAI
   `Authorization` header and forwards your request body to OpenAI
   unchanged. The response is streamed back to your Mac.
4. The proxy keeps a rolling per-day total of estimated cost, used only
   to halt the service for the day if usage spikes (a safety brake).

The proxy does **not** persist:

- The audio, screenshots, or text content of your requests.
- Any user-identifying information beyond the installation UUID and the
  IP address Cloudflare sees during routing (which Cloudflare may log
  per its own [privacy policy](https://www.cloudflare.com/privacypolicy/)).
- A long-term record of which endpoints you used or when.

If you do not want the proxy to see your requests at all, paste your own
OpenAI API key in **Settings → API Key**. The app will then talk to
OpenAI directly and never contact the proxy.

## What OpenAI receives

When Samuel sends a request to OpenAI (whether directly or through the
proxy), OpenAI receives the audio, image, or text content of that
request. OpenAI's handling is governed by its own privacy policies:

- [OpenAI Privacy Policy](https://openai.com/policies/row-privacy-policy/)
- [OpenAI API Data Usage Policies](https://openai.com/policies/api-data-usage-policies/)

In particular, as of this writing, data sent through the OpenAI API is
not used to train OpenAI models by default. Samuel does not opt you into
training.

## Children

Samuel is not intended for users under 13 years old.

## Changes to this policy

We will update the "Last updated" date above when this policy changes.
Material changes (a new data flow, a new third party, a new retention
period) will be called out in the app's release notes.

## Contact

Bug reports, privacy questions, or "this is wrong, please fix it"
messages: open an issue at the Samuel GitHub repository, or email the
address listed in the app's About panel.
