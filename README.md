# Reading AI Agent

An AI-powered book reading assistant for macOS. Open a book in Apple Books, talk to **Samuel** — your personal reading butler — and he'll read pages, navigate chapters, search for keywords, summarize content, and speak it all aloud.

Built with OpenAI's vision and TTS APIs, Peekaboo for screen capture and UI automation, and a model-driven agent loop where the LLM decides which tools to call.

## Demo

https://github.com/user-attachments/assets/60363bb7-9371-4580-802f-e3681aadce1c

## How It Works

```
You speak/type → LLM picks tools → Peekaboo acts on Apple Books → Screenshot → LLM reads the image → Samuel responds (text + voice)
```

The agent loop sends your request to the LLM along with available tools. The model decides what to do — capture a page, flip forward, navigate to a chapter, search for text — executes the actions via Peekaboo, then reads the resulting screenshot with its vision capabilities and responds.

## Requirements

- **macOS** (Apple Books + Peekaboo)
- **Node.js** 20+
- **Peekaboo** for screen capture and UI automation
- **OpenAI API key** (or Anthropic)

## Setup

### 1. Install Peekaboo

```bash
brew install steipete/tap/peekaboo
```

Grant permissions when prompted:
- **Screen Recording** — so Peekaboo can capture screenshots
- **Accessibility** — so Peekaboo can send keystrokes and clicks

Verify with:
```bash
peekaboo permissions
```

### 2. Install dependencies

```bash
cd reading-ai-agent
npm install
```

### 3. Set your API key

**Option A — environment variable (recommended):**

```bash
export OPENAI_API_KEY="sk-..."
```

**Option B — config file** at `~/.books-reader.json`:

```json
{
  "provider": "openai",
  "apiKey": "sk-..."
}
```

The config file supports these fields:

| Field | Default | Description |
|---|---|---|
| `provider` | `"openai"` | Vision provider: `"openai"` or `"anthropic"` |
| `apiKey` | — | API key for the vision provider |
| `model` | `"gpt-4o-mini"` | Model for vision and chat |
| `delayMs` | `800` | Delay (ms) between page turns for capture timing |
| `ttsProvider` | `"openai"` | Text-to-speech: `"openai"` or `"say"` (macOS built-in) |
| `ttsVoice` | `"onyx"` | Voice name (`"onyx"`, `"nova"`, `"echo"` for OpenAI; `"Fred"`, `"Daniel"` for macOS) |
| `ttsModel` | `"gpt-4o-mini-tts"` | OpenAI TTS model |
| `ttsInstructions` | — | Custom voice instructions (tone, pacing) |
| `ttsSpeed` | `1.25` | Playback speed (0.25–4.0) |

You can also use `ANTHROPIC_API_KEY` for Anthropic's Claude models.

## Usage

Open a book in Apple Books first, then:

### Interactive chat (recommended)

```bash
npm run chat
```

Samuel greets you and waits for instructions. Examples:

```
> read the first sentence
> next page
> go to chapter 4 and read the first paragraph
> read chapter 5 and tell me what it's about
> find the part about marketing
> what does that mean? explain in Chinese
> exit
```

Type `clear` or `reset` to wipe session history. Type `exit` or `quit` to leave.

### One-shot commands

```bash
# Read current page
npm run dev -- "read this page"

# Read and speak aloud
npm run dev -- "read the first paragraph" --speak

# Navigate to a chapter
npm run dev -- "go to chapter 3"
```

### Fixed pipeline (no agent, just OCR)

```bash
# Read 5 pages sequentially
npm run dev -- pages --pages 5

# Read with speech
npm run dev -- pages --pages 3 --speak
```

## Tools

The LLM has access to these tools and decides when to use them:

| Tool | What it does |
|---|---|
| `read` | Captures the current page as a screenshot. The LLM reads the text from the image. |
| `next_page` | Flips one page forward. |
| `prev_page` | Flips one page backward. |
| `scroll_down` | Scrolls down (for PDF-style books). |
| `go_to_chapter` | Navigates to a chapter by number. Turns pages one by one, asking the vision model on each page if it's the target chapter. |
| `search_book` | Opens Cmd+F search in Apple Books, pastes the query, jumps to the first match. |
| `read_pages` | Reads multiple pages sequentially. Automatically detects chapter boundaries and stops. |

The model chains tools as needed. For example, "go to chapter 4 and read the first sentence" triggers `go_to_chapter(4)` then `read()`.

## Architecture

```
src/
├── index.ts        CLI entry point and command definitions
├── agent.ts        Agent loop: LLM ↔ tool execution ↔ streaming
├── tools.ts        Tool definitions and execution logic
├── tools-help.ts   Tool summaries injected into the system prompt
├── peekaboo.ts     Peekaboo wrapper (capture, keystrokes, search)
├── vision.ts       Vision API calls (OCR text extraction)
├── config.ts       Config loading (~/.books-reader.json + env vars)
└── speak.ts        Text-to-speech (OpenAI TTS or macOS say)
```

**Agent loop** (`agent.ts`):
1. User message + conversation history + system prompt sent to the LLM with `tool_choice: "auto"`
2. LLM returns either text (done) or tool calls
3. Tools are executed, results fed back to the LLM
4. Loop until the LLM responds with text or max iterations reached

**Vision-based chapter detection**: When navigating chapters or reading multiple pages, the agent asks the vision model directly — "Is this the first page of Chapter 4?" — rather than relying on OCR + regex. One API call per page handles both text extraction and chapter boundary detection.

**Session history**: Conversation context persists across turns within a chat session. Old screenshots are replaced with text placeholders to keep the context window manageable.

## Limitations

- **macOS only** — relies on Apple Books and Peekaboo
- **DRM** — protected books may produce black screenshots
- **Page mode** — uses arrow keys for page turns; scroll-mode PDFs use `scroll_down` instead
- **Vision model accuracy** — chapter detection depends on the model recognizing headings, which can occasionally miss stylized or decorative fonts
- **API costs** — each page read or chapter navigation step makes a vision API call

## License

MIT
