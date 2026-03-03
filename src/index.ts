#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { program } from "commander";
import {
  capturePage,
  focusBookReader,
  focusBooks,
  turnPage,
  turnPageBack,
  scrollDown,
  checkPeekaboo,
} from "./peekaboo.js";
import { extractTextFromImage } from "./vision.js";
import { getConfig, getVisionConfig } from "./config.js";
import { runAgent, type Message } from "./agent.js";
import { speak } from "./speak.js";
import { createStatusSpinner, greeting as renderGreeting, c, icons } from "./ui.js";

program
  .name("reader")
  .description("Read Apple Books. Say what you want in plain English.")
  .version("0.1.0");

program
  .argument("[message...]", "What to do, e.g. read page 1 or read one paragraph aloud")
  .option("--no-speak", "Do not read aloud (override config)")
  .action(async (messageParts: string[], opts) => {
    const instruction = (messageParts?.length ? messageParts.join(" ") : "read the current page").trim();
    if (!checkPeekaboo()) {
      console.error(
        "Error: Peekaboo is not installed or lacks permissions.\n" +
          "Install: brew install steipete/tap/peekaboo\n" +
          "Grant: Screen Recording + Accessibility in System Settings"
      );
      process.exit(1);
    }
    let config: ReturnType<typeof getConfig>;
    try {
      config = getConfig();
    } catch (err) {
      console.error("Error:", (err as Error).message);
      process.exit(1);
    }
    const ttsProvider = config.ttsProvider as "say" | "openai";
    const ttsKey = ttsProvider === "openai"
      ? (config.ttsApiKey || (config.provider === "openai" ? config.apiKey : undefined))
      : undefined;
    const wantSpeak =
      opts.speak !== false &&
      (ttsProvider === "say" || (ttsProvider === "openai" && ttsKey) || /aloud|out loud|speak|read to me/i.test(instruction));
    const spin = createStatusSpinner();
    let streamed = false;
    const onStream = (token: string) => {
      if (spin.isActive()) spin.clear();
      streamed = true;
      process.stdout.write(token);
    };
    const onStatus = (msg: string) => {
      if (!spin.isActive()) spin.start(msg);
      else spin.update(msg);
    };
    const onText = async (text: string) => {
      if (spin.isActive()) spin.clear();
      if (streamed) {
        process.stdout.write("\n");
      } else {
        console.log(c.samuel(text));
      }
      if (wantSpeak) {
        try {
          await speak(text, {
            provider: ttsProvider,
            apiKey: ttsKey,
            voice: config.ttsVoice,
            model: config.ttsModel,
            instructions: config.ttsInstructions,
            speed: config.ttsSpeed,
          });
        } catch {
          console.error(c.dim("(TTS unavailable)"));
        }
      }
    };
    try {
      await runAgent({
        maxIterations: 50,
        focus: true,
        message: instruction,
        waitForReady: false,
        onText,
        onStream,
        onStatus,
      });
    } catch (err) {
      console.error("Error:", (err as Error).message);
      process.exit(1);
    }
  });

