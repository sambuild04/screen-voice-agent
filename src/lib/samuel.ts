import { RealtimeAgent, tool } from "@openai/agents/realtime";
import { z } from "zod";
import { invoke } from "@tauri-apps/api/core";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const readTool = tool({
  name: "read",
  description:
    "Extract the text from the current Apple Books page. Returns the page text for you to read aloud.",
  parameters: z.object({
    scope: z
      .enum(["current", "next", "previous"])
      .optional()
      .describe(
        "Which page: current (default), next (turn first), or previous (turn back first).",
      ),
  }),
  async execute({ scope }) {
    const s = scope ?? "current";
    await invoke("focus_book");
    await sleep(300);

    if (s === "next") {
      await invoke("next_page");
      await sleep(600);
    } else if (s === "previous") {
      await invoke("prev_page");
      await sleep(600);
    }

    const text = await invoke<string>("analyze_page", {
      prompt:
        "You are an OCR assistant helping a visually impaired user. Transcribe every word visible in this image. Preserve paragraph breaks. Output only the transcribed text, nothing else.",
    });
    return `Page text:\n\n${text}`;
  },
});

const nextPageTool = tool({
  name: "next_page",
  description: "Flip one page forward in Apple Books.",
  parameters: z.object({}),
  async execute() {
    await invoke("focus_book");
    await sleep(300);
    await invoke("next_page");
    return "Turned to next page.";
  },
});

const prevPageTool = tool({
  name: "prev_page",
  description: "Flip one page backward in Apple Books.",
  parameters: z.object({}),
  async execute() {
    await invoke("focus_book");
    await sleep(300);
    await invoke("prev_page");
    return "Turned to previous page.";
  },
});

const scrollDownTool = tool({
  name: "scroll_down",
  description: "Scroll down in scroll-mode books (e.g. PDFs).",
  parameters: z.object({}),
  async execute() {
    await invoke("focus_book");
    await sleep(300);
    await invoke("scroll_down");
    return "Scrolled down.";
  },
});

const goToChapterTool = tool({
  name: "go_to_chapter",
  description:
    "Navigate to a chapter by number. Turns pages until the chapter heading is found.",
  parameters: z.object({
    chapter: z.number().describe("The chapter number to navigate to."),
  }),
  async execute({ chapter }) {
    await invoke("focus_book");
    await sleep(300);
    const text = await invoke<string>("analyze_page", {
      prompt: `What chapter is currently shown on this page? I need to find chapter ${chapter}. Tell me the current chapter number and any nearby chapter headings you can see.`,
    });
    return `Current page shows: ${text}\n\nTo reach chapter ${chapter}, use next_page or prev_page, then call read to check each page.`;
  },
});

const searchBookTool = tool({
  name: "search_book",
  description:
    "Search for text in the book using Apple Books search (Cmd+F).",
  parameters: z.object({
    query: z.string().describe("The text to search for."),
  }),
  async execute({ query }) {
    await invoke("focus_book");
    await sleep(300);
    await invoke("search_book", { query });
    await sleep(800);
    const text = await invoke<string>("analyze_page", {
      prompt:
        "You are an OCR assistant helping a visually impaired user. Transcribe every word visible in this image. Output only the transcribed text.",
    });
    return `Searched for "${query}". Page now shows:\n\n${text}`;
  },
});

const SAMUEL_INSTRUCTIONS = `# Personality and Tone

## Identity
You are Samuel — a sophisticated AI assistant modeled after a sharp, understated butler who happens to be brilliant. You have a dry wit, calm composure, and quiet confidence. You address the user as "sir" (or "ma'am" if they indicate).

## Task
You help the user read books on Apple Books. When you call the read tool, it extracts the text from the current book page and returns it to you. Read that text aloud to the user. You can also turn pages, navigate to chapters, and search for text.

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
- ECHO CANCELLATION: Your audio plays through speakers right next to the microphone. You WILL hear your own voice echoed back. NEVER respond to anything that sounds like an AI voice, your own words, or fragments of your previous replies. If in doubt, stay silent.
- NOISE REJECTION: Ignore silence, background noise, single words, mumbles, and unclear fragments. Only respond to clear, deliberate requests.
- ONE RESPONSE PER REQUEST: After you respond to a request, STOP and wait silently for the next clear request. Do NOT follow up with "Would you like me to..." or "Shall I..." unprompted. Just wait.
- NEVER proactively call tools, take action, or speak unless the user clearly asks.
- After completing an action (turning a page, reading, etc.), give a brief confirmation and then STOP. Do not offer follow-up suggestions.

# How to Help
- When the user asks you to read, call the read tool. It extracts the text from the current book page. Read that text aloud.
- If the user asks to read a specific amount (e.g., "one sentence", "first paragraph"), call read and then speak only the requested portion.
- For navigation (next page, previous page, turn page), just do it and say "Done, sir." — nothing more.
- When the user asks a follow-up about what was already read, answer from memory without re-reading.
- Keep responses concise — this is a voice conversation.
- For go_to_chapter, use search_book to search for "Chapter X" to jump directly, or use next_page/prev_page with read to navigate page-by-page.
- Never break character. You are Samuel.`;

export const samuelAgent = new RealtimeAgent({
  name: "Samuel",
  instructions: SAMUEL_INSTRUCTIONS,
  tools: [
    readTool,
    nextPageTool,
    prevPageTool,
    scrollDownTool,
    goToChapterTool,
    searchBookTool,
  ],
});
