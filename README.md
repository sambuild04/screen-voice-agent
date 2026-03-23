# Samuel — Your AI Desktop Companion for Reading & Language Learning

An always-on-top, transparent desktop AI assistant for macOS — like QQ Pet meets JARVIS. Samuel floats on your screen as an animated character with manga-style speech bubbles, reads your Apple Books aloud, helps you learn Japanese/Chinese/Korean from any app, and responds to voice commands hands-free.

Built with Tauri v2, OpenAI Realtime API, GPT-5.4 Computer Use, GPT-4o Vision, Rive character animation, and Whisper-powered wake word detection.

**Keywords**: AI reading assistant, macOS AI desktop companion, voice-controlled book reader, Apple Books AI, language learning AI, Japanese learning tool, anime language learning, real-time translation, GPT-5.4 computer use, OpenAI Realtime API voice agent, Tauri desktop app, QQ Pet style AI, transparent desktop widget, Rive animation, system audio recording, active screen scanning, proactive AI assistant, JARVIS-style AI

## Demo

https://github.com/user-attachments/assets/b43b1177-82b0-4153-91b1-f3d2d12adddf

## How It Works

```
You speak → Realtime API (gpt-realtime) → Samuel picks tools → Action executes → Samuel responds with voice
```

Samuel is a voice agent powered by OpenAI's Agents SDK (`@openai/agents/realtime`). He listens through your microphone and responds with natural speech in real time. When you ask him to do something, he picks the right tool:

| Request | Tool | How |
|---|---|---|
| "Read this page" | `read_page` | Captures Apple Books page as image, reads it via Realtime API |
| "Summarize chapter 9" | `read_chapter` | Loops Vision API reads + page turns until next chapter heading |
| "Go to chapter 6" | `interact_with_book` | GPT-5.4 Computer Use sees the screen and navigates visually |
| "Turn the page" | `next_page` | Instant hotkey via Peekaboo |
| "Look at my screen" | `view_screen` | Captures any app window and shows it to the AI |
| "Translate this" | `translate_screen` | Captures screen, translates all foreign text |
| "Explain this grammar" | `explain_grammar` | Captures screen, breaks down grammar points |
| "How do you say hello?" | `pronounce` | Speaks correct pronunciation in any language |
| "Start recording" | `start_recording` | Captures system audio (anime, video) for language analysis |
| "Stop recording" | `stop_recording` | Stops recording, runs background analysis with vocabulary/grammar |
| "I'm learning Japanese" | `set_learning_language` | Activates learning mode — periodic screen scanning for target language |
| "What time is it?" | `get_current_time` | Returns local date, time, day, and timezone |

## Features

### Animated Desktop Companion (QQ Pet Style)
- **Transparent floating window** — Samuel sits on top of all apps like a desktop pet
- **Rive character animation** — animated expressions mapped to agent states (idle, listening, thinking, speaking)
- **Manga-style speech bubbles** — chat appears in frosted-glass speech bubbles around the character, no separate chat window
- **Draggable** — grab and move Samuel anywhere on your desktop
- **Always on top** — stays visible while you read or browse

### "Hey Samuel" Wake Word
- Hands-free activation — just say "Hey Samuel" and the assistant connects
- Uses Web Audio API + OpenAI Whisper for continuous speech detection
- Plays a chime on activation and a soft tone when going idle
- Automatically returns to listening mode after inactivity (15s grace period after greeting)

### Voice Conversation
- Real-time speech-to-speech via OpenAI Realtime API
- Natural voice with polished British butler persona
- Server-side VAD with echo cancellation and noise reduction
- Multi-layered echo guard prevents the agent from responding to its own speech

### Smart Book Reading
- **Single page**: Captures the Apple Books page as an image and reads it directly via the Realtime model
- **Full chapter**: Automatically reads every page, turning them one by one, stops when it detects the next chapter heading
- **Partial reading**: "Read the first sentence" — reads the page, speaks only the requested portion
- **Follow-up questions**: Answers from memory without re-reading

### Visual Navigation (GPT-5.4 Computer Use)
- Sees the actual screen and clicks, types, scrolls through Apple Books
- Navigate to any chapter by visually finding it
- Open table of contents, search for text, interact with any UI element
- Autonomous multi-step navigation without brittle hotkey sequences

### Language Learning (Japanese, Chinese, Korean & More)
- **Screen capture from any app** — look at a browser with Japanese text, a textbook PDF, a language learning site
- **Real-time translation** — captures your screen and translates all visible foreign text with readings and pronunciation
- **Grammar explanation** — breaks down sentence structure, particles, conjugation, politeness levels, with examples
- **Pronunciation** — speaks words/phrases slowly then at natural speed, with tips on pitch accent/tones
- **Auto-detect language** — works with Japanese, Chinese, Korean, Spanish, or any language on screen
- For Japanese: always includes furigana/romaji. For Chinese: pinyin with tone marks. For Korean: romanization.

