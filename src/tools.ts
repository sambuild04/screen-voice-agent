import { readFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  capturePage,
  captureScreen,
  turnPage,
  turnPageBack,
  scrollDown,
  searchBook,
  turnPages,
} from "./peekaboo.js";
import type { VisionConfig } from "./vision.js";

import type { BookWindow } from "./peekaboo.js";

export interface ToolState {
  imagePath: string;
  window?: BookWindow | null;
  visionConfig?: VisionConfig;
}

export interface ToolResult {
  tool: string;
  output: string;
  /** Base64-encoded image from read() — injected into conversation as a vision message. */
  imageBase64?: string;
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: { type: "object"; properties?: Record<string, unknown>; required?: string[] };
  };
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

const TOOL_DEFS: OpenAITool[] = [
  {
    type: "function",
    function: {
      name: "read",
      description:
        "Capture the current Apple Books page as a screenshot. Returns the page image so you can read it. Use for any read request (sentence, paragraph, page, etc.).",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["current", "next", "previous"],
            description: "Which page: current (default), next (turn first), or previous (turn back first).",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "next_page",
      description: "Flip one page forward in Apple Books.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "prev_page",
      description: "Flip one page backward in Apple Books.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "scroll_down",
      description: "Scroll down in scroll-mode books (e.g. PDFs).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "go_to_chapter",
      description:
        "Navigate to a chapter by turning pages and reading each one until the chapter heading is found. " +
        "Works with any chapter format (Chapter 4, CHAPTER FOUR, etc.). Example: go_to_chapter({chapter: 4}).",
      parameters: {
        type: "object",
        properties: {
          chapter: {
            type: "number",
            description: "The chapter number to navigate to.",
          },
        },
        required: ["chapter"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_book",
      description:
        "Search for text in the book using Apple Books search (Cmd+F). " +
        "Use for keywords or section titles.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The text to search for.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_pages",
      description:
        "Read multiple pages sequentially using OCR. Returns combined text from all pages. " +
        "Automatically stops when it detects the next chapter/section heading. " +
        "Use for reading a full chapter or section. Faster and cheaper than calling read() repeatedly.",
      parameters: {
        type: "object",
        properties: {
          count: {
            type: "number",
            description: "Max pages to read (default: 20, max: 50). Stops early at next chapter.",
          },
          stop_at: {
            type: "string",
            description: "Stop when this text is found on a page (e.g. 'Chapter 5'). That page's text is excluded from the result.",
          },
        },
        required: [],
      },
    },
  },
];

export function getOpenAITools(): OpenAITool[] {
  return TOOL_DEFS;
}

export function getAnthropicTools(): AnthropicTool[] {
  return TOOL_DEFS.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

/**
 * Execute a tool. For read(), captures a screenshot and returns the base64 image.
 * The LLM sees the image directly — no separate OCR step.
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  state: ToolState,
  delayMs: number,
  onStatus?: (msg: string) => void,
): Promise<ToolResult> {
  switch (name) {
    case "read": {
      const scope = (args.scope as string) || "current";

      if (scope === "next") {
        turnPage();
        await sleep(delayMs);
      } else if (scope === "previous") {
        turnPageBack();
        await sleep(delayMs);
      }

      let captured = capturePage(state.imagePath, state.window);
      if (!captured) {
        onStatus?.("Capture failed, retrying...");
        await sleep(delayMs);
        captured = capturePage(state.imagePath, state.window);
      }
      if (!captured) {
        onStatus?.("Trying full screen capture...");
        captured = captureScreen(state.imagePath);
      }

      if (!captured || !existsSync(state.imagePath)) {
        return {
          tool: name,
          output: "Screenshot failed. Check: Peekaboo has Screen Recording permission, a book is open in Apple Books, and the window is not minimized.",
        };
      }

      const debugPath = join(homedir(), "Downloads", "books-reader-debug.png");
      copyFileSync(state.imagePath, debugPath);

      const imageBuffer = readFileSync(state.imagePath);
      const imageBase64 = imageBuffer.toString("base64");
      onStatus?.("Reading the page...");

      return {
        tool: name,
        output: "Here is the current page screenshot. Read the text from this image and respond to the user's request.",
        imageBase64,
      };
    }
    case "next_page": {
      turnPage();
      return { tool: name, output: "Turned to next page." };
    }
    case "prev_page": {
      turnPageBack();
      return { tool: name, output: "Turned to previous page." };
    }
    case "scroll_down": {
      scrollDown();
      return { tool: name, output: "Scrolled down." };
    }
    case "go_to_chapter": {
      const chapter = Math.max(1, Math.floor(Number(args.chapter) || 1));
      if (!state.visionConfig) {
        return { tool: name, output: "Error: vision config not available." };
      }
      const result = await navigateToChapter(chapter, state, delayMs, onStatus);
      return { tool: name, output: result };
    }
    case "search_book": {
      const query = (args.query as string) || "";
      if (!query) return { tool: name, output: "Error: query is required." };

      // Try chapter format variations: "Chapter 4" → also try "Chapter Four", "CHAPTER FOUR", etc.
      const variations = buildSearchVariations(query);
      const tried: string[] = [];
      for (const q of variations) {
        onStatus?.(`Searching for "${q}"...`);
        searchBook(q);
        tried.push(q);
        await sleep(delayMs);
        // Only try the first variation for now — Apple Books search is case-insensitive
        break;
      }
      return { tool: name, output: `Searched for "${tried.join('" then "')}" and navigated to the first match.` };
    }
    
    case "read_pages": {
      const count = Math.min(Math.max(Number(args.count) || 20, 1), 50);
      const stopAt = (args.stop_at as string) || "";
      if (!state.visionConfig) {
        return { tool: name, output: "Error: vision config not available for OCR." };
      }
      const pages: string[] = [];
      let stoppedReason = "";
      for (let i = 0; i < count; i++) {
        const captured = capturePage(state.imagePath, state.window);
        if (!captured) {
          onStatus?.(`Page ${i + 1}: capture failed`);
          break;
        }
        onStatus?.(`Reading page ${i + 1} of ${count}...`);

        // Single vision call: extract text AND detect chapter boundary
        const chapterHint = i > 0
          ? (stopAt
            ? `\nAlso: does this page show the start of a new chapter or section, specifically "${stopAt}"?`
            : `\nAlso: does this page show the START of a new chapter (a large heading like "CHAPTER FIVE")?`)
          : "";
        const prompt = `Read all text on this book page. Return it preserving paragraph structure.${chapterHint}${i > 0 ? "\n\nRespond in this exact format:\nNEW_CHAPTER: YES or NO\nTEXT:\n<the full page text>" : ""}`;

        const raw = await askVision(state.imagePath, state.visionConfig!, prompt, 4096);
        if (!raw || raw === "unknown") {
          onStatus?.(`Page ${i + 1}: no response`);
          break;
        }

        // On page 1 the response is just the text; on later pages parse the structured format
        let text: string;
        if (i > 0) {
          const isNewChapter = /NEW_CHAPTER:\s*YES/i.test(raw);
          if (isNewChapter) {
            stoppedReason = `Stopped: new chapter detected on page ${i + 1}.`;
            onStatus?.(stoppedReason);
            turnPageBack();
            break;
          }
          const textMatch = raw.match(/TEXT:\s*\n?([\s\S]*)/i);
          text = textMatch ? textMatch[1].trim() : raw.replace(/NEW_CHAPTER:\s*NO\s*/i, "").trim();
        } else {
          text = raw.trim();
        }

        if (!text) {
          onStatus?.(`Page ${i + 1}: empty`);
          break;
        }

        pages.push(`--- Page ${i + 1} ---\n${text}`);
        if (i < count - 1) {
          turnPage();
          await sleep(delayMs);
        }
      }
      if (pages.length === 0) {
        return { tool: name, output: "Could not read any pages. Check that a book is open." };
      }
      const suffix = stoppedReason ? `\n\n[${stoppedReason}]` : `\n\n[Read ${pages.length} pages.]`;
      return { tool: name, output: pages.join("\n\n") + suffix };
    }
    default:
      return { tool: name, output: `Unknown tool: ${name}` };
  }
}

