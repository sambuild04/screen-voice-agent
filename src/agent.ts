import {
  getOpenAITools,
  getAnthropicTools,
  executeTool,
  type ToolState,
  type ToolResult,
} from "./tools.js";
import { focusBookReader, focusBooks, checkPeekaboo, type BookWindow } from "./peekaboo.js";
import { getConfig, getVisionConfig } from "./config.js";
import type { VisionConfig } from "./vision.js";
import { buildToolAvailabilityPrompt } from "./tools-help.js";

const TOOL_LABELS: Record<string, string> = {
  read: "Capturing page...",
  read_pages: "Reading pages...",
  next_page: "Turning page...",
  prev_page: "Going back...",
  scroll_down: "Scrolling...",
  go_to_chapter: "Navigating to chapter...",
  search_book: "Searching...",
};

function buildSystemPrompt(): string {
  const now = new Date();
  const hour = now.getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const timeStr = now.toLocaleString(undefined, {
    dateStyle: "full",
    timeStyle: "short",
  });
  return `You are Samuel — a sophisticated AI assistant with a dry wit, calm composure, and quiet confidence. You speak in a polished, slightly formal British tone. You address the user as "sir" (or "ma'am" if they indicate). You are loyal, efficient, and occasionally sardonic — but never rude. Think of a sharp, understated butler who happens to be brilliant: warm, gently amused, always one step ahead.

You help the user read books on Apple Books via screen capture and navigation tools. Use whatever tools you need to fulfill the request — the tool names and descriptions tell you what each one does. Chain multiple tools when the request requires it.

${buildToolAvailabilityPrompt()}

Current time: ${timeStr}

## Guidelines
- When the user asks you to read, you MUST call a tool to capture the page. You will receive a screenshot — read the text from the image and respond with exactly what was asked for. "1 sentence" means one sentence, "the page" means the full page. Be precise.
- When the user asks to navigate, you MUST call the appropriate tool. Text responses alone do NOT perform actions.
- For follow-up questions about what was already read, answer from conversation context without re-reading.
- Keep responses concise and elegant. Deliver text cleanly — save commentary for after.
- Never break character. You are not "an AI assistant." You are Samuel.`;
}

export type Message =
  | { role: "user"; content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; name: string; arguments: string }> }
  | { role: "tool"; tool_call_id: string; content: string | Array<unknown> };

interface AgentOptions {
  maxIterations?: number;
  /** Called with the full final text (after streaming completes). */
  onText?: (text: string) => void | Promise<void>;
  /** Called per-token as the LLM streams its response. */
  onStream?: (token: string) => void;
  /** Called with status updates for UI display (spinners, progress). */
  onStatus?: (msg: string) => void;
  onPageImage?: (base64: string) => void;
  focus?: boolean;
  pages?: number;
  waitForReady?: boolean;
  message?: string;
  warmStart?: boolean;
  /** Prior conversation history. Returned (updated) from runAgent for session continuity. */
  history?: Message[];
  /** Max user turns to keep in history (older turns are dropped). Default: 10. */
  historyLimit?: number;
}

/**
 * Run the agent loop:
 * 1. User message → LLM (with tools, tool_choice: auto)
 * 2. LLM decides which tools to call (read, next_page, go_to_chapter, etc.) or responds with text
 * 3. read() returns a screenshot image → injected back into conversation
 * 4. LLM sees the image, extracts text, responds to user
 */