### Multi-Monitor Support
- **Voice-driven targeting**: Say "look at my Chrome" or "translate what's in Safari" — Samuel captures the right app window, even on a different display
- **Display picker UI**: Small monitor icon in the header lets you choose which display to capture by default
- **Automatic display detection**: When targeting a specific app, Samuel determines which physical monitor the app is on using window position mapping
- **Screen target indicator**: A brief "Looking at: Chrome" badge appears so you always know what Samuel captured

### Recording Mode (System Audio Capture)
- **Record anime/video audio** — say "start recording" while watching, Samuel captures system audio in the background
- **Automatic language analysis** — after stopping, GPT-4o-transcribe + GPT-4o analyze the recording for vocabulary, grammar, and dialogue
- **Bilingual transcript** — original dialogue with English translations side by side
- **Visual progress bar** — two-stage indicator (Transcribing → Analyzing) with elapsed time
- **Seamless integration** — analysis runs in background, Samuel notifies when ready, and you can chat about the clip
- **Language agnostic** — works with Japanese, Chinese, Korean, Spanish, or any language

### Active Learning Mode (Screen Scanning)
- **Tell Samuel your language** — say "I'm learning Japanese" and learning mode activates
- **Periodic screen scanning** — every 90 seconds, captures your screen and checks for target language content via GPT-4o Vision
- **Proactive vocabulary hints** — when Japanese/Chinese/Korean text is detected, Samuel briefly mentions interesting words or grammar
- **Silent when nothing found** — no interruptions if no target language is on screen
- **Persistent across sessions** — learning language preference saved in localStorage
- **Visual indicator** — blue "Learning: Japanese" badge on the character when active
- **Combines with Record Mode** — Samuel suggests "start recording" when you're watching target-language video

### Time-Aware Greetings
- Samuel greets contextually based on your local time — "Good evening, sir" instead of generic hello
- Current date and time injected at session start
- Timezone-aware via `get_current_time` tool

### UI & Experience
- **Frosted-glass speech bubbles** with backdrop blur — translucent, modern aesthetic
- **Screen target badge** — shows which app/display was captured after each screen tool use
- **State indicators**: listening waveform, thinking animation, speaking glow
- **Mic mute and disconnect controls** in the draggable header bar
- **Auto-reconnect** — detects server-side session timeouts and reconnects cleanly on next wake word

## Requirements

