/**
 * Browser automation agent powered by Playwright.
 *
 * Runs as a sidecar process. Receives JSON commands on stdin,
 * returns JSON results on stdout. The Tauri backend spawns this
 * and communicates via the simple line-delimited JSON protocol.
 *
 * Commands: open, goto, read_page, click, type, screenshot, scroll,
 *           extract, list_tabs, close_tab, close
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import * as readline from "readline";

let browser: Browser | null = null;
let context: BrowserContext | null = null;
const pages = new Map<number, Page>();
let nextTabId = 1;
let activeTabId = 0;

function reply(id: string, ok: boolean, data: unknown) {
  const msg = JSON.stringify({ id, ok, data });
  process.stdout.write(msg + "\n");
}

async function ensureBrowser(): Promise<BrowserContext> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: false,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
  }
  return context!;
}

async function getActivePage(): Promise<Page> {
  const page = pages.get(activeTabId);
  if (!page) throw new Error("No active tab. Use 'open' or 'goto' first.");
  return page;
}

async function newTab(url?: string): Promise<{ tabId: number; page: Page }> {
  const ctx = await ensureBrowser();
  const page = await ctx.newPage();
  const tabId = nextTabId++;
  pages.set(tabId, page);
  activeTabId = tabId;

  if (url) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  }

  return { tabId, page };
}

// Extract readable text from the current page
async function extractText(page: Page, selector?: string): Promise<string> {
  return page.evaluate((sel) => {
    const el = sel ? document.querySelector(sel) : document.body;
    if (!el) return "(element not found)";

    // Remove scripts, styles, nav, header, footer for cleaner content
    const clone = el.cloneNode(true) as HTMLElement;
    for (const tag of ["script", "style", "nav", "header", "footer", "iframe", "noscript"]) {
      clone.querySelectorAll(tag).forEach((n) => n.remove());
    }

    // Get visible text, collapse whitespace
    const text = clone.innerText || clone.textContent || "";
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join("\n")
      .slice(0, 15000);
  }, selector);
}

// Extract structured data (links, inputs, buttons) for agent navigation
async function extractStructure(page: Page): Promise<string> {
  return page.evaluate(() => {
    const items: string[] = [];

    // Clickable elements
    const clickable = document.querySelectorAll("a[href], button, [role='button'], input[type='submit']");
    const seen = new Set<string>();
    clickable.forEach((el, i) => {
      const text = (el as HTMLElement).innerText?.trim().slice(0, 80) || "";
      const href = (el as HTMLAnchorElement).href || "";
      const tag = el.tagName.toLowerCase();
      const key = `${tag}:${text}:${href}`;
      if (seen.has(key) || (!text && !href)) return;
      seen.add(key);
      if (items.length < 40) {
        items.push(`[${i}] <${tag}> "${text}"${href ? ` → ${href}` : ""}`);
      }
    });

    // Input fields
    const inputs = document.querySelectorAll("input:not([type='hidden']), textarea, select");
    inputs.forEach((el) => {
      const inp = el as HTMLInputElement;
      const label =
        inp.getAttribute("aria-label") ||
        inp.getAttribute("placeholder") ||
        inp.getAttribute("name") ||
        inp.type;
      items.push(`[input] <${inp.tagName.toLowerCase()} type="${inp.type || "text"}"> "${label}"`);
    });

    return items.join("\n").slice(0, 8000);
  });
}

async function handleCommand(cmd: { id: string; action: string; [k: string]: unknown }) {
  try {
    switch (cmd.action) {
      case "open": {
        const { tabId, page } = await newTab(cmd.url as string | undefined);
        const title = await page.title();
        const url = page.url();
        reply(cmd.id, true, { tabId, title, url, message: `Opened tab #${tabId}: ${title}` });
        break;
      }

      case "goto": {
        const page = await getActivePage();
        await page.goto(cmd.url as string, { waitUntil: "domcontentloaded", timeout: 30000 });
        const title = await page.title();
        reply(cmd.id, true, { title, url: page.url(), message: `Navigated to: ${title}` });
        break;
      }

      case "read_page": {
        const page = await getActivePage();
        const text = await extractText(page, cmd.selector as string | undefined);
        const title = await page.title();
        const url = page.url();
        reply(cmd.id, true, { title, url, text, length: text.length });
        break;
      }

      case "read_structure": {
        const page = await getActivePage();
        const structure = await extractStructure(page);
        const title = await page.title();
        reply(cmd.id, true, { title, url: page.url(), structure });
        break;
      }

      case "click": {
        const page = await getActivePage();
        const sel = cmd.selector as string;
        if (cmd.text) {
          // Click by visible text
          const text = cmd.text as string;
          await page.getByText(text, { exact: false }).first().click({ timeout: 10000 });
        } else if (sel) {
          await page.click(sel, { timeout: 10000 });
        } else {
          throw new Error("Need 'selector' or 'text' to click");
        }
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        const title = await page.title();
        reply(cmd.id, true, { title, url: page.url(), message: `Clicked. Now on: ${title}` });
        break;
      }

      case "type": {
        const page = await getActivePage();
        const sel = (cmd.selector as string) || "input:focus, textarea:focus, [contenteditable]:focus";
        await page.fill(sel, cmd.text as string);
        reply(cmd.id, true, { message: `Typed into ${sel}` });
        break;
      }

      case "press": {
        const page = await getActivePage();
        await page.keyboard.press(cmd.key as string);
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        reply(cmd.id, true, { message: `Pressed ${cmd.key}` });
        break;
      }

      case "screenshot": {
        const page = await getActivePage();
        const buf = await page.screenshot({ type: "jpeg", quality: 70 });
        const base64 = buf.toString("base64");
        reply(cmd.id, true, { base64, mimeType: "image/jpeg", title: await page.title() });
        break;
      }

      case "scroll": {
        const page = await getActivePage();
        const dir = (cmd.direction as string) || "down";
        const px = (cmd.pixels as number) || 600;
        await page.evaluate(
          ({ dir, px }) => window.scrollBy(0, dir === "up" ? -px : px),
          { dir, px },
        );
        reply(cmd.id, true, { message: `Scrolled ${dir} ${px}px` });
        break;
      }

      case "wait": {
        const page = await getActivePage();
        const ms = Math.min((cmd.ms as number) || 2000, 10000);
        await page.waitForTimeout(ms);
        reply(cmd.id, true, { message: `Waited ${ms}ms` });
        break;
      }

      case "list_tabs": {
        const tabs: { id: number; title: string; url: string; active: boolean }[] = [];
        for (const [id, page] of pages) {
          tabs.push({ id, title: await page.title(), url: page.url(), active: id === activeTabId });
        }
        reply(cmd.id, true, { tabs });
        break;
      }

      case "switch_tab": {
        const tabId = cmd.tabId as number;
        if (!pages.has(tabId)) throw new Error(`Tab #${tabId} not found`);
        activeTabId = tabId;
        const page = pages.get(tabId)!;
        reply(cmd.id, true, { tabId, title: await page.title(), url: page.url() });
        break;
      }

      case "close_tab": {
        const tabId = (cmd.tabId as number) || activeTabId;
        const page = pages.get(tabId);
        if (page) {
          await page.close();
          pages.delete(tabId);
          if (activeTabId === tabId) {
            activeTabId = pages.keys().next().value ?? 0;
          }
        }
        reply(cmd.id, true, { message: `Closed tab #${tabId}`, remaining: pages.size });
        break;
      }

      // ── CUA (Computer Use Agent) actions ──────────────────────────────
      // These mirror the GPT-5.5 computer tool action vocabulary exactly.

      case "cua_screenshot": {
        const page = await getActivePage();
        const buf = await page.screenshot({ type: "png", fullPage: false });
        const base64 = buf.toString("base64");
        const vp = page.viewportSize() ?? { width: 1280, height: 900 };
        reply(cmd.id, true, {
          base64,
          mimeType: "image/png",
          width: vp.width,
          height: vp.height,
          title: await page.title(),
          url: page.url(),
        });
        break;
      }

      case "cua_click": {
        const page = await getActivePage();
        const x = cmd.x as number;
        const y = cmd.y as number;
        const button = (cmd.button as "left" | "right" | "middle") ?? "left";
        const modifiers: string[] = (cmd.keys as string[]) ?? [];
        const pw = modifiers.map(modToPw).filter(Boolean) as string[];
        for (const m of pw) await page.keyboard.down(m);
        await page.mouse.click(x, y, { button });
        for (const m of pw) await page.keyboard.up(m);
        reply(cmd.id, true, { message: `Clicked (${x}, ${y})` });
        break;
      }

      case "cua_double_click": {
        const page = await getActivePage();
        const x = cmd.x as number;
        const y = cmd.y as number;
        await page.mouse.dblclick(x, y);
        reply(cmd.id, true, { message: `Double-clicked (${x}, ${y})` });
        break;
      }

      case "cua_type": {
        const page = await getActivePage();
        await page.keyboard.type(cmd.text as string);
        reply(cmd.id, true, { message: `Typed ${(cmd.text as string).length} chars` });
        break;
      }

      case "cua_keypress": {
        const page = await getActivePage();
        const keys: string[] = (cmd.keys as string[]) ?? [cmd.key as string];
        for (const k of keys) {
          await page.keyboard.press(normalizeKey(k));
        }
        reply(cmd.id, true, { message: `Pressed keys: ${keys.join("+")}` });
        break;
      }

      case "cua_scroll": {
        const page = await getActivePage();
        const x = (cmd.x as number) ?? 640;
        const y = (cmd.y as number) ?? 450;
        const dx = (cmd.scroll_x as number) ?? 0;
        const dy = (cmd.scroll_y as number) ?? 0;
        await page.mouse.move(x, y);
        await page.mouse.wheel(dx, dy);
        reply(cmd.id, true, { message: `Scrolled (${dx}, ${dy}) at (${x}, ${y})` });
        break;
      }

      case "cua_drag": {
        const page = await getActivePage();
        const path: { x: number; y: number }[] = cmd.path as { x: number; y: number }[];
        if (!path || path.length < 2) {
          reply(cmd.id, false, { error: "Drag needs path with at least 2 points" });
          break;
        }
        await page.mouse.move(path[0].x, path[0].y);
        await page.mouse.down();
        for (let i = 1; i < path.length; i++) {
          await page.mouse.move(path[i].x, path[i].y, { steps: 5 });
        }
        await page.mouse.up();
        reply(cmd.id, true, { message: `Dragged ${path.length} points` });
        break;
      }

      case "cua_move": {
        const page = await getActivePage();
        await page.mouse.move(cmd.x as number, cmd.y as number);
        reply(cmd.id, true, { message: `Moved to (${cmd.x}, ${cmd.y})` });
        break;
      }

      case "cua_wait": {
        const page = await getActivePage();
        await page.waitForTimeout(Math.min((cmd.ms as number) ?? 2000, 15000));
        reply(cmd.id, true, { message: "Wait complete" });
        break;
      }

      case "close": {
        if (browser) await browser.close();
        reply(cmd.id, true, { message: "Browser closed" });
        process.exit(0);
        break;
      }

      default:
        reply(cmd.id, false, { error: `Unknown action: ${cmd.action}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    reply(cmd.id, false, { error: msg });
  }
}

// Map GPT-5.5 modifier names to Playwright modifiers
function modToPw(key: string): string | null {
  const m: Record<string, string> = {
    CTRL: "Control", CONTROL: "Control",
    ALT: "Alt", OPTION: "Alt",
    SHIFT: "Shift",
    META: "Meta", CMD: "Meta", COMMAND: "Meta",
  };
  return m[key.toUpperCase()] ?? null;
}

// Normalize GPT-5.5 key names to Playwright key names
function normalizeKey(key: string): string {
  const m: Record<string, string> = {
    ENTER: "Enter", RETURN: "Enter",
    TAB: "Tab", ESCAPE: "Escape", ESC: "Escape",
    BACKSPACE: "Backspace", DELETE: "Delete",
    SPACE: " ",
    ARROWUP: "ArrowUp", ARROWDOWN: "ArrowDown",
    ARROWLEFT: "ArrowLeft", ARROWRIGHT: "ArrowRight",
    CTRL: "Control", ALT: "Alt", SHIFT: "Shift", META: "Meta",
    HOME: "Home", END: "End", PAGEUP: "PageUp", PAGEDOWN: "PageDown",
  };
  return m[key.toUpperCase()] ?? key;
}

// Read JSON commands from stdin, one per line
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const cmd = JSON.parse(line.trim());
    if (cmd.action) handleCommand(cmd);
  } catch {
    // Ignore malformed lines
  }
});

process.stderr.write("[browser-agent] ready\n");
