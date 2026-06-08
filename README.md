<p align="center">
  <img src="docs/images/icon.png" alt="Samuel" width="200" />
</p>

<p align="center">
  <a href="https://samuelai.app"><strong>samuelai.app</strong></a>
</p>

<h1 align="center">Samuel — the AI that works with you, not for you</h1>

<p align="center">
  <a href="https://github.com/sambuild04/screen-voice-agent/releases/latest/download/Samuel-0.1.0-arm64.dmg">
    <strong>↓ Download for Apple Silicon Mac (Samuel 0.1.0)</strong>
  </a>
  &nbsp;·&nbsp;
  <a href="#quick-start">Install</a>
  &nbsp;·&nbsp;
  <a href="PRIVACY.md">Privacy</a>
  &nbsp;·&nbsp;
  <a href="TERMS.md">Terms</a>
</p>

A **voice-first AI companion for macOS**. Wake-word activated, speaks back in under 500 ms, sees your screen and hears your system audio (when you allow it), drives any app, browses the web like a human, and writes its own tools — and repairs them when they break. Open source, MIT licensed.

Think "ChatGPT Voice Mode that can actually see what you're doing" — or JARVIS for your Mac. Tools like Rewind/Limitless and Screenpipe record everything so you can search it *afterwards*; Cluely and Granola pin a text overlay on top of your meetings. Samuel is the only one you can **just talk to, in real time, about whatever just happened on your screen or in your audio**.