- **macOS** (Apple Books + Peekaboo)
- **Node.js** 20+
- **Rust** (for Tauri — install via [rustup.rs](https://rustup.rs))
- **Peekaboo** for screen capture and UI automation
- **OpenAI API key** with access to GPT-4o, Realtime API, and GPT-5.4

## Setup

### 1. Install Peekaboo

```bash
brew install steipete/tap/peekaboo
```

Grant permissions when prompted:
- **Screen Recording** — so Peekaboo can capture screenshots
- **Accessibility** — so Peekaboo can send keystrokes and clicks

Verify:
```bash
peekaboo permissions
```

### 2. Install Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

### 3. Install dependencies

```bash
cd books-reader
npm install
```

### 4. Set your API key

Create `~/.books-reader.json`:

```json
{
  "apiKey": "sk-..."
}
```

Or set the environment variable:

```bash
export OPENAI_API_KEY="sk-..."
```

### 5. Grant Screen Recording permission

The Tauri app needs Screen Recording access to capture Apple Books pages and other app windows. Go to:

**System Settings → Privacy & Security → Screen Recording** → add the `samuel` binary (found at `src-tauri/target/debug/samuel` during development).

Also ensure `peekaboo` is listed there.

## Usage

Open a book in Apple Books, then:

```bash
npm run tauri:dev
```

Say **"Hey Samuel"** and start talking:

- "Samuel, read the current page"
- "Summarize chapter 9 for me"
- "Go to chapter 4"
- "Search for the word 'traction'"
- "What did that last part mean?"
- "Turn to the next page and read it"
- "Look at my Chrome" (captures Chrome on any monitor)
- "Translate what's on my screen"
- "Explain the grammar of this sentence"
- "How do you pronounce こんにちは?"
- "Start recording" (captures system audio while you watch anime)
- "Stop recording" (analyzes the clip for vocabulary and grammar)
- "I'm learning Japanese" (activates periodic screen scanning for Japanese content)
- "Stop learning mode"
- "What time is it?"

## Architecture

```
src/                          React frontend (Vite + TypeScript)
├── App.tsx                   Main app layout + wake word flow + idle detection
├── hooks/
│   ├── useRealtime.ts        Realtime API connection, audio I/O, transcript, echo guard
│   ├── useWakeWord.ts        "Hey Samuel" detection (continuous clips + Whisper)
│   ├── useRecordMode.ts      Recording state, analysis progress, background analysis
│   └── useLearningMode.ts    Active learning mode — periodic screen checks, persistence
├── lib/
│   ├── samuel.ts             Agent definition: persona, tools, instructions
│   ├── session-bridge.ts     Bridge for images, text, recording, and learning mode
│   └── sounds.ts             Sound cues (chime on wake, tone on idle)
├── components/
│   ├── Character.tsx          Rive character animation + manga speech bubbles + badges
│   ├── ScreenPicker.tsx       Multi-monitor display selector dropdown
│   └── StatusBar.tsx          Connection + agent state display
└── styles/app.css             Transparent window, speech bubbles, animations

src-tauri/                    Rust backend (Tauri v2)
└── src/
    ├── lib.rs                Tauri command registration + macOS transparency setup
    ├── commands.rs           All backend logic:
    │                         - Peekaboo wrappers (capture, hotkeys, click)
    │                         - GPT-4o Vision API (analyze_page, check_screen_for_language)
    │                         - GPT-5.4 Computer Use loop (computer_use_task)
    │                         - System audio recording + transcription + analysis
    │                         - Multi-monitor display detection + capture
    │                         - Ephemeral key minting for Realtime API
    │                         - Apple Books activation and window management
    └── wake_word.rs          gpt-4o-mini-transcribe wake word with cross-clip matching
```

### Tool Architecture

| Tool | Backend | Model | Speed | Best for |
|---|---|---|---|---|
| `read_page` | Direct image → Realtime API | `gpt-realtime` | ~2s | Reading one page |
| `read_chapter` | Vision API loop | `gpt-4o` | ~3s/page | Reading full chapters |
| `interact_with_book` | Responses API | `gpt-5.4` CUA | ~5-10s/turn | Navigation, search, complex UI |
| `view_screen` | Peekaboo / screencapture | `gpt-realtime` | ~2s | Looking at any app |
| `translate_screen` | Peekaboo / screencapture | `gpt-realtime` | ~2s | Translating screen content |
| `explain_grammar` | Peekaboo / screencapture | `gpt-realtime` | ~2s | Grammar explanations |
| `pronounce` | Realtime voice output | `gpt-realtime` | Instant | Pronunciation |
| `next_page` / `prev_page` | Peekaboo hotkey | None | Instant | Simple page turns |
| `start_recording` / `stop_recording` | ScreenCaptureKit (Swift helper) | None | Instant | System audio capture |
| `analyze_recording` | gpt-4o-transcribe + GPT-4o | `gpt-4o` | ~10-30s | Recording breakdown |
| `check_screen_for_language` | GPT-4o Vision (low detail) | `gpt-4o` | ~3-5s | Learning mode scans |
| `set_learning_language` | localStorage + bridge | None | Instant | Toggle learning mode |
| `get_current_time` | JS Date API | None | Instant | Timezone awareness |

### Multi-Model Strategy

- **Realtime API** (`read_page`, `view_screen`, `translate_screen`, `explain_grammar`): Images injected directly into the Realtime session. The model sees the screenshot and responds with voice in one round-trip. Fastest for interactive use.
- **GPT-4o Vision** (`read_chapter`): Fast text extraction with high output limits. Used for batch page reading where text is needed for chapter boundary detection.
- **GPT-5.4 Computer Use** (`interact_with_book`): Takes screenshots and returns UI actions (click, type, scroll). Ideal for navigation but slower per turn.

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop Framework | Tauri v2 (Rust + WebView) |
| Frontend | React 19 + Vite + TypeScript |
| Voice AI | OpenAI Realtime API (`gpt-realtime`) |
| Vision AI | OpenAI GPT-4o Vision |
| Computer Use | OpenAI GPT-5.4 (Responses API) |
| Agent SDK | `@openai/agents/realtime` |
| Character Animation | Rive (`@rive-app/react-canvas`) |
| Speech Transcription | gpt-4o-transcribe, gpt-4o-mini-transcribe |
| Wake Word | Web Audio API + gpt-4o-mini-transcribe (continuous) |
| Screen Capture | Peekaboo + macOS screencapture |
| System Audio | ScreenCaptureKit (Swift helper) |
| Window Transparency | Cocoa NSWindow APIs via `macos-private-api` |
| Styling | Tailwind CSS + custom animations |

## Planned Features

- **Persistent memory** — Samuel remembers your preferences, reading progress, and past conversations across sessions
- **Proactive awareness** — idle observations, app switch detection, and context-aware suggestions
- **Custom character design** — design your own Samuel with AI-generated SVG assets imported into Rive
- **Local wake word model** — replace Whisper API with on-device detection for instant, offline, zero-cost activation
- **Mobile companion** — iOS/Android app with the same voice agent
- **Flashcard generation** — automatically create Anki-compatible cards from vocabulary and grammar points found during learning sessions

## Limitations

- **macOS only** — relies on Apple Books and Peekaboo for screen capture/automation
- **DRM** — protected books may produce black screenshots
- **API costs** — each page read costs a Vision API call; chapter reads cost one per page; CUA navigation makes multiple calls per task; wake word uses gpt-4o-mini-transcribe (~$0.006/min while listening); learning mode screen checks ~$0.01-0.03 per scan (every 90s when active)
- **GPT-5.4 access** — Computer Use requires API access to GPT-5.4 (launched March 2026)
- **Copyright** — the Vision API may refuse to transcribe copyrighted text; accessibility-framed prompts help but are not guaranteed

## License

MIT
