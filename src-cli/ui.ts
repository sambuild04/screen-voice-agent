import pc from "picocolors";

export const c = {
  accent: pc.cyan,
  success: pc.green,
  warn: pc.yellow,
  error: pc.red,
  dim: pc.dim,
  bold: pc.bold,
  samuel: pc.cyan,
  prompt: pc.bold,
};

export const icons = {
  check: c.success("✓"),
  cross: c.error("✗"),
  arrow: c.dim("→"),
};

const FRAMES = ["◐", "◓", "◑", "◒"];
const INTERVAL = 100;

/**
 * Lightweight spinner that only writes to stderr.
 * Unlike @clack/prompts spinner, this never touches stdin,
 * so it won't break readline in interactive chat mode.
 */
export function createStatusSpinner() {
  let active = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let frame = 0;
  let currentMsg = "";

  const render = () => {
    const symbol = c.accent(FRAMES[frame % FRAMES.length]);
    const line = `${symbol}  ${c.accent(currentMsg)}`;
    process.stderr.write(`\r\x1b[K${line}`);
    frame++;
  };

  const clearLine = () => {
    process.stderr.write("\r\x1b[K");
  };

  return {
    start(msg: string) {
      if (active) {
        currentMsg = msg;
        return;
      }
      active = true;
      frame = 0;
      currentMsg = msg;
      render();
      timer = setInterval(render, INTERVAL);
    },
    update(msg: string) {
      if (active) {
        currentMsg = msg;
      }
    },
    stop(msg: string, icon = icons.check) {
      if (!active) return;
      if (timer) clearInterval(timer);
      timer = null;
      active = false;
      clearLine();
      process.stderr.write(`${icon} ${msg}\n`);
    },
    clear() {
      if (!active) return;
      if (timer) clearInterval(timer);
      timer = null;
      active = false;
      clearLine();
    },
    fail(msg: string) {
      this.stop(c.error(msg), icons.cross);
    },
    isActive() {
      return active;
    },
  };
}

export type StatusSpinner = ReturnType<typeof createStatusSpinner>;

export function greeting(): string {
  const hour = new Date().getHours();
  const time = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const line1 = `Good ${time}, sir. Samuel at your service.`;
  const line2 = "What shall we read today?";
  const width = Math.max(line1.length, line2.length) + 4;
  const pad = (s: string) => `│  ${s}${" ".repeat(width - s.length - 4)}  │`;
  return [
    c.dim(`┌${"─".repeat(width)}┐`),
    c.dim(pad(line1)),
    c.dim(pad(line2)),
    c.dim(`└${"─".repeat(width)}┘`),
  ].join("\n");
}
