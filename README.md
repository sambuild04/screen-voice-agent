# Samuel — the AI that works with you, not for you

An always-on voice AI desktop assistant for macOS that sees your screen, hears your audio, browses the web in the background, writes its own tools, and fixes them when they break — all without ever stealing your cursor or interrupting your flow. Built with Electron, React, TypeScript, and Playwright. MIT licensed.

**Use cases:** ambient language learning, voice-controlled web browsing, self-building AI tools, hands-free desktop automation, live meeting interpretation, real-time video translation, AI tutoring, email/calendar access via browser automation, ambient monitoring ("tell me when you see/hear X").

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![macOS](https://img.shields.io/badge/platform-macOS-black.svg)
![Electron](https://img.shields.io/badge/Electron-37-47848F.svg)
![OpenAI Realtime API](https://img.shields.io/badge/OpenAI-Realtime%20Voice-412991.svg)
![GPT-5.5](https://img.shields.io/badge/GPT--5.5-reasoning-10a37f.svg)
![Playwright](https://img.shields.io/badge/Playwright-browser%20automation-2EAD33.svg)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2.svg)](https://github.com/sambuild04/screen-voice-agent/issues/new?title=Discord+invite+request)
[![Contributors](https://img.shields.io/github/contributors/sambuild04/screen-voice-agent.svg)](https://github.com/sambuild04/screen-voice-agent/graphs/contributors)

> **TL;DR:** Say "Hey Samuel" and talk. He sees your screen, hears your audio, browses the web for you, writes his own tools with GPT-5.5, auto-repairs them when they break, and remembers everything across sessions.

## What's New

- **Smart context decisions** — Samuel now decides per-turn whether your screen is even relevant before capturing it. Acks ("yes", "thanks"), command-intent ("play music on YouTube"), service mentions ("check my Gmail"), and meta-questions ("what can you do?") skip the AX-tree read + screenshot entirely. Saves ~1.3s of latency and ~150 KB of tokens per turn.
- **"That wasn't me"** — say "that's not my voice", "ignore that last one", or "I didn't say that" and Samuel erases the bogus user turn AND any reply to it from session memory + UI. Side effects (tab switches, key presses) get a verbal "want me to revert?" offer.
- **Listening modes** — say "I'm watching anime, ignore the audio" and Samuel goes passive (only responds when addressed by name). Audio is still captured silently so you can later ask "what did they just say?".
- **Control modes** — `background_workspace` / `observe_only` / `ask_before_action` / `takeover` switch between zero-touch ambient, read-only, ask-on-write, and full hands-on-keyboard.
- **Per-tab window capture** — Chrome/Safari/Arc captures hit the *exact* window matching the active tab title, not whichever browser window the OS happens to focus. Multi-display friendly.
- **No more session teardowns** — captured JPEGs are hard-capped to fit WebRTC's SCTP message limit (quality + width step-down), eliminating `INVALID_RANGE` reconnect loops.

---

## See It In Action

Samuel interprets Japanese news in realtime — watching the screen and listening to audio simultaneously:

https://github.com/user-attachments/assets/36fdd220-e1af-443a-99d3-31803160625c

Ambient teaching while watching anime — vocab cards, scene clip flashcards, and voice explanations:

https://github.com/user-attachments/assets/65314d07-694d-47c5-8209-24e5bdbdf55c

https://github.com/user-attachments/assets/338f8194-49e6-496d-b218-715af4afa1ee

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
Samuel:  "Opening Gmail now, sir." → *browser opens*
         "Please sign in if needed." → *waits*
         "You have 3 new emails. First is from Sarah about the project deadline..."

You:     "Check my GitHub notifications"
Samuel:  *opens GitHub* → *reads notification page* → summarizes
```

Gmail, Outlook, LinkedIn, your bank, internal tools — anything you can open in a browser, Samuel can read and interact with.

### Plugin Auto-Repair Pipeline (GPT-5.5 Reasoning)

When a plugin fails — whether it throws an error, returns wrong output, or you say "that's wrong" — Samuel runs a four-stage repair pipeline:

| Stage | What happens |
|---|---|
| **Detect** | Runtime exception, `validates()` failure, or user feedback |
| **Diagnose** | GPT-5.5 (high reasoning) categorizes: syntax bug, wrong API assumption, external change, structural issue |
| **Repair** | Routes to targeted patch, full rewrite, ask user, or clean give-up based on diagnosis |
| **Verify** | New code must parse and load before replacing the old version |

Max 2 attempts. If it can't fix it, you get a plain-language explanation of what went wrong and what Samuel needs from you to continue.

### Tool Wraps — Extend Existing Tools Without Replacing Them

Plugins can wrap existing tools with a middleware pattern. A plugin with `wraps: "web_browse"` gets the original tool's function as a second argument — enabling caching, logging, rate limiting, or post-processing on any built-in tool.

### Procedural Memory — Learns and Reuses Workflows

Samuel doesn't just execute tasks — he remembers how he did them. After successfully chaining 3+ tools, he saves the workflow as a reusable "skill."

```
You:     "Compare the lyrics with the real ones online and fix any mistakes"
Samuel:  *searches web → reads lyrics page → compares → corrects 4 lines*
         "Done. I've saved this as a skill for next time."

         ...next session...

You:     "The lyrics are wrong again"
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

Samuel runs a continuous perception loop:

- **Screen** — captures via GPT-4o Vision every 20s with smart change detection; fresh screenshot auto-injected when you speak (only when relevant — see Smart Context below)
- **Audio** — transcribes system audio via ScreenCaptureKit with PID-level filtering (excludes his own voice)
- **Context injection** — feeds observations silently so he always knows what's happening
- **Watcher loop** — evaluates active triggers against every audio/screen event, fires synthetic turns to speak proactively

### Smart Context — Decide Before Capturing

Always-on perception used to mean an AX-tree read + screenshot encode + injection on *every* user turn — ~1.3s of latency before Samuel could even start replying. Most turns don't need it.

Samuel now classifies each transcript before deciding to capture:

| Intent | Example | Captures? |
|---|---|---|
| Conversational ack | "yes", "thanks", "got it" | No — prior context still applies |
| Meta / chitchat | "what can you do?", "how are you?", "tell me a joke" | No — screen is irrelevant |
| Service mention | "play music on YouTube", "check my Gmail" | No — model uses tools to access the service |
| Command verb | "open Mail", "find that file" | No — model fetches fresh data via tools |
| Referential | "translate this", "what does that say" | **Yes** — pointing at the current screen |
| Anything else | "summarize this PDF" | Yes — defaults to capture when ambiguous |

When the screen is genuinely relevant, captures are de-duped by AX-tree hash (skip if nothing changed) and gated by a 5s cooldown to prevent token floods.

### Voice-First Recovery — "That wasn't me"

The mic can't tell your voice from background audio. When a video, music, another person, or a Whisper hallucination gets transcribed as a command, Samuel will act on it. Telling him is the fix:

```
You:     "Hey Samuel, ignore that last one — that wasn't me."
Samuel:  *cancels in-flight TTS* → erases bogus turn from memory + UI
         "Sorry, sir — I picked up background audio. I switched to your
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
| Control: `ask_before_action` (default) | "Ask me before doing things" | Navigation & media keys auto-allowed; writes need approval |
| Control: `takeover` | "Take the wheel" | Full keyboard/mouse control, no per-action prompts |

Inside `ask_before_action`, key-risk is classified per-action: media keys (`k`, `space`, arrows), Enter, Tab, Escape, and copy/paste auto-approve as `navigation`; only destructive shortcuts (`cmd+w`, `cmd+q`, `cmd+s`, bare `delete`) trip the approval card. No more "should I press k?" loops while playing music.

### Capability Boundaries — Honest About What He Can and Cannot Do

Samuel classifies every request before attempting it:

- **CAN DO:** anything involving his tools (screen, web, browser, files, plugins, UI, memory, songs)
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

Samuel is his own settings panel. No menus, no preferences screen:

| You say | What happens |
|---|---|
| "Make yourself smaller" | Avatar shrinks |
| "Make the window wider" | App window resizes |
| "Show me word cards while I watch" | Switches to auto vocab card mode |
| "Move the lyrics to the left" | Lyrics panel repositions + window auto-adjusts |
| "Speak quieter" / "You're too loud" | Samuel's voice volume adjusts independently |
| "Turn down the video" | macOS system volume adjusts |
| "Reset the UI" | All visual settings restored |
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

### Song Teaching Mode

Drop a YouTube link and Samuel becomes a music tutor:

1. Downloads audio, searches for lyrics (LRCLIB + Genius + web search + Whisper fallback)
2. "Play the first 3 lines" — original audio plays, mic auto-mutes
3. Audio finishes → mic unmutes → Samuel explains vocabulary and grammar
4. Lyrics display in floating HUD — tap any line to play that segment
5. Wrong lyrics? Say "the lyrics are wrong" — Samuel searches the web, compares, and corrects automatically

### Chat Box — Drop Anything, Ask Anything

- **Text** → Samuel explains, translates, teaches
- **YouTube link** → song teaching mode
- **Article URL** → extracted and annotated
- **Image / manga** → OCR + breakdown
- **API key** → securely stored

### OAuth Integration (Zero-Config for Known Providers)

For API-level access, PKCE-based OAuth with built-in client IDs for Google, GitHub, and Spotify. User just clicks "Allow" — no Cloud Console setup. Power users can override with their own credentials.

### Scene Clip Flashcards

Vocab card appears → tap "Save it" → Samuel saves the 20-second audio clip plus screenshot. Flashcards are real scenes with the original voice actor's delivery.

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
         ├─ Auto-repair: detect failure → GPT-5.5 diagnose → route repair → verify
         ├─ Wraps/middleware: plugins extend existing tools without replacing them
         ├─ Skill system: execute workflow → save as skill → replay next time
         ├─ Computer Use: GPT-5.5 visual desktop control via computer_use_preview
         ├─ OAuth: PKCE + built-in client IDs → zero-config for known providers
         ├─ Song playback: yt-dlp → local audio → HTML5 <audio> with seek
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
| whisper-1 | Song segmentation with timestamps | ~3-5s |

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
| `song_control` | Play, pause, lyrics, refetch, correct |
| `recording` | Start/stop system audio capture |
| `watch_for` | Register ambient triggers — keyword or classifier-based |
| `set_control_mode` | Switch background / observe / ask / takeover |
| `set_listening_mode` | Switch normal / passive listening |
| `discard_last_turn` | Erase the last turn from memory ("that wasn't me") |
| `set_learning_language` | Activate ambient language tutoring |
| `set_volume` | Adjust Samuel's voice or macOS system volume |
| `update_ui` / `query_ui_state` / `show_content` | Voice-controlled UI changes |
| `vocab_card` | Vocabulary cards (manual/auto mode) |
| `oauth_connect` | Zero-config OAuth for Google/GitHub/Spotify |
| `file_op` | Read, write, list files on disk |
| `store_secret` | Secure API key storage |
| `remember_preference` / `mark_vocabulary_known` / `record_correction` | Persistent memory |
| `get_recent_actions` | Self-awareness — recall recent tool calls |
| `pronounce` | Speak correct pronunciation |

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
| Song Audio | [yt-dlp](https://github.com/yt-dlp/yt-dlp) + HTML5 Audio |
| Lyrics | [LRCLIB](https://lrclib.net) + [Genius](https://genius.com) + web search fallback |
| Web Search | [SerpAPI](https://serpapi.com) (Google) + OpenAI deep search + Brave fallback |
| Animation | [Rive](https://rive.app) |
| Screen Capture | [Peekaboo](https://github.com/nicklama/peekaboo) + macOS `screencapture` + per-tab title match |
| Audio Capture | ScreenCaptureKit (Swift), PID-level filtering |

---

## Quick Start

> **Heads up:** A one-click installer is on the way. For now, install requires building from source. Star this repo or [open an issue](https://github.com/sambuild04/screen-voice-agent/issues/new?title=Notify+me+when+installer+is+ready) to be notified when the packaged release ships.

### Prerequisites

- macOS 14+ (Sonoma or later)
- Node.js 20+
- OpenAI API key with Realtime API + GPT-5.5 access
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`brew install yt-dlp`) for song features

### Install

```bash
brew install steipete/tap/peekaboo yt-dlp
git clone https://github.com/sambuild04/screen-voice-agent.git
cd screen-voice-agent
npm install
npx playwright install chromium
swiftc -o helpers/record-audio helpers/record-audio.swift \
  -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia
mkdir -p ~/.samuel && echo '{"apiKey": "sk-..."}' > ~/.samuel/config.json
```

Grant macOS permissions:
- **System Settings → Privacy & Security → Screen Recording** → add Samuel + Peekaboo
- **System Settings → Privacy & Security → Accessibility** → add Samuel (needed for AX-tree reads + native input)

```bash
npm run electron:dev
```

Say **"Hey Samuel"** and start talking.

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

The vision: an AI that lives where you work, sees what you see, hears what you hear, writes its own tools, fixes its own bugs, and gets better at helping you every day.

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
- **SRS scheduling** — spaced repetition on saved scene flashcards.
- **Auto-healing plugins** — if a plugin fails in the background, auto-fix without interrupting the user. *(shipped — up to 2 attempts)*
- **Anki export.**

---

## How It Compares

| Capability | **Samuel** | ChatGPT Voice | Granola | Cluely | Otter.ai |
|---|---|---|---|---|---|
| Voice conversation | Yes | Yes | No | No | No |
| Screen vision | Yes | Partial | No | Yes | No |
| Audio listening | Yes | No | Yes | Yes | Yes |
| Proactive alerts ("tell me when X") | Yes | No | No | No | No |
| Web browsing (real browser) | Yes | No | No | No | No |
| Self-modifying (writes tools) | Yes | No | No | No | No |
| Auto-repairs its own tools | Yes | No | No | No | No |
| Persistent memory | Yes | Limited | No | No | No |
| Open source | Yes (MIT) | No | No | No | No |

---

## FAQ

**What is Samuel?**
An open-source voice AI desktop agent that continuously sees your screen and hears your audio, lets you control it by voice, browses the web like a human, and writes and repairs its own tools at runtime using GPT-5.5 with reasoning.

**What can I use it for?**
Language learning while watching content, hands-free web browsing ("show me my emails"), building custom AI tools by voice, live meeting interpretation, searching and summarizing anything on the web, ambient monitoring ("tell me when you hear X"), and general desktop automation.

**How is this different from ChatGPT Voice?**
ChatGPT can't see your screen continuously, can't browse the web as a real browser, can't write persistent tools, and can't auto-repair when things break. Samuel does all of these, and runs locally on your Mac.

**What models does it use?**
OpenAI Realtime API for voice, GPT-5.5 with reasoning for code generation and failure diagnosis, GPT-4o Vision for screen capture, GPT-4o-mini for code review, Whisper for transcription.

**How does auto-repair work?**
Every plugin declares a `validates()` function. If output fails validation, or the user says "that's wrong," GPT-5.5 diagnoses the failure (syntax bug? API change? structural issue?), picks a repair strategy (patch, rewrite, or ask user), generates a fix, and verifies it before deploying. Max 2 attempts, then clean escalation.

**Can Samuel modify its existing tools?**
Yes, via the wraps/middleware pattern. A plugin can wrap any existing tool — intercepting calls, modifying inputs/outputs, adding caching or logging — without replacing the original.

**Does Samuel browse the web?**
Three ways: (1) API-based search via SerpAPI, (2) AI-powered deep search via OpenAI, (3) real browser automation via Playwright where he opens a visible Chromium window, you sign in, and he reads/interacts with the page.

**Is my data private?**
Screen captures and audio are sent to OpenAI for processing. Memory, preferences, skills, plugins, and secrets are stored locally in `~/.samuel/`. Browser sessions run locally via Playwright.

**Is it free?**
The code is MIT-licensed. You pay OpenAI API costs directly.

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