**Use cases:**
- *"What did they just say?"* mid-meeting, mid-podcast, mid-lecture
- Live in-call assist for sales, support, interviews — voice answer instead of a text overlay
- Hands-free Mac control for RSI, motor disabilities, and VoiceOver users
- Ambient language learning while watching anime, K-drama, news, or YouTube
- Real-time translation of anything playing through your speakers
- ADHD body-doubling and voice capture without breaking flow
- Meeting summarization without a bot joining the call
- Voice-controlled web browsing ("show me my Gmail")
- Self-building AI tools by voice ("build me a weather widget")
- Ambient monitoring ("tell me when you hear / see X")

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![macOS](https://img.shields.io/badge/platform-macOS-black.svg)
![Electron](https://img.shields.io/badge/Electron-37-47848F.svg)
![OpenAI Realtime API](https://img.shields.io/badge/OpenAI-Realtime%20Voice-412991.svg)
![GPT-5.5](https://img.shields.io/badge/GPT--5.5-reasoning-10a37f.svg)
![Playwright](https://img.shields.io/badge/Playwright-browser%20automation-2EAD33.svg)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2.svg)](https://github.com/sambuild04/screen-voice-agent/issues/new?title=Discord+invite+request)
[![Contributors](https://img.shields.io/github/contributors/sambuild04/screen-voice-agent.svg)](https://github.com/sambuild04/screen-voice-agent/graphs/contributors)

> **TL;DR:** Say "Hey Samuel" and talk. With screen/audio permissions on, he can see and hear your desktop context, browse the web for you, write his own tools with GPT-5.5, auto-repair them when they break, and remembers preferences and skills across sessions.

## What's New

- **Ambient audio buffer + on-demand recall** — Samuel records system audio into a rolling local-only buffer the moment the session connects. When you ask "translate the last 30 seconds" / "what did they just say?" / "teach me the words from that clip", he calls `recall_audio(last_seconds=N)`, ffmpeg-trims the tail of the buffer to your window, transcribes it via `gpt-4o-transcribe`, and answers. No polling cadence to fight, no auto-pause/resume — *you* control playback, *your question* is the boundary.
- **In-app consent popups for sensitive privacy surfaces** — `listen_in_background` and `set_screen_observation(mode='continuous')` are now `needsApproval: true`. The first time either flips on (from off) Samuel surfaces a tool-approval card with `Allow` / `Deny` and **no auto-approve countdown** for these two — you have to consciously click Allow. On Allow, the choice persists across sessions via `privacy.audio_listen` / `privacy.screen_watch`. Settings panel toggles remain the manual override.
- **Smart context decisions** — Samuel now decides per-turn whether your screen is even relevant before capturing it. Acks ("yes", "thanks"), command-intent ("open Slack in the browser"), service mentions ("check my Gmail"), and meta-questions ("what can you do?") skip the AX-tree read + screenshot entirely. Saves ~1.3s of latency and ~150 KB of tokens per turn.
- **"That wasn't me"** — say "that's not my voice", "ignore that last one", or "I didn't say that" and Samuel erases the bogus user turn AND any reply to it from session memory + UI. Side effects (tab switches, key presses) get a verbal "want me to revert?" offer.
- **Listening modes** — say "I'm watching anime, ignore the audio" and Samuel goes passive (only responds when addressed by name). Audio is still captured silently so you can later ask "what did they just say?".
- **Control modes** — `background_workspace` / `observe_only` / `ask_before_action` / `takeover` switch between zero-touch ambient, read-only, ask-on-write, and full hands-on-keyboard.
- **Per-tab window capture** — Chrome/Safari/Arc captures hit the *exact* window matching the active tab title, not whichever browser window the OS happens to focus. Multi-display friendly.
- **No more session teardowns** — captured JPEGs are hard-capped to fit WebRTC's SCTP message limit (quality + width step-down), eliminating `INVALID_RANGE` reconnect loops.

---

## See It In Action

Samuel interprets Japanese news in realtime — watching the screen and listening to audio simultaneously:

https://github.com/user-attachments/assets/36fdd220-e1af-443a-99d3-31803160625c

Ambient teaching while watching anime — voice explanations and trigger alerts:

https://github.com/user-attachments/assets/65314d07-694d-47c5-8209-24e5bdbdf55c

https://github.com/user-attachments/assets/338f8194-49e6-496d-b218-715af4afa1ee

---

## What Only Samuel Does

The AI desktop landscape in 2026 is crowded. Most products pick one corner. Samuel is the only one combining all four of these in a single Mac-native app:

1. **Wake-word voice in / voice out, sub-500 ms.** Not push-to-talk. Not type-and-read. You talk, Samuel talks back, fast enough to feel like a person in the room. Built on the OpenAI Realtime API.
2. **Ambient screen + audio context.** Samuel watches what you watch and hears what you hear — when you allow it. So you can ask *"what did they just say?"* / *"translate the last 30 seconds"* / *"what's that error mean?"* and he already has the context to answer.
3. **Real computer use.** Clicks, types, drives apps via the macOS Accessibility tree with a GPT-5.5 visual fallback. He doesn't just *see* — he can *do*.
4. **Self-modifying tools.** Writes new plugins on demand with GPT-5.5 reasoning, reviews them with GPT-4o-mini, and auto-repairs them when they break. The toolset grows with you.

### How Samuel compares to other live-context AI on Mac

| | **Samuel** | Screenpipe | Cluely | Granola | Otter / Fathom | ChatGPT Voice | Limitless / Rewind |
|---|---|---|---|---|---|---|---|
| Voice in (wake word) | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Voice out (real-time speech) | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Sub-500 ms voice loop | ✅ | — | — | — | — | ✅ | — |
| Sees your screen | ✅ | ✅ | ✅ | ❌ | ❌ | Limited | ✅ |
| Hears system audio | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ (was) |
| Live "what just happened?" answers | ✅ | ❌ (search after) | Text overlay | ❌ (after meeting) | ❌ (after meeting) | ❌ | ❌ (search after) |
| Proactive speech ("I just heard…") | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Companion modes (passive listen, language tutor) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Drives apps (clicks, types, native input) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Self-writes / auto-repairs tools | ✅ | Pipes (manual) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Open source | ✅ MIT | ✅ MIT | ❌ | ❌ | ❌ | ❌ | Was closed |
| Status (May 2026) | Active | Active | Active | Active | Active | Active | **Shut down Dec 2025** |

The key reading of this table: **Screenpipe owns the always-on memory + automation lane** (search-after-the-fact, pipes to Slack/Notion/Linear, on-device PII scrubbing). They've done that well. **Samuel owns the voice-first conversational lane** — you can actually *talk* to your Mac about what's happening, in real time, by voice. Different DNA, different shape.

### Who Samuel is for, today

- **Knowledge workers in back-to-back meetings** who keep missing details and want a voice they can ask, not a transcript they have to scroll
- **Sales reps, customer success, recruiters, interviewers** who want a live voice-coach, not a stealth text overlay
- **Hard-of-hearing professionals** who already use macOS Live Captions but can't *ask* the captions a question
- **Online students and lifelong learners** binge-ing courses, lectures, conference talks, and YouTube tutorials
- **Language immersion learners** watching anime, K-drama, telenovelas, news, podcasts in their target language
- **RSI / hands-free / VoiceOver users** for whom keyboard-and-mouse is painful or impossible
- **ADHD body-doublers and voice-first thinkers** who'd rather speak than type
- **Tinkerers and indie hackers** who want a JARVIS they can extend by writing plugins out loud

---

## What Makes Samuel Different

### Self-Improving AI — Writes, Tests, and Auto-Repairs Its Own Tools

Most AI agents have a fixed tool set. Samuel doesn't. He generates new tools at runtime using **GPT-5.5 with reasoning tokens**, reviews them with GPT-4o-mini, and auto-repairs them when they break — with a max of 2 attempts before honestly telling you what went wrong.

```
You:     "Build me a weather widget"
Samuel:  "I'll create a weather tool with a visual panel. [Approve] [Reject]"
You:     *approves*
Samuel:  "Generating with GPT-5.5..." → validates → installs → "Done. It's 14°C in Tokyo."

         ...later, the API changes...

Samuel:  *detects validation failure* → *diagnoses: external API change*
         → *patches the endpoint* → *verifies* → "The weather API changed. I've fixed it."
```

No rebuild. No restart. If the fix fails twice, Samuel explains what happened and what he needs from you — never loops silently.

### Browser Automation — Access Any Website, Zero Config

Samuel opens a **real, visible browser window** via Playwright. You sign in yourself — he reads and interacts with the page like a human. No API keys, no OAuth, no developer setup. Works with any website.

```
You:     "Show me my emails"
Samuel:  "Opening Gmail now." → *browser opens*
         "Please sign in if needed." → *waits*
         "You have 3 new emails. First is from Sarah about the project deadline..."

You:     "Check my GitHub notifications"
Samuel:  *opens GitHub* → *reads notification page* → summarizes
```

Gmail, Outlook, LinkedIn, your bank, internal tools — anything you can open in a browser, Samuel can read and interact with.

### Plugin Auto-Repair (GPT-5.5 Reasoning)

When a plugin fails — runtime error, bad `validates()` output, or you say "that's wrong" — Samuel runs **auto-repair** backed by GPT-5.5 (high reasoning): it **diagnoses** the failure kind, **generates** a patch or rewrite, **verifies** the new code loads, and retries. That maps onto detect → diagnose → repair → verify logically, but it is a **single automated path** (not four separate user-visible stages).

Max 2 attempts. If it can't fix it, you get a plain-language explanation of what went wrong and what Samuel needs from you to continue.

### Tool Wraps — Extend Existing Tools Without Replacing Them

Plugins can wrap existing tools with a middleware pattern. A plugin with `wraps: "web_browse"` gets the original tool's function as a second argument — enabling caching, logging, rate limiting, or post-processing on any built-in tool.

### Procedural Memory — Learns and Reuses Workflows

Samuel doesn't just execute tasks — he remembers how he did them. After successfully chaining 3+ tools, he saves the workflow as a reusable "skill."

```
You:     "Find every Japanese name in this article and add furigana"
Samuel:  *reads page → extracts names → annotates each one*
         "Done. I've saved this as a skill for next time."

         ...next session...

You:     "Same thing on this new article"
Samuel:  *loads saved skill → executes in seconds*
```

### Ambient Triggers — "Tell Me When You See/Hear X"

Samuel runs a **watcher loop** separate from the conversation loop — the ambient agent architecture. Register triggers by voice and Samuel evaluates every audio transcript and screen capture against them:

```
You:     "Let me know when you hear N2 level Japanese words"
Samuel:  "Got it — I'll watch for N2 vocab. 60-second cooldown between alerts."

         ...anime is playing...

Samuel:  "I just heard 妖術 (yōjutsu) — that's N2 level. It means sorcery."
```

Two evaluation tiers:
- **Keyword triggers** — exact string matching, deterministic, zero cost. "Watch for the word 'error'"
- **Classifier triggers** — GPT-4o-mini evaluates each event (~$0.0001/call). "Alert me when the speaker sounds frustrated"

Triggers are first-class objects with cooldowns, enable/disable, fire counts, and source filtering (audio, screen, or both). Works independently of learning mode — say "tell me when you see a loading spinner" while doing anything.

### Always Watching, Always Listening

Samuel can run continuous perception when you enable it and use ambient features:

- **Screen** — with learning language / ambient mode, periodic vision passes (on an interval) plus smart change detection; on each voice turn, AX + screenshot may refresh when relevant (see Smart Context below — many turns skip capture).
- **Audio** — system audio via ScreenCaptureKit with PID-level filtering (excludes his own voice when configured), feeding both the ambient triggers and the on-demand recall buffer (see Ambient Audio Buffer below).
- **Context injection** — observations can be fed silently when privacy toggles allow
- **Watcher loop** — evaluates active triggers against audio/screen events, may fire synthetic turns to speak proactively

Screen and audio are **not** on unconditionally: use the settings toggles for screen watch and audio listen, and expect lower capture frequency when smart context skips a turn. Sensitive privacy surfaces also flow through an explicit allow/deny popup the first time they flip on (see Consent Popups below).

### Ambient Audio Buffer — "I've Been Listening, Ask Me Anything"

Once audio listening is allowed, Samuel keeps a rolling system-audio buffer running locally — anything playing through your speakers gets recorded into a small on-disk file with no transcription cost. The model never sees the buffer as a stream; it stays silent context until *you* ask about it.

```
You:     *plays a Japanese anime clip → pauses*
You:     "Translate the last 30 seconds and teach me each word."
Samuel:  *calls recall_audio(last_seconds=30)*
         "They said 高遠寺パイセン、あんた強いんだって? 俺とやり合おうぜ — 'Hey
          senior Takadōji, I hear you're strong. Let's spar.' 強い (tsuyoi) is
          'strong'; パイセン is slang for 先輩…"
```

How it differs from the older companion/push-loop pattern:

- *Your question is the boundary* — no fragile semantic-VAD cadence, no auto-pause/resume keystroke fights, no mic-bleed cancelling explanations.
- *Pay only on recall* — zero transcription cost while idle; one `gpt-4o-transcribe` call per question.
- *You stay in playback control* — Samuel does not press K on your behalf; you pause when *you* want to ask.
- *Window picked from intent* — "what just happened" → 15s, "the last clip" → 30s, "the chorus" → 60s, "the meeting so far" → 180–300s. The model picks; you don't have to specify exact seconds.

The recall result includes a structured `reason` (`ok` / `buffer_off` / `no_capture` / `no_speech` / `filtered_*` / `empty_transcript` / `transcribe_error`) so Samuel gives you actionable diagnostics instead of "I don't know."

### Consent Popups — Real Allow/Deny for Privacy-Sensitive Tools

Tools that flip on a continuous-perception surface — `listen_in_background(active=true)` and `set_screen_observation(mode='continuous')` — are marked `needsApproval: true`. When Samuel calls one for the first time (or after you revoked it), an in-app approval card appears in the transcript:

```
🎧 Listen to system audio (so I can answer questions about what you're playing)
   listen_in_background
   [Allow]   [Deny]
```

Two non-obvious details:

- **No auto-approve countdown** for these two specific tools. Other tools auto-approve after 10s if you're away from the keyboard; privacy grants don't — you have to consciously click Allow.
- **Persistence on Allow.** Approving flips the underlying preference (`privacy.audio_listen` or `privacy.screen_watch`) so future sessions just work. Revoke any time via the settings panel toggle or by saying "stop listening to my speakers."

### Smart Context — Decide Before Capturing

Always-on perception used to mean an AX-tree read + screenshot encode + injection on *every* user turn — ~1.3s of latency before Samuel could even start replying. Most turns don't need it.

Samuel now classifies each transcript before deciding to capture:

| Intent | Example | Captures? |
|---|---|---|
| Conversational ack | "yes", "thanks", "got it" | No — prior context still applies |
| Meta / chitchat | "what can you do?", "how are you?", "tell me a joke" | No — screen is irrelevant |
| Service mention | "open Notion in the browser", "check my Gmail" | No — model uses tools to access the service |
| Command verb | "open Mail", "find that file" | No — model fetches fresh data via tools |
| Referential | "translate this", "what does that say" | **Yes** — pointing at the current screen |
| Anything else | "summarize this PDF" | Yes — defaults to capture when ambiguous |

When the screen is genuinely relevant, captures are de-duped by AX-tree hash (skip if nothing changed) and gated by a 5s cooldown to prevent token floods.

### Voice-First Recovery — "That wasn't me"

The mic can't tell your voice from background audio. When a video, background audio, another person, or a Whisper hallucination gets transcribed as a command, Samuel will act on it. Telling him is the fix:

```
You:     "Hey Samuel, ignore that last one — that wasn't me."
Samuel:  *cancels in-flight TTS* → erases bogus turn from memory + UI
         "Sorry — I picked up background audio. I switched to your
          DoorDash tab; want me to switch back?"
```

Trigger phrases:
- "That wasn't me" / "That's not my voice" / "I didn't say that"
- "Ignore that last one" / "Forget what I just said"
- "That was the video / TV / kid / coworker, not me"
- "Oops, that wasn't a command"

Memory rewinds; physical side effects don't auto-undo (a tab already switched, a key already pressed) but Samuel offers to revert them verbally. Layered with **passive listening mode** ("ignore my audio while I watch") for proactive prevention when you know background audio is coming.

### Listening Modes & Control Modes

Two voice-controllable axes for non-interruptive UX:

| Mode axis | Voice command | What changes |
|---|---|---|
| Listening: `passive` | "I'm watching anime, ignore the audio" | Drops VAD-triggered turns until you address Samuel by name |
| Listening: `normal` | "Done watching, you can listen normally" | Auto-respond to any clear speech |
| Control: `background_workspace` | "Stay in the background" | Zero-touch — watch & alert only, no actions |
| Control: `observe_only` | "Just observe" | Read tools allowed, no writes/clicks |
| Control: `ask_before_action` | "Ask me before doing things" | Navigation & media keys auto-allowed; writes need approval |
| Control: `takeover` (default) | "Take the wheel" | Full keyboard/mouse control; only the riskiest actions still gate |

Inside `ask_before_action`, key-risk is classified per-action: media keys (`k`, `space`, arrows), Enter, Tab, Escape, and copy/paste auto-approve as `navigation`; only destructive shortcuts (`cmd+w`, `cmd+q`, `cmd+s`, bare `delete`) trip the approval card. Fewer "should I press k?" loops when using media shortcuts.

### Capability Boundaries — Honest About What He Can and Cannot Do

Samuel classifies every request before attempting it:

- **CAN DO:** anything involving his tools (screen, web, browser, files, plugins, UI, memory)
- **NEEDS YOUR HELP:** sign into a website, provide an API key, demonstrate a workflow
- **CANNOT DO:** modify compiled code, add native OS features, access hardware sensors

When asked for something impossible, he suggests the closest alternative. When he needs something from you, he says specifically what. Never fails silently.

### Execution Narration — Always Know What Samuel Is Doing

During multi-step operations, Samuel narrates briefly:
- *"Diagnosing the issue..."* → *"Fixed — the API endpoint had changed."*
- *"Writing a new plugin..."* → *"Installed and tested. You have 12 stars."*
- *"Opening your browser..."* → *"Got it. Want me to summarize?"*

Conversational, not technical. You always know what's happening.

### Remembers Everything

Four types of persistent local memory:

| Type | Example | Effect |
|---|---|---|
| **Preferences** | "Be more concise" | Applied every session |
| **Corrections** | "That explanation was wrong" | Never repeated |
| **Facts** | "I'm intermediate at Japanese" | Adjusts behavior permanently |
| **Skills** | Multi-step workflows | Replayed instead of re-invented |

### Voice-Controlled Everything

Samuel responds to natural-language commands for the things that matter at runtime — appearance and visual UI knobs live in the in-app SettingsPanel:

| You say | What happens |
|---|---|
| "Show me a panel with my flight details" | Builds an HTML overlay via `show_content` |
| "Speak quieter" / "You're too loud" | Samuel's voice volume adjusts independently |
| "Turn down the video" | macOS system volume adjusts |
| "That's not my voice" / "Ignore that last one" | Last turn erased from memory + UI |
| "I'm watching a video, ignore the audio" | Switches to passive listening |
| "Take the wheel" / "Stay in the background" | Switches control mode |

---

## Core Features

### Web Intelligence (3 Tiers)

| Tier | When Samuel uses it | How it works |
|---|---|---|
| **Basic search** | "Look up X" | SerpAPI Google search with pagination |
| **Deep search** | "Find more details" / "Dig deeper" | OpenAI Responses API with web_search — returns comprehensive answer with cited sources |
| **Browser automation** | "Show me my Gmail" / any login-required site | Playwright opens real Chromium, you sign in, Samuel reads the page |

### Recording Mode

Record any audio (meetings, lectures, videos) and ask Samuel anything about the transcript. One recording, any question — summarize, find topics, break down grammar, extract action items.

### Chat Box — Drop Anything, Ask Anything

- **Text** → Samuel explains, translates, teaches
- **Article URL** → extracted and annotated
- **Image / manga** → OCR + breakdown
- **API key** → securely stored

### OAuth Integration (Zero-Config for Known Providers)

For API-level access, PKCE-based OAuth with built-in client IDs for Google, GitHub, and Spotify. User just clicks "Allow" — no Cloud Console setup. Power users can override with their own credentials.

### Privacy Controls

Toggle screen watching and audio listening directly from the settings button. All memory is local, auditable, and editable.

---

## Architecture

```
"Hey Samuel" → Wake word → OpenAI Realtime API → 30+ tools → Voice response
                                    ↕
         ┌─ Loop 1: Conversation loop (user-driven, reactive)
         │   Smart context: classify transcript → decide AX+screenshot or skip
         │   Screen capture: per-tab window match (Chrome/Safari/Arc), JPEG hard-cap
         │   System audio (ScreenCaptureKit, PID-level filtering, echo guard)
         │   Browser automation (Playwright, headed Chromium, visible to user)
         │   Recovery: discard_last_turn for misheard background audio
         │
         ├─ Loop 2: Watcher loop (event-driven, proactive)
         │   Trigger evaluation: keyword match + GPT-4o-mini classifier
         │   Synthetic turn injection → Samuel speaks unprompted
         │   Cooldowns + agent-state-aware (no interrupts mid-speech)
         │
         ├─ Modes: listening (normal/passive) + control (4 levels) + per-key risk
         ├─ Plugin system: propose → GPT-5.5 generate → review → validate → install
         ├─ Auto-repair: failure → GPT-5.5 diagnose + patch/rewrite → verify (max 2 tries)
         ├─ Wraps/middleware: plugins extend existing tools without replacing them
         ├─ Skill system: execute workflow → save as skill → replay next time
         ├─ Computer Use: GPT-5.5 visual desktop control via computer_use_preview
         ├─ OAuth: PKCE + built-in client IDs → zero-config for known providers
         ├─ Recording: Whisper transcribe → user-directed analysis
         ├─ Volume control: independent Samuel voice + macOS system volume
         ├─ Secrets store: ~/.samuel/secrets.json (local)
         └─ Personality memory: preferences + corrections + facts + skills
```

### Models

| Model | Purpose | Latency |
|---|---|---|
| OpenAI Realtime API | Voice conversation, all interactive features | ~500ms |
| GPT-5.5 (reasoning) | Plugin code generation, failure diagnosis | ~3-8s |
| GPT-4o Vision | Screen scanning, ambient observation | ~3-5s |
| GPT-4o-mini | Plugin code review, trigger classification, screen text extraction | ~1s |
| gpt-4o-transcribe | Recording transcription (high-fidelity) | ~3-10s |

### Key Tools

| Tool | What it does |
|---|---|
| `observe_screen` | Captures and analyzes what's on screen |
| `read_app` | Reads any macOS app via Accessibility Tree (Chrome, WeChat, Slack, Notes...) |
| `list_browser_tabs` / `switch_browser_tab` | Enumerate + switch Chrome/Safari tabs by title |
| `browser_use` | Opens real browser, navigates, reads, clicks, types, screenshots |
| `computer_use` | GPT-5.5 visual desktop control — sees screen, operates any app via CGEvent |
| `desktop_click` / `desktop_type` / `desktop_key` / `desktop_scroll` | Native macOS input — per-key risk classification |
| `focus_app` / `open_app` | App focus + launch |
| `web_browse` | Search the internet (3 tiers) and read web pages |
| `plugin_manage` | Self-modification — propose, write, **repair**, remove, list plugins |
| `skill_manage` | Save, search, and replay multi-step workflows |
| `recording` | Start/stop system audio capture |
| `listen_in_background` | Toggle the rolling system-audio buffer (consent popup the first time it flips on) |
| `recall_audio` | Pull-model transcript-on-demand: "translate the last 30s", "what did they say?" |
| `watch_for` | Register ambient triggers — keyword or classifier-based |
| `set_control_mode` | Switch background / observe / ask / takeover |
| `set_listening_mode` | Switch normal / passive listening |
| `discard_last_turn` | Erase the last turn from memory ("that wasn't me") |
| `set_learning_language` | Activate ambient language tutoring |
| `set_volume` | Adjust Samuel's voice or macOS system volume |
| `show_content` | Float a styled HTML panel over the desktop ("show me a panel with…") |
| `oauth_connect` | Zero-config OAuth for Google/GitHub/Spotify |
| `file_op` | Read, write, list files on disk |
| `store_secret` | Secure API key storage |
| `remember_preference` / `mark_vocabulary_known` / `record_correction` | Persistent memory |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop | [Electron](https://www.electronjs.org/) (Chromium + Node main process) |
| Frontend | React 19 + Vite + TypeScript |
| Voice | [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime) (WebRTC, SCTP-bounded payloads) |
| Agent Framework | [@openai/agents](https://github.com/openai/openai-agents-js) |
| Code Generation | GPT-5.5 with reasoning tokens via Responses API |
| Visual Desktop Control | GPT-5.5 `computer_use_preview` via Responses API |
| Vision | GPT-4o Vision |
| Browser Automation | [Playwright](https://playwright.dev) (headed Chromium) |
| Native Desktop Input | macOS Accessibility API + CGEvent (click/type/key/scroll) |
| AX Tree | macOS Accessibility Tree multi-app reader |
| Plugin Runtime | `new Function()` + secrets + UI injection + validates + wraps |
| OAuth | PKCE + built-in client IDs (Google, GitHub, Spotify) |
| Web Search | [SerpAPI](https://serpapi.com) (Google, with answer-box short-circuit) + OpenAI deep search |
| Animation | [Rive](https://rive.app) |
| Screen Capture | [Peekaboo](https://github.com/nicklama/peekaboo) + macOS `screencapture` + per-tab title match |
| Audio Capture | ScreenCaptureKit (Swift), PID-level filtering |

---

## Quick Start

### Option A — Download the DMG (recommended)

1. **[Download Samuel for Apple Silicon Mac](https://github.com/sambuild04/screen-voice-agent/releases/latest/download/Samuel-0.1.0-arm64.dmg)** (M1 / M2 / M3 / M4). Other versions: see the [latest release page](https://github.com/sambuild04/screen-voice-agent/releases/latest). _Intel Mac build is not yet shipped — build from source via Option B if you're on Intel._
2. Open the DMG and drag **Samuel** to **Applications**.
3. **First launch:** because Samuel is not yet notarized by Apple, double-clicking shows
   *"Apple cannot verify that this app is free from malware."*
   To get past it once: right-click `Samuel.app` in Applications → **Open** → **Open** in the dialog. Subsequent launches don't ask again. (Notarization is on the roadmap; it removes this step.)
4. Grant the macOS permission prompts that appear the first time you turn on a privacy capability in **Settings → Privacy Controls** (microphone, screen recording, accessibility). Each toggle is OFF by default; nothing reaches OpenAI until you turn it on.
5. **No OpenAI key required to start** — Samuel's free trial proxy lets you try it immediately. For unlimited use, paste your own key in **Settings → API Key**; the app then talks to OpenAI directly and never contacts the proxy. See [PRIVACY.md](./PRIVACY.md) for the full data-flow breakdown.

Say **"Hey Samuel"** and start talking.

### Option B — Build from source

#### Prerequisites

- macOS 14+ (Sonoma or later)
- Node.js 20+
- OpenAI API key with Realtime API + GPT-5.5 access (only required if you want to bypass the trial proxy)
- (Optional but recommended) [SerpAPI](https://serpapi.com) key — enables fast Google search with answer-box short-circuit. Without one, factual queries fall through to OpenAI `deep_search` (slower; ~5–15 s per call).

#### Install

```bash
brew install steipete/tap/peekaboo
git clone https://github.com/sambuild04/screen-voice-agent.git
cd screen-voice-agent
npm install
npx playwright install chromium
swiftc -o helpers/record-audio helpers/record-audio.swift \
  -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia
```

Grant macOS permissions:
- **System Settings → Privacy & Security → Screen Recording** → add Samuel + Peekaboo
- **System Settings → Privacy & Security → Accessibility** → add Samuel (needed for AX-tree reads + native input)

```bash
npm run electron:dev      # development with hot reload
# or
npm run electron:build    # produces a DMG in dist-app/
```

Say **"Hey Samuel"** and start talking.

#### Bring your own key (optional)

If you'd rather skip the trial proxy and pay OpenAI directly:

```bash
mkdir -p ~/.samuel && echo '{"apiKey": "sk-..."}' > ~/.books-reader.json
```

Or paste it into Settings → API Key after launching.

To enable fast web search, hand Samuel a [SerpAPI](https://serpapi.com) key once via voice (he'll store it locally):

> *"Here's my SerpAPI key: <paste-it>"*

Or write it directly: `echo '{"serpapi_key":"<your-key>"}' > ~/.samuel/secrets.json`

> Stuck? [Open an issue](https://github.com/sambuild04/screen-voice-agent/issues/new) or join the [Discord](https://github.com/sambuild04/screen-voice-agent/issues/new?title=Discord+invite+request).

---

## API Costs

| Mode | Approx. cost |
|---|---|
| Wake word (always listening) | ~$0.006/min |
| Ambient assistance (screen + audio) | ~$0.02-0.05/min |
| Plugin generation (GPT-5.5) | ~$0.005/plugin |
| Plugin diagnosis (GPT-5.5) | ~$0.003/diagnosis |
| Plugin review (GPT-4o-mini) | ~$0.001/review |
| Trigger evaluation (GPT-4o-mini) | ~$0.0001/event |
| Voice conversation | Standard Realtime API pricing |
| Browser automation | Free (runs locally) |

---

## Limitations

- **macOS only** — depends on ScreenCaptureKit, Peekaboo, and macOS APIs
- **Plugins are not OS-sandboxed** — `new Function()` has full JS access; the approval flow is the current security boundary
- **Cannot modify its own compiled code** — plugins can add new tools and wrap existing ones, but can't edit `samuel.ts` or Rust code at runtime
- **Browser sessions don't persist** — each Playwright launch starts fresh; cookies/logins don't carry over yet
- **Single-file plugins** — no multi-file plugin architecture or npm imports
- **Always-on costs** — ambient mode runs continuously; costs accumulate while active

---

## Roadmap

The vision: an AI that can work alongside you where you do: optional screen and audio awareness, tools that evolve with you, fixes its own plugin bugs, and gets better at helping you over time.

- **One-click installer** — packaged `.dmg`, no compilation. *(in progress)*
- **Persistent browser sessions** — save cookies so you don't re-login every time.
- **Plugin sandboxing** — run plugins in isolated Web Workers for security.
- **Plugin chaining** — let plugins call each other and share state.
- **Plugin marketplace** — share and install community-built tools and workflows.
- **Demonstration learning** — "watch me do this once" → Samuel learns the workflow from screen recordings.
- **MCP support** — connect to Notion, Gmail, Slack, GitHub, and any MCP server.
- **General monitoring mode** — "watch this meeting and flag anything important." *(shipped — ambient triggers with keyword + classifier evaluation)*
- **Local-first mode** — local Whisper + Ollama, no API key required.
- **Cross-platform** — Windows and Linux ports.
- **iOS / Android companion** — pick up where you left off.
- **Auto-healing plugins** — if a plugin fails in the background, auto-fix without interrupting the user. *(shipped — up to 2 attempts)*

---

## FAQ

**What is Samuel?**
An open-source voice AI desktop agent that can use your screen and system audio when enabled, obeys privacy toggles, lets you control it by voice, browses the web like a human, and writes and repairs its own tools at runtime using GPT-5.5 with reasoning.

**What can I use it for?**
The "what did they just say?" moment in any meeting, podcast, lecture, or video. Live in-call voice coaching for sales/support/interviews. Hands-free Mac use for RSI and VoiceOver users. Ambient language learning while watching content. Real-time translation. Building custom AI tools by voice. Searching and summarizing anything on the web. Ambient monitoring ("tell me when you hear X"). Meeting summaries without a bot. General desktop automation.

**How is this different from ChatGPT Voice?**
ChatGPT Voice talks fast but is mostly blind to your desktop — it can't see what's on your screen, can't hear what's playing through your speakers, can't drive your apps, and can't remember anything across sessions. Samuel adds all four: ambient screen + audio context (when you allow it), native macOS computer use (Accessibility + visual fallback), real browser automation via Playwright, and persistent local skills/preferences/memory. Same low-latency voice feel, but with eyes, ears, hands, and memory.

**How is this different from Screenpipe / Rewind / Limitless?**
Those are memory + search products: they record everything, then you *type a query later* to find it. Screenpipe in particular is excellent at that — pipes to 48+ apps, on-device PII scrubbing, MIT-licensed. Samuel is a different shape: a real-time voice presence you talk to *while things are happening*. You can ask him out loud what was just said, get an answer in under a second, and keep watching. Where Screenpipe hands you a search box, Samuel hands you a colleague.

**How is this different from Cluely / Granola / Otter / Fathom?**
Cluely puts a stealth text overlay on your meetings. Granola/Otter/Fathom give you transcripts and summaries after the meeting. None of them speak. Samuel does — out loud, mid-meeting, by voice — so you don't have to look away from the speaker or break eye contact to read an overlay or open a transcript later.

**What models does it use?**
OpenAI Realtime API for voice, GPT-5.5 with reasoning for code generation and failure diagnosis, GPT-4o Vision for screen capture, GPT-4o-mini for code review, Whisper for transcription.

**How does auto-repair work?**
Every plugin declares a `validates()` function. If output fails validation, or the user says "that's wrong," GPT-5.5 diagnoses the failure (syntax bug? API change? structural issue?), picks a repair strategy (patch, rewrite, or ask user), generates a fix, and verifies it before deploying. Max 2 attempts, then clean escalation.

**Can Samuel modify its existing tools?**
Yes, via the wraps/middleware pattern. A plugin can wrap any existing tool — intercepting calls, modifying inputs/outputs, adding caching or logging — without replacing the original.

**Does Samuel browse the web?**
Three ways: (1) API-based search via SerpAPI, (2) AI-powered deep search via OpenAI, (3) real browser automation via Playwright where he opens a visible Chromium window, you sign in, and he reads/interacts with the page.

**Is my data private?**
Yes, with caveats spelled out in [PRIVACY.md](./PRIVACY.md). The short version: every privacy capability is OFF by default; macOS asks you to grant the underlying system permission the first time each one is used. Memory, preferences, skills, plugins, and secrets stay on your Mac in `~/.samuel/`. Browser sessions run locally via Playwright. Voice and screen content is sent to OpenAI only when (and only because) you ask Samuel something that needs OpenAI to answer it. In trial mode, those requests pass through a thin Cloudflare proxy that does not store request content.

**Is it free?**
Two paths:
- **Trial mode** — the app ships with a free trial proxy that uses our OpenAI key, with daily per-installation rate limits. No credit card, no signup. Trial mode may be paused, throttled, or removed at any time per the [Terms](./TERMS.md).
- **Bring-your-own-key** — paste your OpenAI API key in Settings. Samuel talks to OpenAI directly and applies no caps; you pay OpenAI's metered rates for whatever you use. The code itself is MIT-licensed.

**Does it work on Windows or Linux?**
Currently macOS only. Cross-platform is on the roadmap.

---

## Contributing

Samuel is growing fast. Every contribution — code, skills, ideas, bug reports — shapes where this goes.

### What we need help with

- **Windows + Linux ports** — ScreenCaptureKit alternatives (WASAPI, PipeWire/PulseAudio)
- **One-click installer** — signed `.dmg` packaging via `electron-builder`
- **Persistent browser sessions** — save Playwright cookies/profiles across launches
- **Plugin sandboxing** — Web Worker isolation for plugin execution
- **MCP integration** — `@openai/agents` + MCP servers for Notion, Slack, etc.
- **Skill contributions** — write workflows you'd actually use
- **Tool description tuning** — better descriptions = more reliable tool selection
- **Documentation** — install walkthroughs and "what tripped me up" reports

### How to help, by time available

| Time | What you can do |
|---|---|
| **5 minutes** | Star the repo. Share it. Tell one person. |
| **30 minutes** | Try Samuel and report a bug or suggest a feature. |
| **2 hours** | Write a skill. Improve a tool description. |
| **A weekend** | Pick a `good first issue`. Build a plugin. Write docs. |
| **Bigger** | Co-own a workstream — Windows port, MCP, plugin sandbox. |

### Setup for contributors

```bash
git clone https://github.com/sambuild04/screen-voice-agent.git
cd screen-voice-agent
npm install
npx playwright install chromium
swiftc -o helpers/record-audio helpers/record-audio.swift \
  -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia
mkdir -p ~/.samuel && echo '{"apiKey": "sk-..."}' > ~/.samuel/config.json
npm run electron:dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow and PR process.

### Contributors

[![Contributors](https://contrib.rocks/image?repo=sambuild04/screen-voice-agent)](https://github.com/sambuild04/screen-voice-agent/graphs/contributors)

---

## License

MIT

---

**Built by [Sam Feng](https://github.com/sambuild04)**