program
  .command("pages")
  .description("Fixed pipeline: read exactly N pages (no agent)")
  .option("-p, --pages <n>", "Number of pages to read (default: 1)", "1")
  .option("--speak", "Read text aloud")
  .option("--tts <provider>", "TTS provider: say (default) or openai", "say")
  .option("--wait", "Wait for Enter before capturing (switch to book reader window first)")
  .option("--no-focus", "Skip focusing Books app (use if already open)")
  .action(async (opts) => {
    const pages = parseInt(opts.pages, 10);
    if (isNaN(pages) || pages < 1) {
      console.error("Error: --pages must be a positive integer");
      process.exit(1);
    }

    if (!checkPeekaboo()) {
      console.error(
        "Error: Peekaboo is not installed or lacks permissions.\n" +
          "Install: brew install steipete/tap/peekaboo\n" +
          "Grant: Screen Recording + Accessibility in System Settings"
      );
      process.exit(1);
    }

    let config: ReturnType<typeof getConfig>;
    try {
      config = getConfig();
    } catch (err) {
      console.error("Error:", (err as Error).message);
      process.exit(1);
    }

    const visionConfig = getVisionConfig(config);
    const tempDir = mkdtempSync(join(tmpdir(), "books-reader-"));
    const imagePath = join(tempDir, "page.png");

    try {
      let bookWin = null;
      if (opts.focus !== false) {
        console.error("Finding book reader window...");
        bookWin = focusBookReader();
        if (!bookWin) {
          console.error("Could not find book reader (using default). Ensure a book is open.");
          focusBooks();
        }
      }
      if (opts.wait === true) {
        const readline = await import("node:readline/promises");
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        console.error("Open a book in Apple Books. Press Enter when ready.");
        await rl.question("");
        rl.close();
        console.error("Click the book reader window NOW (the one with the book text). Capturing in 5 seconds...");
        await new Promise((r) => setTimeout(r, 5000));
      } else {
        console.error("Capturing in 2 seconds...");
        await new Promise((r) => setTimeout(r, 2000));
      }

      for (let i = 0; i < pages; i++) {
        if (pages > 1 && i > 0) {
          console.error(`\n--- Page ${i + 1} ---\n`);
        }

        capturePage(imagePath, bookWin);
        const text = await extractTextFromImage(imagePath, visionConfig);

        if (text) {
          console.log(text);
          if (opts.speak) {
            const ttsProvider = (opts.tts ?? config.ttsProvider) as "say" | "openai";
            const ttsKey =
              ttsProvider === "openai"
                ? (config.ttsApiKey || (config.provider === "openai" ? config.apiKey : undefined))
                : undefined;
            await speak(text, {
              provider: ttsProvider,
              apiKey: ttsKey,
              voice: config.ttsVoice,
              model: config.ttsModel,
              instructions: config.ttsInstructions,
              speed: config.ttsSpeed,
            });
          }
        } else {
          console.error("(No text extracted - DRM or blank page?)");
        }

        if (i < pages - 1) {
          turnPage();
          await new Promise((r) => setTimeout(r, config.delayMs ?? 800));
        }
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

program
  .command("chat")
  .description("Interactive mode: chat naturally or give read commands (read page 1, next, what can you do)")
  .option("--no-speak", "Do not read aloud (override config)")
  .action(async (opts) => {
    let config: ReturnType<typeof getConfig>;
    try {
      config = getConfig();
    } catch (err) {
      console.error("Error:", (err as Error).message);
      process.exit(1);
    }
    const ttsProvider = config.ttsProvider as "say" | "openai";
    const ttsKey =
      ttsProvider === "openai"
        ? (config.ttsApiKey || (config.provider === "openai" ? config.apiKey : undefined))
        : undefined;
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    let sessionHistory: Message[] = [];

    // Styled greeting
    console.error(renderGreeting());
    console.error();
    const greetingText = (() => {
      const hour = new Date().getHours();
      const g = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
      return `${g}, sir. Samuel at your service. What shall we read today?`;
    })();
    const speakGreeting =
      opts.speak !== false && (ttsProvider === "say" || (ttsProvider === "openai" && ttsKey));
    if (speakGreeting) {
      try {
        await speak(greetingText, {
          provider: ttsProvider,
          apiKey: ttsKey,
          voice: config.ttsVoice,
          model: config.ttsModel,
          instructions: config.ttsInstructions,
          speed: config.ttsSpeed,
        });
      } catch {
        console.error(c.dim("(TTS unavailable — continuing without voice)"));
      }
    }
    while (true) {
      let input: string;
      try {
        input = (await rl.question(c.prompt("> "))).trim();
      } catch {
        break;
      }
      if (!input) continue;
      const lower = input.toLowerCase();
      if (lower === "exit" || lower === "quit" || lower === "q") {
        console.error(c.dim("Until next time, sir."));
        break;
      }
      if (lower === "clear" || lower === "reset") {
        sessionHistory = [];
        console.error(c.dim("Session cleared."));
        continue;
      }
      const wantSpeak =
        opts.speak !== false &&
        (ttsProvider === "say" || (ttsProvider === "openai" && ttsKey) || /aloud|out loud|speak|read to me/i.test(input));
      const spin = createStatusSpinner();
      let streamed = false;
      const onStream = (token: string) => {
        if (spin.isActive()) spin.clear();
        streamed = true;
        process.stdout.write(token);
      };
      const onStatus = (msg: string) => {
        if (!spin.isActive()) spin.start(msg);
        else spin.update(msg);
      };
      const onText = async (text: string) => {
        if (spin.isActive()) spin.clear();
        if (streamed) {
          process.stdout.write("\n");
        } else {
          console.log(c.samuel(text));
        }
        if (wantSpeak) {
          try {
            await speak(text, {
              provider: ttsProvider,
              apiKey: ttsKey,
              voice: config.ttsVoice,
              model: config.ttsModel,
              instructions: config.ttsInstructions,
              speed: config.ttsSpeed,
            });
          } catch {
            console.error(c.dim("(TTS unavailable)"));
          }
        }
      };
      try {
        sessionHistory = await runAgent({
          maxIterations: 10,
          focus: true,
          message: input,
          waitForReady: false,
          warmStart: sessionHistory.length > 0,
          onText,
          onStream,
          onStatus,
          history: sessionHistory,
        });
      } catch (err) {
        if (spin.isActive()) spin.fail("Error");
        console.error(c.error(`Error: ${(err as Error).message}`));
      }
    }
    rl.close();
  });

program
  .command("agent")
  .description("Explicit agent mode with all options")
  .option("-m, --max-iterations <n>", "Max agent loop iterations (default: 50)", "50")
  .option("-p, --pages <n>", "Read exactly N pages from current page, then stop (e.g. 1=current only, 2=current+next)")
  .option("--speak", "Read text aloud")
  .option("--tts <provider>", "TTS provider: say (default) or openai", "say")
  .option("--wait", "Wait for Enter before capturing (switch to book reader window first)")
  .option("--no-focus", "Skip focusing Books app")
  .action(async (opts) => {
    const maxIterations = parseInt(opts.maxIterations, 10);
    if (isNaN(maxIterations) || maxIterations < 1) {
      console.error("Error: --max-iterations must be a positive integer");
      process.exit(1);
    }

    let pages: number | undefined;
    if (opts.pages != null) {
      const n = parseInt(opts.pages, 10);
      if (isNaN(n) || n < 1) {
        console.error("Error: --pages must be a positive integer");
        process.exit(1);
      }
      pages = n;
    }

    if (!checkPeekaboo()) {
      console.error(
        "Error: Peekaboo is not installed or lacks permissions.\n" +
          "Install: brew install steipete/tap/peekaboo\n" +
          "Grant: Screen Recording + Accessibility in System Settings"
      );
      process.exit(1);
    }

    let config: ReturnType<typeof getConfig>;
    try {
      config = getConfig();
    } catch (err) {
      console.error("Error:", (err as Error).message);
      process.exit(1);
    }

    try {
      const onText = async (text: string) => {
        console.log(text);
        if (opts.speak) {
          const ttsProvider = (opts.tts ?? config.ttsProvider) as "say" | "openai";
          const ttsKey =
            ttsProvider === "openai"
              ? (config.ttsApiKey || (config.provider === "openai" ? config.apiKey : undefined))
              : undefined;
          await speak(text, {
            provider: ttsProvider,
            apiKey: ttsKey,
            voice: config.ttsVoice,
            model: config.ttsModel,
            instructions: config.ttsInstructions,
            speed: config.ttsSpeed,
          });
        }
      };

      await runAgent({
        maxIterations,
        focus: opts.focus !== false,
        pages,
        waitForReady: opts.wait === true,
        onText,
      });
    } catch (err) {
      console.error("Error:", (err as Error).message);
      process.exit(1);
    }
  });

program.parse();