export async function runAgent(options: AgentOptions = {}): Promise<Message[]> {
  const {
    maxIterations = 10,
    onText,
    onStream,
    onStatus,
    onPageImage,
    focus = true,
    pages,
    waitForReady,
    message,
    warmStart,
    history = [],
    historyLimit = 10,
  } = options;
  const config = getConfig();
  const visionConfig = getVisionConfig(config);

  if (!checkPeekaboo()) {
    throw new Error(
      "Peekaboo is not installed or lacks permissions. Install: brew install steipete/tap/peekaboo"
    );
  }

  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const tempDir = mkdtempSync(join(tmpdir(), "books-reader-agent-"));
  const imagePath = join(tempDir, "page.png");
  let focused = false;
  let bookWindow: BookWindow | null = null;

  const ensureFocused = async (): Promise<void> => {
    if (focused) return;
    if (waitForReady) {
      const readline = await import("node:readline/promises");
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      console.error("Open a book in Apple Books. Press Enter when ready.");
      await rl.question("");
      rl.close();
      console.error("Switch to the book window. Capturing in 5 seconds...");
      await new Promise((r) => setTimeout(r, 5000));
    } else if (focus) {
      onStatus?.("Finding book window...");
      bookWindow = focusBookReader();
      if (!bookWindow) {
        onStatus?.("No book window found, opening Books...");
        focusBooks();
      } else {
        onStatus?.(`Found "${bookWindow.title}"`);
      }
      const delayMs = warmStart ? 500 : config.delayMs ?? 1500;
      if (delayMs > 0) {
        onStatus?.("Preparing...");
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    focused = true;
  };

  try {
    const state: ToolState = { imagePath, window: null, visionConfig };

    const userMessage: string =
      message?.trim() ||
      (pages != null && pages >= 1
        ? `Read exactly ${pages} page${pages === 1 ? "" : "s"} starting from the current page.`
        : "Read the current page.");

    // Build messages: system prompt + compacted history + new user turn
    const compactedHistory = compactHistory(history, historyLimit);
    const messages: Message[] = [
      ...compactedHistory,
      { role: "user", content: [{ type: "text", text: userMessage }] },
    ];

    let iterations = 0;
    let didOutputText = false;

    while (iterations < maxIterations) {
      iterations++;
      if (iterations === 1 && onStatus) onStatus("Thinking...");

      const response = await chatWithTools(messages, visionConfig, onStream);

      // Model responded with text (no tool calls) — output it
      if (!response.toolCalls?.length) {
        if (response.text?.trim()) {
          didOutputText = true;
          // If we streamed, onText is still called with the full text (for TTS, history, etc.)
          if (onText) await onText(response.text.trim());
        }
        break;
      }

      // Model called tools — execute them
      const assistantMsg: Message = {
        role: "assistant",
        content: response.text || null,
        tool_calls: response.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments || "{}",
        })),
      };
      messages.push(assistantMsg);

      // Execute all tools and collect results + images
      const pendingImages: Array<{ base64: string }> = [];

      for (const tc of response.toolCalls) {
        const toolLabel = TOOL_LABELS[tc.name] ?? tc.name;
        if (onStatus) onStatus(toolLabel);

        const needsFocus = ["read", "read_pages", "next_page", "prev_page", "scroll_down", "search_book", "go_to_chapter"].includes(tc.name);
        if (needsFocus) {
          await ensureFocused();
          state.window = bookWindow;
        }
        const args = parseJson(tc.arguments || "{}");
        const result = await executeTool(tc.name, args, state, config.delayMs ?? 800, onStatus);

        // All tool results must come first (OpenAI requirement)
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result.output,
        });

        if (result.imageBase64) {
          if (onPageImage) onPageImage(result.imageBase64);
          pendingImages.push({ base64: result.imageBase64 });
        }
      }

      // Now append image messages after all tool results
      for (const img of pendingImages) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: "Here is the screenshot of the book page. Read the text from this image and respond to the user's original request." },
            { type: "image_url", image_url: { url: `data:image/png;base64,${img.base64}` } },
          ],
        });
      }

      // Loop back — LLM will see the tool results (including images) and respond
    }

    if (iterations >= maxIterations) {
      onStatus?.("Reached iteration limit");
    }
    if (!didOutputText && onText) {
      await onText("(No response from the assistant. Try again.)");
    }

    // Return compacted history for session continuity
    return compactHistory(messages, historyLimit);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Compact history: replace base64 image URLs with a text placeholder so
 * old screenshots don't bloat the context window.  Also trim to the last
 * `limit` user turns (each turn = user msg + assistant/tool exchange).
 */