/**
 * Navigate to a chapter by turning pages and asking the vision model on each one.
 * 1. Ask the model what chapter the current page belongs to
 * 2. Decide direction (forward or backward)
 * 3. Turn pages one by one, asking the model if each page is the target chapter start
 */
async function navigateToChapter(
  target: number,
  state: ToolState,
  delayMs: number,
  onStatus?: (msg: string) => void,
): Promise<string> {
  const MAX_PAGES = 150;
  onStatus?.(`Looking for Chapter ${target}...`);

  // First, check if we're already on the target chapter
  let captured = capturePage(state.imagePath, state.window);
  if (!captured) return "Could not capture page. Check that a book is open.";

  const currentCheck = await askVision(
    state.imagePath,
    state.visionConfig!,
    `Look at this book page. What chapter number is shown or being discussed? Reply with JUST the number (e.g. "4" or "7"). If you can't tell, reply "unknown".`,
  );
  const currentChapter = parseInt(currentCheck.trim(), 10);

  if (await isChapterStart(state, target)) {
    return `Already on chapter ${target}.`;
  }

  const direction = !isNaN(currentChapter) && currentChapter > target ? "back" : "forward";
  const dirLabel = direction === "back" ? "backward" : "forward";
  onStatus?.(`Currently at Chapter ${isNaN(currentChapter) ? "?" : currentChapter}, turning ${dirLabel}...`);

  for (let i = 1; i <= MAX_PAGES; i++) {
    if (direction === "back") {
      turnPageBack();
    } else {
      turnPage();
    }
    await sleep(Math.max(delayMs, 400));

    captured = capturePage(state.imagePath, state.window);
    if (!captured) continue;

    onStatus?.(`Turning ${dirLabel}... (${i} pages)`);

    if (await isChapterStart(state, target)) {
      onStatus?.(`Found Chapter ${target}!`);
      return `Navigated to chapter ${target} (turned ${i} pages ${direction}).`;
    }
  }
  return `Could not find chapter ${target} after ${MAX_PAGES} pages.`;
}

