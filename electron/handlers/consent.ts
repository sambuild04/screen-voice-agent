import { dialog } from "electron";
import { getWindowRef } from "../window-ref.js";

// macOS-style consent dialog shown when the user flips a privacy toggle
// from OFF to ON in Settings. Mirrors the wording and shape of native
// macOS TCC prompts ("<App> would like to access <thing> to …") so the
// user sees a familiar consent pattern instead of a silent flip.
//
// The renderer is the source of truth for the toggle state — this handler
// only reports what the user clicked. The renderer is responsible for
// only persisting the new value when this returns { allowed: true }.

interface ConsentArgs {
	// Toggle key, e.g. "privacy.voice_input". Used purely for the dialog
	// copy lookup; unrecognised keys fall back to a generic phrasing.
	key?: string;
	// Optional explicit override — bypasses the lookup table. Provide both
	// to override either the title noun or the purpose phrase.
	access?: string;
	purpose?: string;
}

interface ConsentCopy {
	access: string;
	purpose: string;
}

// Per-capability copy. Keep these short and concrete — the user is
// reading them mid-action, not in a settings tour. Match the cadence of
// real macOS TCC prompts ("would like to access <noun> <to do thing>").
const COPY: Record<string, ConsentCopy> = {
	"privacy.voice_input": {
		access: "your microphone",
		purpose:
			"to hear what you say so it can hold a conversation and respond by voice.",
	},
	"privacy.audio_listen": {
		access: "ambient audio between turns",
		purpose:
			"so it can answer questions like “what did they just say?” by recalling the last few seconds.",
	},
	"privacy.audio_record": {
		access: "system audio on demand",
		purpose:
			"so you can ask it to record a song, clip, or meeting and have it transcribed or analyzed.",
	},
	"privacy.screen_read": {
		access: "your screen on demand",
		purpose:
			"so it can read on-screen content (a webpage, app, or document) when you ask about it.",
	},
	"privacy.screen_watch": {
		access: "your screen between turns",
		purpose:
			"so it can proactively notice things you’re looking at — language hints, watch-list alerts, ambient cues.",
	},
	"privacy.computer_use": {
		access: "control of your mouse and keyboard",
		purpose:
			"so it can click, type, and operate apps for you when you ask it to.",
	},
	"privacy.local_time": {
		access: "your local time and timezone",
		purpose: "so it knows what time it is for you when you ask.",
	},
	"privacy.location": {
		access: "your approximate location",
		purpose:
			"so it can answer “where am I”, look up local weather, and tailor locale-specific help.",
	},
};

function copyFor(args: ConsentArgs): ConsentCopy {
	const fallback: ConsentCopy = {
		access: args.access ?? "this capability",
		purpose:
			args.purpose ??
			"so it can do what you’re asking. You can turn this back off anytime in Settings.",
	};
	const key = args.key ?? "";
	const fromTable = COPY[key];
	if (!fromTable) return fallback;
	return {
		access: args.access ?? fromTable.access,
		purpose: args.purpose ?? fromTable.purpose,
	};
}

// Show the dialog and return whether the user clicked Allow.
//
// Behavior shape mirrors macOS TCC prompts:
//   - Title:  "Samuel" (the app, not the capability — same as TCC)
//   - Body:   "Samuel would like to access <X>." + purpose
//   - Buttons: ["Don't Allow", "Allow"], cancel-defaulted to Don't Allow
//             so a stray Esc keeps the privacy gate closed.
export async function request_privacy_consent(
	args: ConsentArgs = {},
): Promise<{ allowed: boolean }> {
	const { access, purpose } = copyFor(args);
	const win = getWindowRef();

	const options: Electron.MessageBoxOptions = {
		type: "info",
		// Empty title matches macOS TCC styling — the alert sheet shows the
		// app name as the heading and uses message/detail for the body.
		title: "",
		message: `Samuel would like to access ${access}.`,
		detail: purpose,
		buttons: ["Don\u2019t Allow", "Allow"],
		defaultId: 1,
		cancelId: 0,
		noLink: true,
	};

	const result = win
		? await dialog.showMessageBox(win, options)
		: await dialog.showMessageBox(options);
	return { allowed: result.response === 1 };
}