function compactHistory(messages: Message[], limit: number): Message[] {
  const compacted: Message[] = messages.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;
    const hasImage = msg.content.some(
      (part) => "type" in part && part.type === "image_url",
    );
    if (!hasImage) return msg;

    // Keep text parts, replace images with a placeholder
    const newContent = msg.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .concat([{ type: "text", text: "[screenshot of book page was here]" }]);
    return { ...msg, content: newContent } as Message;
  });

  // Trim to last `limit` user turns (count user messages)
  const userIndices = compacted
    .map((m, i) => (m.role === "user" ? i : -1))
    .filter((i) => i >= 0);
  if (userIndices.length <= limit) return compacted;
  const cutoff = userIndices[userIndices.length - limit];
  return compacted.slice(cutoff);
}

// --- API layer ---

interface ChatResponse {
  text: string | null;
  toolCalls?: Array<{ id: string; name: string; arguments?: string }>;
  finishReason: string;
}

type OnStreamCallback = ((token: string) => void) | undefined;

async function chatWithTools(
  messages: Message[],
  visionConfig: VisionConfig,
  onStream?: OnStreamCallback,
): Promise<ChatResponse> {
  if (visionConfig.provider === "openai") {
    return chatOpenAI(messages, visionConfig, onStream);
  }
  if (visionConfig.provider === "anthropic") {
    return chatAnthropic(messages, visionConfig, onStream);
  }
  throw new Error(`Unsupported provider: ${visionConfig.provider}`);
}

function formatOpenAIMessages(messages: Message[]) {
  return messages.map((m) => {
    if (m.role === "user") return m;
    if (m.role === "tool") {
      if (Array.isArray(m.content)) {
        return { role: "tool" as const, tool_call_id: m.tool_call_id, content: m.content };
      }
      return m;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      return {
        role: "assistant" as const,
        content: m.content,
        tool_calls: m.tool_calls.map((tc) => ({
          type: "function" as const,
          id: tc.id,
          function: { name: tc.name, arguments: tc.arguments || "{}" },
        })),
      };
    }
    return m;
  });
}

async function chatOpenAI(
  messages: Message[],
  config: VisionConfig,
  onStream?: OnStreamCallback,
): Promise<ChatResponse> {
  const model = config.model ?? "gpt-4o-mini";
  const tools = getOpenAITools();
  const openaiMessages = formatOpenAIMessages(messages);

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: buildSystemPrompt() }, ...openaiMessages],
      tools: tools.length ? tools : undefined,
      tool_choice: "auto",
      max_tokens: 4096,
      stream: true,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${err}`);
  }

  // Parse the SSE stream
  let text = "";
  const toolCallAccum: Map<number, { id: string; name: string; arguments: string }> = new Map();
  let finishReason = "stop";

  for await (const chunk of parseSSE(response)) {
    const delta = chunk.choices?.[0]?.delta;
    const reason = chunk.choices?.[0]?.finish_reason;
    if (reason) finishReason = reason;
    if (!delta) continue;

    // Text content
    if (delta.content) {
      text += delta.content;
      if (onStream) onStream(delta.content);
    }

    // Tool calls arrive incrementally: index, id (first chunk), function.name, function.arguments
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallAccum.has(idx)) {
          toolCallAccum.set(idx, { id: tc.id ?? "", name: "", arguments: "" });
        }
        const acc = toolCallAccum.get(idx)!;
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.arguments += tc.function.arguments;
      }
    }
  }

  const toolCalls = toolCallAccum.size > 0
    ? [...toolCallAccum.values()].filter((tc) => tc.id && tc.name)
    : undefined;

  return { text: text.trim() || null, toolCalls, finishReason };
}

async function chatAnthropic(
  messages: Message[],
  config: VisionConfig,
  onStream?: OnStreamCallback,
): Promise<ChatResponse> {
  const model = config.model ?? "claude-haiku-4-5-20251001";
  const tools = getAnthropicTools();
  const anthropicMessages = convertToAnthropicFormat(messages);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: buildSystemPrompt(),
      messages: anthropicMessages,
      tools: tools.length ? tools : undefined,
      stream: true,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error: ${response.status} ${err}`);
  }

  let text = "";
  const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
  let currentToolIdx = -1;
  let finishReason = "end_turn";

  for await (const event of parseAnthropicSSE(response)) {
    switch (event.type) {
      case "content_block_start": {
        const block = event.content_block;
        if (block?.type === "tool_use") {
          toolCalls.push({ id: block.id ?? "", name: block.name ?? "", arguments: "" });
          currentToolIdx = toolCalls.length - 1;
        }
        break;
      }
      case "content_block_delta": {
        const delta = event.delta;
        if (delta?.type === "text_delta" && delta.text) {
          text += delta.text;
          if (onStream) onStream(delta.text);
        }
        if (delta?.type === "input_json_delta" && delta.partial_json && currentToolIdx >= 0) {
          toolCalls[currentToolIdx].arguments += delta.partial_json;
        }
        break;
      }
      case "message_delta": {
        if (event.delta?.stop_reason) finishReason = event.delta.stop_reason;
        break;
      }
    }
  }

  return {
    text: text.trim() || null,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason,
  };
}