/** Ask the vision model a question about the current page screenshot. */
async function askVision(
  imagePath: string,
  config: VisionConfig,
  question: string,
  maxTokens = 20,
): Promise<string> {
  const imageBuffer = readFileSync(imagePath);
  const base64 = imageBuffer.toString("base64");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model ?? "gpt-4o-mini",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: question },
          { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
        ],
      }],
      max_tokens: maxTokens,
    }),
  });

  if (!response.ok) return "unknown";
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() ?? "unknown";
}

/** Ask the vision model: "Is this the first page of chapter N?" */
async function isChapterStart(state: ToolState, chapter: number): Promise<boolean> {
  const answer = await askVision(
    state.imagePath,
    state.visionConfig!,
    `Is this the FIRST page of Chapter ${chapter}? Look for a chapter heading like "Chapter ${chapter}" or "CHAPTER ${NUMBER_WORDS[chapter] ?? chapter}". Answer only YES or NO.`,
  );
  return answer.toUpperCase().startsWith("YES");
}


const NUMBER_WORDS: Record<number, string> = {
  1: "One", 2: "Two", 3: "Three", 4: "Four", 5: "Five",
  6: "Six", 7: "Seven", 8: "Eight", 9: "Nine", 10: "Ten",
  11: "Eleven", 12: "Twelve", 13: "Thirteen", 14: "Fourteen", 15: "Fifteen",
  16: "Sixteen", 17: "Seventeen", 18: "Eighteen", 19: "Nineteen", 20: "Twenty",
};

const WORD_TO_NUMBER: Record<string, number> = {};
for (const [n, w] of Object.entries(NUMBER_WORDS)) {
  WORD_TO_NUMBER[w.toLowerCase()] = Number(n);
}

/**
 * Build search variations for chapter queries so "chapter 4" also tries
 * "chapter four" (and vice versa). Apple Books search is case-insensitive,
 * so we only need to handle number ↔ word conversion.
 */
function buildSearchVariations(query: string): string[] {
  const variations: string[] = [];
  const chapterMatch = query.match(/^(chapter|part)\s+(.+)$/i);
  if (!chapterMatch) return [query];

  const prefix = chapterMatch[1];
  const suffix = chapterMatch[2].trim();

  const num = parseInt(suffix, 10);
  if (!isNaN(num) && NUMBER_WORDS[num]) {
    // Prefer word form first (many books use "CHAPTER FOUR" not "CHAPTER 4")
    variations.push(`${prefix} ${NUMBER_WORDS[num]}`);
    variations.push(query);
  } else {
    variations.push(query);
    // Word → number fallback
    const wordNum = WORD_TO_NUMBER[suffix.toLowerCase()];
    if (wordNum !== undefined) {
      variations.push(`${prefix} ${wordNum}`);
    }
  }

  return variations;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
