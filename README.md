# Samuel — AI Book Reading Assistant

A voice-powered AI reading assistant for macOS. Open a book in Apple Books, launch the app, and say **"Hey Samuel"** — your personal reading butler wakes up, reads pages, navigates chapters, searches for keywords, summarizes entire chapters, and speaks it all aloud in real time.

Built as a Tauri desktop app with OpenAI's Realtime API for voice, GPT-5.4 Computer Use for visual navigation, GPT-4o Vision for reading, and Whisper-powered wake word detection.

## Demo

https://github.com/user-attachments/assets/60363bb7-9371-4580-802f-e3681aadce1c

## How It Works

```
You speak → Realtime API (gpt-realtime) → Samuel picks tools → Action executes → Samuel responds with voice
```

Samuel is a voice agent powered by OpenAI's Agents SDK (`@openai/agents/realtime`). He listens through your microphone and responds with natural speech in real time. When you ask him to do something with your book, he picks the right tool:

| Request | Tool | How |
|---|---|---|
| "Read this page" | `read_page` | GPT-4o Vision captures + transcribes the page (~3s) |
| "Summarize chapter 9" | `read_chapter` | Loops Vision API reads + page turns until next chapter heading |
| "Go to chapter 6" | `interact_with_book` | GPT-5.4 Computer Use sees the screen and navigates visually |
| "Turn the page" | `next_page` | Instant hotkey via Peekaboo |
| "Search for 'marketing'" | `interact_with_book` | GPT-5.4 drives Apple Books search UI |

## Features

### "Hey Samuel" Wake Word
- Hands-free activation — just say "Hey Samuel" and the assistant connects
- Uses Web Audio API + OpenAI Whisper for continuous speech detection
- Plays a chime on activation and a soft tone when going idle
- Automatically returns to listening mode after inactivity

### Voice Conversation
- Real-time speech-to-speech via OpenAI Realtime API
- Natural voice (configurable — default "ash")
- Server-side VAD with echo cancellation and noise reduction
- Samuel speaks with a polished British butler persona

### Smart Reading
- **Single page**: GPT-4o Vision captures and transcribes the current page
- **Full chapter**: Automatically reads every page, turning them one by one, and stops when it detects the next chapter heading
- **Partial reading**: "Read the first sentence" — reads the page, speaks only the requested portion
- **Follow-up questions**: Answers from memory without re-reading

### Visual Navigation (GPT-5.4 Computer Use)
- Sees the actual screen and clicks, types, scrolls through Apple Books
- Navigate to any chapter by visually finding it
- Open table of contents, search for text, interact with any UI element
- Autonomous multi-step navigation without brittle hotkey sequences

### UI
- Live transcript with user and assistant messages
- Visual state indicators: listening (waveform), thinking (bouncing dots), speaking
- Auto-scrolling conversation view
- Connect/disconnect and mute controls

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
cd reading-ai-agent
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

The Tauri app needs Screen Recording access to capture Apple Books pages. Go to:

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

## Architecture

```
src/                          React frontend (Vite + TypeScript)
├── App.tsx                   Main app layout + wake word flow
├── hooks/
│   ├── useRealtime.ts        Realtime API connection, audio I/O, transcript
│   └── useWakeWord.ts        "Hey Samuel" detection (MediaRecorder + Whisper)
├── lib/
│   ├── samuel.ts             Agent definition: persona, tools, instructions
│   └── sounds.ts             Sound cues (chime on wake, tone on idle)
├── components/
│   ├── Transcript.tsx        Chat bubbles + state indicators
│   ├── Controls.tsx          Connect/disconnect/mute buttons
│   └── StatusBar.tsx         Connection + agent state display
└── styles/app.css            Animations (thinking dots, waveform bars)

src-tauri/                    Rust backend (Tauri v2)
└── src/
    ├── lib.rs                Tauri command registration
    ├── commands.rs           All backend logic:
    │                         - Peekaboo wrappers (capture, hotkeys, click)
    │                         - GPT-4o Vision API (analyze_page)
    │                         - GPT-5.4 Computer Use loop (computer_use_task)
    │                         - Ephemeral key minting for Realtime API
    │                         - Apple Books activation and window management
    └── wake_word.rs          Whisper API transcription for wake word detection
```

### Tool Architecture

| Tool | Backend | Model | Speed | Best for |
|---|---|---|---|---|
| `read_page` | Vision API (`gpt-4o`) | Single API call | ~3s | Reading one page |
| `read_chapter` | Vision API loop | Multiple API calls | ~3s/page | Reading full chapters |
| `interact_with_book` | Responses API (`gpt-5.4`) | CUA loop | ~5-10s/turn | Navigation, search, complex UI |
| `next_page` / `prev_page` | Peekaboo hotkey | None | Instant | Simple page turns |

### Why Two Models?

- **GPT-4o Vision** (`read_page`, `read_chapter`): Fast text extraction with high output token limits. One API call per page. Ideal for reading.
- **GPT-5.4 Computer Use** (`interact_with_book`): Sees the screen and performs UI actions (click, type, scroll). Ideal for navigation but slower per turn and has lower output limits.

## Planned Features

- **Animated character**: Rive-based Samuel avatar with facial expressions mapped to agent states (idle, listening, thinking, speaking)
- **Local wake word model**: Replace Whisper API with on-device wake word detection (e.g. DaVoice ONNX) for instant, offline, zero-cost activation

## Limitations

- **macOS only** — relies on Apple Books and Peekaboo
- **DRM** — protected books may produce black screenshots
- **API costs** — each page read makes a Vision API call; chapter reads make one per page; CUA navigation makes multiple calls per task; wake word uses Whisper API (~$0.006/min while listening)
- **GPT-5.4 access** — Computer Use requires API access to GPT-5.4 (launched March 2026)

## License

MIT
