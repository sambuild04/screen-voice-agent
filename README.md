# Samuel — Your AI Desktop Companion for Reading & Language Learning

An always-on-top, transparent desktop AI assistant for macOS — like QQ Pet meets JARVIS. Samuel floats on your screen as an animated character with manga-style speech bubbles, reads your Apple Books aloud, helps you learn Japanese/Chinese/Korean from any app, and responds to voice commands hands-free.

Built with Tauri v2, OpenAI Realtime API, GPT-5.4 Computer Use, GPT-4o Vision, Rive character animation, and Whisper-powered wake word detection.

**Keywords**: AI reading assistant, macOS AI desktop companion, voice-controlled book reader, Apple Books AI, language learning AI, Japanese learning tool, real-time translation, GPT-5.4 computer use, OpenAI Realtime API voice agent, Tauri desktop app, QQ Pet style AI, transparent desktop widget, Rive animation

## Demo

https://github.com/user-attachments/assets/60363bb7-9371-4580-802f-e3681aadce1c

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

### UI & Experience
- **Frosted-glass speech bubbles** with backdrop blur — translucent, modern aesthetic
- **Screen target badge** — shows which app/display was captured after each screen tool use
- **State indicators**: listening waveform, thinking animation, speaking glow
- **Mic mute and disconnect controls** in the draggable header bar

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

## Architecture

```
src/                          React frontend (Vite + TypeScript)
├── App.tsx                   Main app layout + wake word flow + idle detection
├── hooks/
│   ├── useRealtime.ts        Realtime API connection, audio I/O, transcript, echo guard
│   └── useWakeWord.ts        "Hey Samuel" detection (MediaRecorder + Whisper)
├── lib/
│   ├── samuel.ts             Agent definition: persona, tools, instructions
│   ├── session-bridge.ts     Image injection + screen target notification bridge
│   └── sounds.ts             Sound cues (chime on wake, tone on idle)
├── components/
│   ├── Character.tsx          Rive character animation + manga speech bubbles
│   ├── ScreenPicker.tsx       Multi-monitor display selector dropdown
│   ├── StatusBar.tsx          Connection + agent state display
│   ├── Transcript.tsx         Chat transcript view
│   └── Controls.tsx           Connect/disconnect/mute buttons
└── styles/app.css             Transparent window, speech bubbles, animations

src-tauri/                    Rust backend (Tauri v2)
└── src/
    ├── lib.rs                Tauri command registration + macOS transparency setup
    ├── commands.rs           All backend logic:
    │                         - Peekaboo wrappers (capture, hotkeys, click)
    │                         - GPT-4o Vision API (analyze_page)
    │                         - GPT-5.4 Computer Use loop (computer_use_task)
    │                         - Multi-monitor display detection + capture
    │                         - Ephemeral key minting for Realtime API
    │                         - Apple Books activation and window management
    └── wake_word.rs          Whisper API transcription for wake word detection
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
| Wake Word | Web Audio API + OpenAI Whisper |
| Screen Capture | Peekaboo + macOS screencapture |
| Window Transparency | Cocoa NSWindow APIs via `macos-private-api` |
| Styling | Tailwind CSS + custom animations |

## Planned Features

- **Custom character design** — design your own Samuel with AI-generated SVG assets imported into Rive
- **Local wake word model** — replace Whisper API with on-device detection (e.g. DaVoice ONNX) for instant, offline, zero-cost activation
- **Mobile companion** — iOS/Android app with the same voice agent
- **More language tools** — flashcard generation, spaced repetition, vocabulary tracking

## Limitations

- **macOS only** — relies on Apple Books and Peekaboo for screen capture/automation
- **DRM** — protected books may produce black screenshots
- **API costs** — each page read costs a Vision API call; chapter reads cost one per page; CUA navigation makes multiple calls per task; wake word uses Whisper (~$0.006/min while listening)
- **GPT-5.4 access** — Computer Use requires API access to GPT-5.4 (launched March 2026)
- **Copyright** — the Vision API may refuse to transcribe copyrighted text; accessibility-framed prompts help but are not guaranteed

## License

MIT
