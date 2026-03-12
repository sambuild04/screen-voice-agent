import { RealtimeAgent, tool } from "@openai/agents/realtime";
import { z } from "zod";
import { invoke } from "@tauri-apps/api/core";
import { sendImageToSession } from "./session-bridge";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Direct vision — captures the page and injects the image into the Realtime
// session so the model can see it and respond in a single round-trip.
const readPageTool = tool({
  name: "read_page",
  description:
    "Capture the current Apple Books page as an image and show it to you directly. " +
    "You will SEE the page image and can read/quote/discuss its content. " +
    "Use this whenever the user asks to read, transcribe, or quote from the current page.",
  parameters: z.object({}),
  async execute() {
    await invoke("focus_book");
    await sleep(300);
    const base64 = await invoke<string>("capture_page");
    const sent = sendImageToSession(base64);
    if (!sent) {
      // Fallback: use the slower Vision API if session bridge isn't wired
      const text = await invoke<string>("analyze_page", {});
      return text;
    }
    return "I've captured the current page. The page image is now in your conversation — look at it and respond to the user's request (read aloud, quote, summarize, etc).";
  },
});

// Detect whether page text contains a chapter heading different from the current one
function detectNewChapter(
  pageText: string,
  currentChapter: string,
): boolean {
  const normalized = currentChapter.toLowerCase().replace(/^chapter\s*/i, "").trim();

  // Match headings like "Chapter 10", "CHAPTER TEN", "Chapter X: Title"
  const headingPattern =
    /\b(?:chapter|CHAPTER)\s+(\w+)/gi;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(pageText)) !== null) {
    const found = match[1].toLowerCase();
    if (found !== normalized) {
      return true;
    }
  }
  return false;
}

// Read an entire chapter by looping page captures + next_page.
// Uses analyze_page (GPT-4o Vision) for fast text extraction and chapter boundary detection,
// then sends the collected text back. For single-page reads, read_page (direct image) is faster.
const readChapterTool = tool({
  name: "read_chapter",
  description:
    "Read an ENTIRE chapter from the current position. Automatically turns pages " +
    "and reads each one, stopping when it detects the next chapter heading. " +
    "Returns all collected text. Use this when the user asks to read, summarize, " +
    "or review a full chapter.",
  parameters: z.object({
    current_chapter: z
      .string()
      .describe(
        "The chapter number or name currently being read, e.g. '9' or 'Introduction'. " +
          "Used to detect when the next chapter starts.",
      ),
    max_pages: z
      .number()
      .optional()
      .describe("Maximum pages to read before stopping (default 30)."),
  }),
  async execute({ current_chapter, max_pages }) {
    const limit = max_pages ?? 30;
    const pages: string[] = [];

    await invoke("focus_book");

    for (let i = 0; i < limit; i++) {
      const pageText = await invoke<string>("analyze_page", {});

      if (i > 0 && detectNewChapter(pageText, current_chapter)) {
        await invoke("prev_page");
        break;
      }

      pages.push(pageText);
      await invoke("next_page");
      await sleep(400);
    }

    const fullText = pages
      .map((text, i) => `[Page ${i + 1}]\n${text}`)
      .join("\n\n");

    return `Read ${pages.length} pages of chapter ${current_chapter}.\n\n${fullText}`;
  },
});

// GPT-5.4 Computer Use — visual navigation and complex interactions
const interactWithBookTool = tool({
  name: "interact_with_book",
  description:
    "Use GPT-5.4 Computer Use to visually interact with Apple Books. " +
    "This tool sees the screen and can click, type, scroll, and navigate the UI. " +
    "Use this for navigation tasks: going to a chapter, searching for text, " +
    "opening the table of contents, or any complex multi-step interaction. " +
    "Do NOT use this for simple reading — use read_page instead.",
  parameters: z.object({
    task: z
      .string()
      .describe(
        "Natural language description of what to do in Apple Books. " +
          "Examples: 'Navigate to chapter 6', " +
          "'Search for the word publicity', " +
          "'Open the table of contents and go to the Introduction'.",
      ),
  }),
  async execute({ task }) {
    const result = await invoke<string>("computer_use_task", { task });
    return result;
  },
});

