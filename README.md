# Samuel — Your AI That Watches, Listens, and Teaches You in Real Time

> An ambient AI desktop agent that floats on your screen like a virtual pet. It watches what you watch. It hears what you hear. Then it teaches you — vocabulary, grammar, pronunciation — in real time, from whatever content you're already consuming. No flashcards. No apps. Just say "Hey Samuel."

![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)
![macOS](https://img.shields.io/badge/platform-macOS-black.svg)
![Tauri v2](https://img.shields.io/badge/Tauri-v2-orange.svg)
![OpenAI Realtime API](https://img.shields.io/badge/OpenAI-Realtime%20API-412991.svg)
![Stars](https://img.shields.io/github/stars/sambuild04/reading-ai-agent?style=social)

## See It In Action

https://github.com/user-attachments/assets/65314d07-694d-47c5-8209-24e5bdbdf55c

### Real-Time Teaching — Learn While You Watch

![Samuel watches anime and teaches Japanese vocabulary from subtitles and dialogue in real time](docs/samuel-learning-mode.gif)

Samuel sits on your desktop, transparent and unobtrusive. While you watch a video, he **reads the subtitles and listens to the dialogue simultaneously**, then teaches you what the words mean — all by voice, without you doing anything.

Ask "what did they just say?" and he answers instantly, because he was already listening.

---

## The Problem

You want to learn a language. You download Duolingo. You do it for a week. You stop.

Meanwhile, you watch 3 hours of anime, K-dramas, or YouTube every day — content **in** the language you want to learn — and retain nothing because there's no one sitting next to you explaining what the words mean.

**Samuel is that person.**

He watches with you. He listens with you. And every time something interesting comes up, he tells you what it means — in his voice, as a brief aside, without pausing the video. If you already know a word, tell him, and he'll never mention it again. He remembers your level and adapts.

---

## What Makes Samuel Different

| Feature | Traditional apps | Samuel |
|---|---|---|
| Content source | App-provided exercises | **Whatever you're already watching, reading, or browsing** |
| Input method | Typing / tapping | **Voice — hands-free** |
| Teaching trigger | You open the app | **Automatic — he notices content on your screen** |
| Availability | In-app only | **Always on your desktop** |
| Memory | Per-session | **Persistent — remembers what you know across sessions** |
| Interruption model | Push notifications | **Attention-aware — stays silent when you're focused** |

---

## Key Features

### Ambient Learning Agent
Samuel runs a continuous perception loop every 20 seconds:

1. **Captures your screen** via GPT-4o Vision (with perceptual change detection — skips if nothing changed)
2. **Transcribes system audio** via ScreenCaptureKit (with PID filtering to exclude his own voice)
3. **Triages both** through GPT-4o-mini to decide: ignore, show a hint card, or speak
4. **Injects everything as silent context** into his conversation memory — so when you ask questions, he knows what happened

This means Samuel is always aware of what you're doing, but only speaks up when it's worth it.

### Persistent Adaptive Memory
- Tracks every word he's taught you — won't repeat it for 24 hours
- **Permanently remembers** words you mark as known — they never come back
- Stores your proficiency level, study goals, and preferences across sessions
- Adapts teaching difficulty based on what you know
- All stored locally in `~/.samuel/memory.json`

### Voice-First Interaction
- **"Hey Samuel" wake word** — detected locally via Whisper, no cloud VAD
- **Real-time voice conversation** via OpenAI Realtime API (WebRTC)
- **Session resilience** — heartbeat keepalive, 25-min rotation, auto-reconnect with 6-turn context replay
- British butler persona — concise, polished, never annoying

### Works With Any Content
- **Videos** — anime, K-dramas, YouTube, Netflix, lectures
- **Books** — reads Apple Books pages aloud, navigates chapters visually via GPT-5.4 Computer Use
- **Websites** — notices foreign text (or teaches target language equivalents of English content)
- **Podcasts and calls** — transcribes system audio and answers questions about what was said
- **Multi-monitor** — "look at my Chrome" captures the right window on any display

### Any Language
Japanese, Chinese, Korean, Spanish, French, German, Portuguese, Arabic, Russian, Thai, Vietnamese, Hindi — say "I'm learning [language]" and Samuel adapts everything.

---

## How It Works

```
Microphone → "Hey Samuel" wake word → OpenAI Realtime API → Tools → Voice response
                                              ↕
               Always watching screen (GPT-4o Vision, 20s cycle)
               Always listening to audio (ScreenCaptureKit, 20s cycle)
               Triage engine decides what's worth mentioning
               Silent context injection — Samuel remembers everything
```

| What you say | What Samuel does |
|---|---|
| "Read this page" | Captures Apple Books page as image, reads it aloud |
| "Summarize chapter 9" | Reads every page via Vision until next chapter |
| "Go to chapter 6" | GPT-5.4 Computer Use navigates the UI visually |
| "Look at my Chrome" | Finds Chrome on any monitor, captures it |
| "Translate my screen" | Translates all visible foreign text with readings |
| "Explain this grammar" | Breaks down particles, conjugation, sentence structure |
| "How do you say 'cat'?" | Pronounces it in your target language with accent tips |
| "Start recording" | Records system audio for deep language analysis |
| "I'm learning Spanish" | Activates ambient learning for Spanish |
| "What did they just say?" | References ambient audio buffer to answer |
| "I already know that word" | Marks it as permanently known — never mentioned again |

---

## Architecture

```
src/                          React frontend (Vite + TypeScript)
├── App.tsx                   Main app + wake word activation flow
├── hooks/
│   ├── useRealtime.ts        Realtime API: heartbeat, reconnect, context replay
│   ├── useWakeWord.ts        "Hey Samuel" detection via Whisper
│   ├── useRecordMode.ts      System audio recording + analysis pipeline
│   └── useLearningMode.ts    Ambient agent: parallel screen+audio, triage, silent context
├── lib/
│   ├── samuel.ts             Agent persona, 17 tools, adaptive memory instructions
│   ├── session-bridge.ts     Bridges: image injection, silent context, recording, learning
│   └── sounds.ts             Audio cues (chime on wake, tone on idle)
├── components/
│   ├── Character.tsx          Rive animation + manga-style speech bubbles
│   ├── PassiveSuggestion.tsx  Frosted-glass hint cards for ambient observations
│   ├── ScreenPicker.tsx       Multi-monitor display selector
│   └── StatusBar.tsx          Connection state indicator
└── styles/app.css             Transparent window + animations

src-tauri/                    Rust backend (Tauri v2)
├── helpers/
│   └── record-audio.swift    ScreenCaptureKit capture with PID-level process filtering
└── src/
    ├── lib.rs                Tauri setup + macOS transparent window (Cocoa)
    ├── commands.rs           Screen capture, Vision API, Computer Use, triage engine,
    │                         audio pipeline, ephemeral keys, display detection
    ├── memory.rs             Persistent adaptive memory: vocab, facts, transcripts
    └── wake_word.rs          Whisper wake word with cross-clip matching
```

### Models Used

| Model | Purpose | Latency |
|---|---|---|
| **OpenAI Realtime API** | Voice conversation, reading, translation | ~2s |
| **GPT-4o Vision** | Screen analysis, ambient observation | ~3-5s |
| **GPT-4o-mini** | Triage classification (ignore/notify/act) | ~1s |
| **GPT-5.4 Computer Use** | Visual UI navigation (click, scroll, type) | ~5-10s/turn |
| **gpt-4o-mini-transcribe** | Wake word + ambient audio transcription | ~1s |
| **gpt-4o-transcribe** | Recording mode (high-fidelity transcription) | ~3-10s |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop | [Tauri v2](https://v2.tauri.app) (Rust + WebView) |
| Frontend | React 19 + Vite + TypeScript |
| Voice | [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime) (WebRTC) |
| Agent Framework | [`@openai/agents`](https://github.com/openai/openai-agents-js) |
| Vision | GPT-4o Vision API |
| Computer Use | GPT-5.4 Responses API |
| Animation | [Rive](https://rive.app) |
| Screen Capture | [Peekaboo](https://github.com/nicklama/peekaboo) + macOS `screencapture` |
| System Audio | ScreenCaptureKit (Swift) with process-level filtering |
| Window Transparency | Cocoa NSWindow via `macos-private-api` |

---

## Quick Start

### Prerequisites
- **macOS 14+** (Sonoma or later)
- **Node.js 20+** and **Rust** ([rustup.rs](https://rustup.rs))
- **OpenAI API key** with Realtime API + GPT-4o + GPT-5.4 access

### Install

```bash
# Install Peekaboo for screen capture
brew install steipete/tap/peekaboo

# Clone and install
git clone https://github.com/sambuild04/reading-ai-agent.git
cd reading-ai-agent
npm install

# Compile the audio capture helper
swiftc -o src-tauri/helpers/record-audio src-tauri/helpers/record-audio.swift \
  -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia

# Set your API key
echo '{"apiKey": "sk-..."}' > ~/.books-reader.json

# Grant Screen Recording permission
# System Settings → Privacy & Security → Screen Recording → add peekaboo + samuel

# Run
npm run tauri:dev
```

Say **"Hey Samuel"** and start learning.

---

## API Costs

- Wake word detection: ~$0.006/min
- Ambient learning mode: ~$0.02–0.05/min (Vision + transcription + triage)
- Book reading: ~$0.01/page
- Voice conversation: standard Realtime API pricing

---

## Limitations

- **macOS only** — uses Apple Books, Peekaboo, ScreenCaptureKit
- **DRM content** — protected books may produce black screenshots
- **GPT-5.4 access required** — for Computer Use navigation features
- **Copyright** — Vision API may decline to transcribe copyrighted text verbatim

---

## Roadmap

- Local on-device wake word (zero-cost, instant activation)
- Custom AI-generated companion characters
- Anki flashcard export from learned vocabulary
- iOS / Android companion app
- Plugin system for custom tools and behaviors
- Multi-language simultaneous learning

---

## Contributing

Samuel is a solo project, but the ambient agent pattern has a lot of unexplored potential. Issues and PRs welcome.

## License

MIT

---

**Built by [Sam Feng](https://github.com/sambuild04)** — if Samuel helps you learn, star the repo so others can find it.
