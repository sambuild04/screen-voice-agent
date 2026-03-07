import { execFileSync, execSync } from "node:child_process";
import { statSync } from "node:fs";

const BOOKS_APP = "Books";

function peekaboo(args: string[]): string {
  return execFileSync("peekaboo", args, { encoding: "utf-8" });
}

const LIBRARY_TITLES = new Set([
  "books",
  "library",
  "book store",
  "reading now",
  "want to read",
  "top charts",
  "top picks",
  "browse",
  "collections",
  "audiobooks",
]);

function isLibraryWindow(title: string): boolean {
  const lower = title.toLowerCase().trim();
  if (!lower) return true;
  return LIBRARY_TITLES.has(lower) || lower.startsWith("book store");
}

export interface BookWindow {
  title: string;
  windowId: number;
  width: number;
  height: number;
}

/**
 * Find the book reader window — the largest non-library window.
 * Returns the window_id and title, or null if none found.
 */
export function findBookReaderWindow(): BookWindow | null {
  try {
    const out = peekaboo(["list", "windows", "--app", BOOKS_APP, "--json"]);
    const parsed = JSON.parse(out) as unknown;
    const data = (parsed as { data?: { windows?: unknown[] } })?.data;
    const windows = data?.windows ?? (Array.isArray(parsed) ? parsed : []);

    let best: BookWindow | null = null;

    for (const w of windows) {
      const obj = w as Record<string, unknown>;
      const title = (obj.title ?? obj.name ?? "").toString();
      const windowId = Number(obj.window_id ?? 0);
      const bounds = obj.bounds as number[][] | undefined;
      const width = bounds?.[1]?.[0] ?? 0;
      const height = bounds?.[1]?.[1] ?? 0;

      // Skip tiny windows (toolbars, title bars) and library windows
      if (height < 100) continue;
      if (title && isLibraryWindow(title)) continue;

      // Prefer the largest window (by area)
      if (!best || (width * height > best.width * best.height)) {
        best = { title, windowId, width, height };
      }
    }
    return best;
  } catch (err) {
    console.error(`  Window list failed: ${(err as Error).message?.split("\n")[0]}`);
    return null;
  }
}

/**
 * Focus the book reader window. Returns window info or null.
 */
export function focusBookReader(): BookWindow | null {
  peekaboo(["app", "launch", BOOKS_APP]);
  execSync("sleep 0.5", { encoding: "utf-8" });

  const win = findBookReaderWindow();
  if (win) {
    try {
      if (win.title) {
        peekaboo(["window", "focus", "--app", BOOKS_APP, "--window-title", win.title]);
      } else {
        peekaboo(["window", "focus", "--app", BOOKS_APP, "--window-id", String(win.windowId)]);
      }
      execSync("sleep 0.3", { encoding: "utf-8" });
      console.error(`  Found: "${win.title || "(untitled)"}" (${win.width}x${win.height}, id=${win.windowId})`);
      return win;
    } catch {
      // Fall through
    }
  }
  return null;
}

export function focusBooks(): void {
  peekaboo(["app", "launch", BOOKS_APP]);
  execSync("sleep 0.5", { encoding: "utf-8" });
}

/**
 * Capture by window_id (most reliable — targets the exact window).
 * Falls back to --window-title, then --mode frontmost.
 */
export function capturePage(outputPath: string, win?: BookWindow | null): boolean {
  const baseArgs = ["image", "--app", BOOKS_APP, "--path", outputPath, "--format", "png"];

  // Try by window_id first (most precise)
  if (win?.windowId) {
    try {
      peekaboo([...baseArgs, "--window-id", String(win.windowId)]);
      const size = safeFileSize(outputPath);
      if (size > 5000) return true;
      console.error(`  window_id capture too small (${size} bytes), trying title...`);
    } catch (err) {
      console.error(`  window_id capture failed: ${(err as Error).message?.split("\n")[0]}`);
    }
  }

  // Try by title
  if (win?.title) {
    try {
      peekaboo([...baseArgs, "--window-title", win.title]);
      const size = safeFileSize(outputPath);
      if (size > 5000) return true;
      console.error(`  title capture too small (${size} bytes), trying frontmost...`);
    } catch (err) {
      console.error(`  title capture failed: ${(err as Error).message?.split("\n")[0]}`);
    }
  }

  // Fallback: frontmost
  try {
    peekaboo([...baseArgs, "--mode", "frontmost"]);
    const size = safeFileSize(outputPath);
    if (size > 5000) return true;
    console.error(`  frontmost capture too small (${size} bytes).`);
  } catch (err) {
    console.error(`  frontmost capture failed: ${(err as Error).message?.split("\n")[0]}`);
  }

  return false;
}

export function captureScreen(outputPath: string): boolean {
  try {
    peekaboo(["image", "--mode", "screen", "--path", outputPath, "--format", "png"]);
  } catch (err) {
    console.error(`  Screen capture failed: ${(err as Error).message?.split("\n")[0]}`);
    return false;
  }
  return safeFileSize(outputPath) > 5000;
}

function safeFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function turnPage(): void {
  peekaboo(["press", "right"]);
}

export function turnPageBack(): void {
  peekaboo(["press", "left"]);
}

export function scrollDown(): void {
  peekaboo(["scroll", "--direction", "down", "--amount", "5", "--smooth"]);
}

/** Open search (Cmd+F), paste query via clipboard+Cmd+V, confirm, close. */
export function searchBook(query: string): void {
  // Save clipboard, set our query
  console.error(`  search_book: setting clipboard...`);
  peekaboo(["clipboard", "--action", "save", "--slot", "books-reader"]);
  peekaboo(["clipboard", "--action", "set", "--text", query]);

  // Open search in Books — this focuses the search text field
  console.error(`  search_book: opening search...`);
  peekaboo(["hotkey", "cmd,f", "--app", BOOKS_APP]);
  execSync("sleep 1.0", { encoding: "utf-8" });

  // Cmd+V pastes into the focused search field (no-auto-focus keeps the search field active)
  console.error(`  search_book: pasting "${query}"...`);
  peekaboo(["hotkey", "cmd,v", "--no-auto-focus"]);

  // Wait for Apple Books to process search results
  console.error(`  search_book: waiting for results...`);
  execSync("sleep 2.0", { encoding: "utf-8" });

  // Return navigates to the first match
  console.error(`  search_book: pressing Return to navigate...`);
  peekaboo(["press", "return", "--no-auto-focus"]);
  execSync("sleep 0.8", { encoding: "utf-8" });

  // Escape closes the search bar
  peekaboo(["press", "escape", "--no-auto-focus"]);
  execSync("sleep 0.3", { encoding: "utf-8" });

  // Restore original clipboard
  peekaboo(["clipboard", "--action", "restore", "--slot", "books-reader"]);
  console.error(`  search_book: done.`);
}

/** Turn N pages in a direction. */
export function turnPages(count: number, direction: "forward" | "back"): void {
  const key = direction === "forward" ? "right" : "left";
  for (let i = 0; i < count; i++) {
    peekaboo(["press", key]);
    execSync("sleep 0.15", { encoding: "utf-8" });
  }
}

export function checkPeekaboo(): boolean {
  try {
    peekaboo(["permissions"]);
    return true;
  } catch {
    return false;
  }
}