// --- SSE parsers ---

async function* parseSSE(response: Response): AsyncGenerator<Record<string, any>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data);
        } catch { /* skip malformed chunks */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function* parseAnthropicSSE(response: Response): AsyncGenerator<Record<string, any>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        try {
          yield JSON.parse(data);
        } catch { /* skip malformed chunks */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function convertToAnthropicFormat(messages: Message[]): Array<{ role: string; content: unknown[] }> {
  const result: Array<{ role: string; content: unknown[] }> = [];
  let toolResultBatch: Array<unknown> = [];

  const flushToolResults = () => {
    if (toolResultBatch.length > 0) {
      result.push({ role: "user", content: [...toolResultBatch] });
      toolResultBatch = [];
    }
  };

  for (const msg of messages) {
    if (msg.role === "user") {
      flushToolResults();
      const content: unknown[] = [];
      for (const part of msg.content) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "image_url") {
          const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            content.push({
              type: "image",
              source: { type: "base64", media_type: match[1], data: match[2] },
            });
          }
        }
      }
      result.push({ role: "user", content });
    } else if (msg.role === "assistant") {
      flushToolResults();
      const content: unknown[] = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      for (const tc of msg.tool_calls ?? []) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: parseJson(tc.arguments || "{}"),
        });
      }
      result.push({ role: "assistant", content });
    } else if (msg.role === "tool") {
      // Tool result may contain images (from read())
      if (Array.isArray(msg.content)) {
        const anthropicContent: unknown[] = [];
        for (const part of msg.content as Array<Record<string, unknown>>) {
          if (part.type === "text") {
            anthropicContent.push(part);
          } else if (part.type === "image_url") {
            const imgUrl = (part.image_url as { url: string })?.url;
            const match = imgUrl?.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              anthropicContent.push({
                type: "image",
                source: { type: "base64", media_type: match[1], data: match[2] },
              });
            }
          }
        }
        toolResultBatch.push({
          type: "tool_result",
          tool_use_id: msg.tool_call_id,
          content: anthropicContent,
        });
      } else {
        toolResultBatch.push({
          type: "tool_result",
          tool_use_id: msg.tool_call_id,
          content: msg.content,
        });
      }
    }
  }
  flushToolResults();

  return result;
}

function parseJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// Re-export helpers that index.ts may use
export { type AgentOptions };