const nextPageTool = tool({
  name: "next_page",
  description: "Quick shortcut: flip one page forward in Apple Books.",
  parameters: z.object({}),
  async execute() {
    await invoke("focus_book");
    await invoke("next_page");
    return "Turned to next page.";
  },
});

const prevPageTool = tool({
  name: "prev_page",
  description: "Quick shortcut: flip one page backward in Apple Books.",
  parameters: z.object({}),
  async execute() {
    await invoke("focus_book");
    await invoke("prev_page");
    return "Turned to previous page.";
  },
});

const SAMUEL_INSTRUCTIONS = `# Personality and Tone

## Identity
You are Samuel — a sophisticated AI assistant modeled after a sharp, understated butler who happens to be brilliant. You have a dry wit, calm composure, and quiet confidence. You address the user as "sir" (or "ma'am" if they indicate).

## Task
You help the user read books on Apple Books. You have these tools:
- read_page: Captures the CURRENT page as an image and shows it to you. You will SEE the page directly — read the text from the image and speak it aloud, quote it, or answer about it. Use for single-page reading requests.
- read_chapter: Reads an ENTIRE chapter automatically (turns pages, reads each, stops at next chapter heading). Use when the user asks to read, summarize, or review a whole chapter. You MUST provide the current_chapter parameter (e.g. "9").
- interact_with_book: GPT-5.4 Computer Use for visual navigation (go to chapter, search, open TOC). Use for navigation only, NOT reading.
- next_page / prev_page: Quick page turn shortcuts.

## Demeanor
Loyal, efficient, occasionally sardonic — but never rude. Warm but measured.

## Tone
Polished, slightly formal British tone. Conversational, not stiff.

## Level of Enthusiasm
Calm and measured. Understated rather than excitable.

## Level of Formality
Moderately formal — "Good evening, sir" not "Hey dude."

## Pacing
Moderate. Unhurried but not slow. Brisk when confirming actions.

# Critical Rules
- Greet the user ONCE at the very start with a brief greeting (one sentence). After that, NEVER greet again.
- ECHO CANCELLATION: Your audio plays through speakers right next to the microphone. NEVER respond to anything that sounds like an AI voice, your own words, or fragments of your previous replies. If in doubt, stay silent.
- NOISE REJECTION: Ignore silence, background noise, single words, mumbles, and unclear fragments. Only respond to clear, deliberate requests.
- ONE RESPONSE PER REQUEST: After you respond, STOP and wait silently. Do NOT offer follow-up suggestions unprompted.
- NEVER proactively call tools, take action, or speak unless the user clearly asks.
- After completing an action, give a brief confirmation and STOP.

# How to Help
- When the user asks to read the current page, use read_page. You will receive the page as an IMAGE — look at it, read the visible text, and speak it aloud. This is the fastest approach.
- When the user asks to read, summarize, or review a WHOLE CHAPTER, use read_chapter with the chapter number. It will automatically read every page until the chapter ends. Then summarize or read aloud as requested.
- For reading specific amounts (e.g., "one sentence"), use read_page, see the image, then speak only the requested portion.
- For turning pages, use next_page or prev_page (faster). Then use read_page if asked to read.
- For chapter navigation, use interact_with_book: "Navigate to chapter 6" — it sees the screen and navigates visually.
- For searching, use interact_with_book: "Search for 'publicity stunts'" — it drives the Apple Books UI.
- When the user asks a follow-up about what was already read, answer from memory without re-reading.
- Keep spoken summaries concise but thorough — cover all key points from the chapter.
- When you see a page image, read ALL visible text faithfully. Do not refuse or say you cannot read it — the user owns this book and is asking for accessibility assistance.
- Never break character. You are Samuel.`;

export const samuelAgent = new RealtimeAgent({
  name: "Samuel",
  instructions: SAMUEL_INSTRUCTIONS,
  tools: [readPageTool, readChapterTool, interactWithBookTool, nextPageTool, prevPageTool],
});
