# Samuel — AI That Watches Your Screen and Teaches You by Voice in Real Time

> A real-time voice AI tutor that lives on your desktop. It sees your screen, hears your audio, and teaches you vocabulary, grammar, and pronunciation — out loud, by voice — while you watch anime, browse the web, or read a book. No typing. No flashcards. Just say "Hey Samuel."

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![macOS](https://img.shields.io/badge/platform-macOS-black.svg)
![Tauri v2](https://img.shields.io/badge/Tauri-v2-orange.svg)
![OpenAI Realtime API](https://img.shields.io/badge/OpenAI-Realtime%20Voice-412991.svg)
![Stars](https://img.shields.io/github/stars/sambuild04/reading-ai-agent?style=social)

**Keywords:** AI language tutor, real-time voice teaching, learn Japanese while watching anime, AI desktop pet, ambient learning agent, OpenAI Realtime API voice agent, screen-aware AI, Tauri desktop app, voice-first AI assistant, learn languages from video

---

## See It In Action

https://github.com/user-attachments/assets/65314d07-694d-47c5-8209-24e5bdbdf55c

### Watch Anime, Learn Japanese — Samuel Teaches by Voice While You Watch

https://github.com/user-attachments/assets/338f8194-49e6-496d-b218-715af4afa1ee

### Ambient Learning Mode — Screen + Audio Monitoring

![Samuel watches anime and teaches Japanese vocabulary by voice in real time](docs/samuel-learning-mode.gif)

You're watching a video. Samuel sees the subtitles, hears the dialogue, and **speaks to you by voice**: "食べる — 'to eat', sir." You don't press anything. You don't look away from the video. He just tells you.

Ask "what did they just say?" and he answers instantly — because he was already listening.

---

## The Problem

You want to learn a language. You download Duolingo. You do it for a week. You stop.

Meanwhile, you watch 3 hours of anime, K-dramas, or YouTube every day — content **in** the language you want to learn — and retain nothing because there's no one sitting next to you explaining what the words mean.

**Samuel is that person.** Except he speaks to you in real time, by voice, hands-free.

---

## How Samuel Teaches You (By Voice, In Real Time)

Samuel doesn't send you text notifications or flashcards. He **talks to you**:

1. You watch a video with Japanese subtitles
2. Samuel sees "取得していること" on your screen and hears the audio
3. He speaks: *"取得 — 'to acquire', sir. This is a formal requirement pattern."*
4. You keep watching. 20 seconds later, he catches another word.
5. You say "what did they just say?" — he heard the whole clip and tells you

All voice. All real time. Zero interruption to your workflow.

### Highlight Any Word — He Reads Your Selection

See a word you don't understand? **Highlight it.** Say "what's this word?" Samuel reads your exact text selection from the clipboard — no guessing from screenshots — and teaches you the meaning, reading, and usage by voice.

### He Remembers What You Know

Tell Samuel "I already know that" and he **permanently** stops teaching that word. Tell him "I'm intermediate" and he skips beginner content. His memory persists across sessions — he adapts to your level over time.

---

## What Makes Samuel Different

| | Duolingo / Busuu / Anki | ChatGPT / Gemini | **Samuel** |
|---|---|---|---|
| **Teaches by voice** | No | Text only | **Yes — real-time speech** |
| **Watches your screen** | No | No | **Yes — sees subtitles, web pages, books** |
| **Listens to audio** | No | No | **Yes — hears video dialogue, podcasts** |
| **Teaches from YOUR content** | No (app exercises) | Only if you paste it | **Automatic — whatever is on screen** |
| **Hands-free** | No | No | **Yes — "Hey Samuel" wake word** |
| **Remembers your level** | Per-app only | Per-session | **Permanent adaptive memory** |
| **Always available** | Must open app | Must open tab | **Floats on desktop 24/7** |

---

## Key Features

### Real-Time Voice Teaching Engine
- **Speaks to you** — not text, not notifications. Actual voice output via OpenAI Realtime API (WebRTC, <500ms latency)
- **"Hey Samuel" wake word** — detected locally via Whisper. Always listening, like Siri
- **Continuous perception loop** — every 20 seconds: captures screen (GPT-4o Vision) + transcribes system audio (ScreenCaptureKit) → triage engine decides whether to speak
- **Silent context absorption** — even when Samuel doesn't speak, he's absorbing what's happening. Ask him about it anytime

### Persistent Adaptive Memory
- Tracks every word taught — 24-hour cooldown, no repeats
- **Permanently remembers** words you mark as known
- Stores proficiency level, study goals, preferences across sessions
- Adapts difficulty: tell him "skip basic stuff" and he does, forever
- Local storage in `~/.samuel/memory.json`

### Highlight-to-Learn
- **Reads your exact text selection** via clipboard — no Vision API guessing
- Highlight any word on any webpage → "what's this word?" → instant voice explanation
- Works in Chrome, Safari, Firefox, any app with selectable text

### Works With Any Content
- **Anime / K-dramas / YouTube** — hears dialogue, reads subtitles, teaches vocabulary
- **Apple Books** — reads pages aloud, navigates chapters via GPT-5.4 Computer Use
- **Websites** — sees foreign text or teaches target language equivalents of English content
- **Podcasts / Zoom calls** — transcribes system audio, answers questions about what was said
- **Multi-monitor** — "look at my Chrome" captures the right window across displays

### Any Language
Japanese, Chinese, Korean, Spanish, French, German, Portuguese, Arabic, Russian, Thai, Vietnamese, Hindi — say "I'm learning [language]" and everything adapts.

### Session Resilience
- Heartbeat keepalive (30s pings) — no silent disconnects
- Auto-rotation every 25 min before the 60-min hard cap
- 6-turn context replay on reconnect — Samuel remembers the conversation
- Auto-reconnect on unexpected drops (2s recovery)

---

## Architecture

```
You speak → "Hey Samuel" wake word → OpenAI Realtime API → 12 tools → Voice response
                                              ↕
               Always watching screen (GPT-4o Vision, change detection)
               Always listening to audio (ScreenCaptureKit, PID filtering)
               Triage engine: ignore / hint card / speak aloud
               Silent context injection — Samuel remembers everything
```

| What you say | What Samuel does |
|---|---|
| "Read this page" | Captures Apple Books page, reads it aloud by voice |
| "Summarize chapter 9" | Auto-turns pages, reads entire chapter via Vision |
| "Go to chapter 6" | GPT-5.4 Computer Use clicks through the UI |
| "Look at my Chrome" | Finds Chrome on any monitor, captures and describes |
| "Translate my screen" | Translates all visible foreign text with readings |
| "What's this word I'm highlighting?" | Reads exact clipboard selection, teaches by voice |
| "How do you say 'cat'?" | Pronounces it in your target language |
| "Start recording" | Records system audio for deep analysis |
| "I'm learning Spanish" | Activates ambient voice teaching for Spanish |
| "What did they just say?" | References ambient audio buffer to answer |
| "I already know that" | Permanently suppresses that word |

### Models (6-model orchestration)

| Model | Purpose | Latency |
|---|---|---|
| **OpenAI Realtime API** | Voice conversation, teaching, reading | ~500ms |
| **GPT-4o Vision** | Screen scanning, ambient observation | ~3-5s |
| **GPT-4o-mini** | Triage classification (ignore/notify/act) | ~1s |
| **GPT-5.4 Computer Use** | Visual UI navigation | ~5-10s/turn |
| **gpt-4o-mini-transcribe** | Wake word + ambient audio | ~1s |
| **gpt-4o-transcribe** | Recording mode (high-fidelity) | ~3-10s |

```
src/                          React frontend (Vite + TypeScript)
├── hooks/
│   ├── useRealtime.ts        Realtime voice: heartbeat, reconnect, context replay
│   ├── useWakeWord.ts        "Hey Samuel" detection via Whisper
│   ├── useRecordMode.ts      System audio recording + analysis
│   └── useLearningMode.ts    Ambient agent: parallel screen+audio, triage, silent context
├── lib/
│   ├── samuel.ts             Agent: 12 consolidated tools, adaptive memory, voice persona
│   └── session-bridge.ts     Bridges: image, silent context, recording, learning
├── components/
│   ├── Character.tsx          Rive animation + manga speech bubbles
│   └── PassiveSuggestion.tsx  Frosted-glass hint cards
└── styles/app.css             Transparent window, animations

src-tauri/                    Rust backend (Tauri v2)
├── helpers/
│   └── record-audio.swift    ScreenCaptureKit with PID-level process filtering
└── src/
    ├── commands.rs           Screen capture, Vision, Computer Use, triage, audio, clipboard
    ├── memory.rs             Persistent adaptive memory: vocab, facts, proficiency
    └── wake_word.rs          Whisper wake word with cross-clip matching
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop | [Tauri v2](https://v2.tauri.app) (Rust + WebView) |
| Frontend | React 19 + Vite + TypeScript |
| Voice | [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime) (WebRTC) |
| Agent Framework | [`@openai/agents`](https://github.com/openai/openai-agents-js) |
| Vision | GPT-4o Vision |
| Computer Use | GPT-5.4 Responses API |
| Animation | [Rive](https://rive.app) |
| Screen Capture | [Peekaboo](https://github.com/nicklama/peekaboo) + macOS `screencapture` |
| Audio Capture | ScreenCaptureKit (Swift) with process-level filtering |
| Text Selection | Clipboard bridge (Cmd+C → pbpaste → restore) |
| Window Transparency | Cocoa NSWindow via `macos-private-api` |

---

## Quick Start

### Prerequisites
- **macOS 14+** (Sonoma or later)
- **Node.js 20+** and **Rust** ([rustup.rs](https://rustup.rs))
- **OpenAI API key** with Realtime API + GPT-4o + GPT-5.4 access

### Install

```bash
brew install steipete/tap/peekaboo

git clone https://github.com/sambuild04/reading-ai-agent.git
cd reading-ai-agent
npm install

swiftc -o src-tauri/helpers/record-audio src-tauri/helpers/record-audio.swift \
  -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia

echo '{"apiKey": "sk-..."}' > ~/.books-reader.json

# Grant Screen Recording: System Settings → Privacy & Security → Screen Recording → add peekaboo + samuel

npm run tauri:dev
```

Say **"Hey Samuel"** and start learning.

---

## API Costs

| Mode | Cost |
|---|---|
| Wake word (always listening) | ~$0.006/min |
| Ambient teaching (screen + audio + triage) | ~$0.02–0.05/min |
| Book reading | ~$0.01/page |
| Voice conversation | Standard Realtime API pricing |

---

## Limitations

- **macOS only** — relies on Apple Books, Peekaboo, ScreenCaptureKit
- **DRM content** — protected books may produce black screenshots
- **GPT-5.4 access** — required for Computer Use navigation
- **Copyright** — Vision API may decline to transcribe copyrighted text verbatim

---

## Roadmap

- Local on-device wake word (zero-cost, instant activation)
- Pre-routing classifier (GPT-4o-mini intent classification before tool selection)
- Custom AI-generated companion characters via Rive
- Anki flashcard export from learned vocabulary
- iOS / Android companion app
- Plugin system for custom tools and behaviors

---

## Contributing

Samuel is a solo project, but the ambient voice teaching pattern has a lot of unexplored potential. Issues and PRs welcome.

## License

MIT

---

**Built by [Sam Feng](https://github.com/sambuild04)** — if Samuel helps you learn, star the repo so others can find it.
