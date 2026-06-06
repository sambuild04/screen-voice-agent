import { writeFileSync, unlinkSync, copyFileSync } from "node:fs";
import { openaiFetch } from "./openai-client.js";

export async function transcribe_audio(args: {
	audio_base64: string;
	extension: string;
}): Promise<string> {
	if (!args.audio_base64) return "";

	const audioBytes = Buffer.from(args.audio_base64, "base64");

	const ext = args.extension || "mp4";
	const tmpPath = `/tmp/samuel-wake-audio.${ext}`;
	writeFileSync(tmpPath, audioBytes);

	const debugPath = `/tmp/samuel-wake-debug.${ext}`;
	try {
		copyFileSync(tmpPath, debugPath);
	} catch {
		// ignore
	}

	console.error(
		`[wake] transcribing ${(audioBytes.length / 1024).toFixed(1)}KB audio (${ext}) — debug copy at ${debugPath}`,
	);

	const form = new FormData();
	form.append(
		"file",
		new Blob([audioBytes], { type: `audio/${ext}` }),
		`audio.${ext}`,
	);
	form.append("model", "gpt-4o-mini-transcribe");
	form.append("language", "en");
	form.append(
		"prompt",
		"Transcribe any English speech. If the audio is silence, noise, music, or non-English speech, return an empty string.",
	);

	const resp = await openaiFetch("/v1/audio/transcriptions", {
		method: "POST",
		body: form,
		signal: AbortSignal.timeout(10_000),
	});

	try {
		unlinkSync(tmpPath);
	} catch {
		// ignore
	}

	if (!resp.ok) {
		const errText = await resp.text();
		throw new Error(`Whisper API error: ${errText}`);
	}

	const body = await resp.json();

	if (body.error) {
		throw new Error(
			`Whisper API: ${body.error.message ?? "unknown"}`,
		);
	}

	const text: string = body.text ?? "";
	console.error(`[wake] whisper: "${text}"`);
	return text;
}
