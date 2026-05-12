import { type ChildProcess, spawn, execFileSync } from "node:child_process";
import {
	readFileSync,
	writeFileSync,
	unlinkSync,
	existsSync,
	statSync,
	copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { readConfigInternal } from "./config.js";
import {
	get_context as memoryGetContext,
	record_observation as memoryRecordObservation,
	record_vocabulary as memoryRecordVocabulary,
	record_transcript as memoryRecordTranscript,
} from "./memory.js";

// ── Module-level state ──────────────────────────────────────────────────────

let recordingChild: ChildProcess | null = null;
let learningAudioChild: ChildProcess | null = null;
const LEARNING_AUDIO_PATH = "/tmp/samuel-learning-audio.m4a";
const RECORDING_PATH = "/tmp/samuel-recording.m4a";

// ── Audio capture refcounting ────────────────────────────────────────────────
//
// The system-audio capture helper is a single OS-level resource (one
// ScreenCaptureKit stream writing to LEARNING_AUDIO_PATH). Multiple consumers
// may want it running at once — e.g. learning mode + the standalone watcher
// loop — so we track which consumers are currently subscribed and stop the
// helper only when the last one releases. Simultaneous transcription cycles
// would race on the same file, so a single-flight latch around the chunk
// read+transcribe step keeps them honest; the loser of the race just gets
// an empty result and tries again next tick.
const audioConsumers = new Set<string>();
let audioCheckInFlight = false;

function acquireAudioCapture(consumer: string): void {
	const wasEmpty = audioConsumers.size === 0;
	audioConsumers.add(consumer);
	if (wasEmpty) {
		startLearningAudioInternal();
	}
}

async function releaseAudioCapture(consumer: string): Promise<void> {
	if (!audioConsumers.delete(consumer)) return;
	if (audioConsumers.size === 0) {
		await stopLearningAudioInternal();
		tryRemove(LEARNING_AUDIO_PATH);
	}
}

// Screen change detection state
let screenStateLastHash = 0;
let screenStateLastApp = "";
let screenStateLastAnalysis = 0;

// Separate watcher screen state
let watcherScreenLastHash = 0;
let watcherScreenLastApp = "";
let watcherScreenLastAnalysis = 0;

// Transcript window for viewing assessment
let transcriptWindow: string[] = [];

// Samuel's recent speech buffer for echo filtering
const samuelRecentSpeech: string[] = [];
const MAX_SPEECH_BUFFER = 10;

// Apps where Samuel stays silent (deep focus)
const FOCUS_APPS = [
	"Cursor", "Code", "Xcode", "Terminal", "iTerm2",
	"Notion", "Obsidian", "Pages", "Word", "Alacritty",
	"kitty", "Warp", "IntelliJ", "PyCharm", "WebStorm",
];

// ── Types ───────────────────────────────────────────────────────────────────

export interface ScriptLine {
	timestamp: string;
	text: string;
}

export interface VocabEntry {
	word: string;
	reading: string;
	meaning: string;
	level: string;
}

export interface GrammarPoint {
	pattern: string;
	explanation: string;
	examples: string[];
}

export interface RecordingAnalysis {
	transcript: ScriptLine[];
	translated_transcript: ScriptLine[];
	vocabulary: VocabEntry[];
	grammar: GrammarPoint[];
	summary: string;
}

export interface TriageDecision {
	classification: string;
	confidence: number;
	message: string;
}

export interface AudioCheckResult {
	transcript: string | null;
	hint: string | null;
	pcm_audio_base64: string | null;
}

export interface ViewingAssessment {
	classification: string;
	message: string;
	confidence: number;
}

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface DeepSearchResult {
	answer: string;
	sources: string[];
}

// ── Internal helpers ────────────────────────────────────────────────────────

function truncateStr(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, max);
}

function tryRemove(path: string): void {
	try { unlinkSync(path); } catch { /* ignore */ }
}

function nowSecs(): number {
	return Math.floor(Date.now() / 1000);
}

function hashBytes(data: Buffer | Uint8Array): number {
	let hash = 0;
	for (let i = 0; i < data.length; i += 64) {
		hash = (hash * 31 + data[i]) | 0;
	}
	return hash >>> 0;
}

function getFrontmostAppName(): string {
	try {
		return execFileSync("/usr/bin/osascript", [
			"-e",
			'tell application "System Events" to get name of first application process whose frontmost is true',
		], { encoding: "utf-8" }).trim();
	} catch {
		return "";
	}
}

const EXCLUDED_APPS = ["samuel", "cursor", "electron"];

function getUserFacingApp(): string | null {
	const script = `tell application "System Events"
  set appList to name of every application process whose visible is true
  return appList
end tell`;
	try {
		const raw = execFileSync("/usr/bin/osascript", ["-e", script], {
			encoding: "utf-8",
		});
		for (const name of raw.split(",")) {
			const trimmed = name.trim();
			if (!trimmed) continue;
			const lower = trimmed.toLowerCase();
			if (EXCLUDED_APPS.some((ex) => lower.includes(ex))) continue;
			return trimmed;
		}
	} catch {
		// ignore
	}
	return null;
}

function findRecordHelper(): string {
	const candidates = [
		join(process.cwd(), "helpers", "record-audio"),
		join(__dirname, "..", "..", "helpers", "record-audio"),
	];
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	throw new Error(
		"record-audio helper not found. Compile it with: " +
		"swiftc -o helpers/record-audio helpers/record-audio.swift " +
		"-framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia",
	);
}

function captureFocusedWindowSync(): { base64: string; app_name: string } {
	const tmpPng = "/tmp/samuel-screen.png";
	const tmpJpg = "/tmp/samuel-screen.jpg";

	tryRemove(tmpPng);

	const target = getUserFacingApp() ?? "";
	let displayIdx = 1;
	try {
		const { get_default_display } = require("./capture.js") as { get_default_display(): number };
		displayIdx = get_default_display();
	} catch {
		// ignore
	}

	// Try peekaboo first
	if (target) {
		try {
			const peekPaths = ["/opt/homebrew/bin/peekaboo", "/usr/local/bin/peekaboo"];
			let bin = "peekaboo";
			for (const p of peekPaths) {
				if (existsSync(p)) { bin = p; break; }
			}
			execFileSync(bin, [
				"image", "--app", target, "--format", "png", "--path", tmpPng,
			]);
		} catch {
			// fall through
		}
	}

	const peekabooOk = existsSync(tmpPng) && statSync(tmpPng).size > 10_000;

	if (!peekabooOk) {
		tryRemove(tmpPng);
		const dFlag = `-D${displayIdx}`;
		execFileSync("/usr/sbin/screencapture", ["-x", dFlag, tmpPng]);
	}

	const data = readFileSync(tmpPng);
	if (data.length < 1000) {
		tryRemove(tmpPng);
		throw new Error("Captured image too small");
	}

	execFileSync("/usr/bin/sips", [
		"--resampleWidth", "1024",
		"--setProperty", "format", "jpeg",
		"--setProperty", "formatOptions", "60",
		tmpPng, "--out", tmpJpg,
	]);

	tryRemove(tmpPng);
	const jpgData = readFileSync(tmpJpg);
	tryRemove(tmpJpg);

	return {
		base64: jpgData.toString("base64"),
		app_name: target || `Display ${displayIdx}`,
	};
}

async function openaiChat(
	apiKey: string,
	model: string,
	messages: Array<{ role: string; content: unknown }>,
	maxTokens: number,
	temperature = 0.3,
): Promise<unknown> {
	const body = { model, messages, max_tokens: maxTokens, temperature };

	const resp = await fetch("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!resp.ok) {
		const errText = await resp.text();
		throw new Error(`OpenAI API error: ${errText}`);
	}

	return resp.json();
}

function extractChatContent(data: Record<string, unknown>): string {
	const content = (data as any)?.choices?.[0]?.message?.content;
	return typeof content === "string" ? content.trim() : "";
}

function stripFences(s: string): string {
	return s
		.replace(/^```json\s*/i, "")
		.replace(/^```\s*/, "")
		.replace(/\s*```$/, "")
		.trim();
}

async function transcribeFile(
	apiKey: string,
	filePath: string,
	model: string,
	prompt: string,
	responseFormat?: string,
): Promise<Record<string, unknown>> {
	const audioData = readFileSync(filePath);
	const form = new FormData();
	form.append(
		"file",
		new Blob([audioData], { type: "audio/m4a" }),
		"audio.m4a",
	);
	form.append("model", model);
	form.append("prompt", prompt);
	if (responseFormat) {
		form.append("response_format", responseFormat);
	}

	const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}` },
		body: form,
		signal: AbortSignal.timeout(120_000),
	});

	if (!resp.ok) {
		const errText = await resp.text();
		throw new Error(`Transcribe API error: ${errText}`);
	}

	return resp.json() as Promise<Record<string, unknown>>;
}

// Cheap script-based language detector used to replace Whisper's
// `verbose_json` language field (gpt-4o-transcribe returns plain `json`
// only — see https://developers.openai.com/api/docs/guides/speech-to-text#transcriptions).
// Returns "" when the script is ambiguous (Latin), which the caller
// treats as "don't filter".
function detectScriptLanguage(text: string): string {
	let han = 0;
	let hiraKata = 0;
	let hangul = 0;
	for (const ch of text) {
		const cp = ch.codePointAt(0) ?? 0;
		if ((cp >= 0x3040 && cp <= 0x309F) || (cp >= 0x30A0 && cp <= 0x30FF)) hiraKata++;
		else if (cp >= 0xAC00 && cp <= 0xD7AF) hangul++;
		else if (cp >= 0x4E00 && cp <= 0x9FFF) han++;
	}
	// Hiragana/katakana are unique to Japanese; any presence pins the language.
	if (hiraKata > 0) return "ja";
	if (hangul > 2) return "ko";
	// Han-only without kana → Chinese (kanji-only Japanese sentences are rare in dialogue).
	if (han > 2) return "zh";
	return "";
}

function isSelfVoice(transcript: string): boolean {
	const lower = transcript.toLowerCase();
	for (const speech of samuelRecentSpeech) {
		if (speech.includes(lower) || lower.includes(speech)) return true;
		if (lower.length > 5 && speech.length > 5) {
			let overlap = 0;
			for (const c of lower) {
				if (speech.includes(c)) overlap++;
			}
			const ratio = overlap / Math.max(lower.length, 1);
			if (ratio > 0.8 && lower.length > 10) return true;
		}
	}
	return false;
}

function isWhisperHallucination(text: string): boolean {
	const trimmed = text.trim();
	const charCount = [...trimmed].length;
	if (charCount <= 8) return true;

	const hallucinationMarkers = [
		"ご視聴ありがとうございました", "チャンネル登録", "お疲れ様でした",
		"ありがとうございました", "よろしくお願いします", "字幕は", "字幕作成",
		"Amara.org", "神の力", "主イエス", "聖霊", "魂に注入", "amen",
		"内緒だよ", "本当に", "そうですね", "なるほど", "どうしましたか", "ここで",
	];
	const lower = trimmed.toLowerCase();
	if (hallucinationMarkers.some((m) => lower.includes(m.toLowerCase()))) {
		return true;
	}

	// Repetition detection
	if (charCount > 10) {
		const chars = [...trimmed];
		const quarterLen = Math.floor(charCount / 4);
		if (quarterLen > 2) {
			const chunk = chars.slice(0, quarterLen).join("");
			if (chunk) {
				let count = 0;
				let idx = 0;
				while ((idx = trimmed.indexOf(chunk, idx)) !== -1) {
					count++;
					idx += chunk.length;
				}
				if (count >= 3) return true;
			}
		}
		const halfLen = Math.floor(charCount / 2);
		const first = chars.slice(0, halfLen).join("");
		const second = chars.slice(halfLen).join("");
		if (first === second) return true;
	}

	return false;
}

function audioHasSpeechEnergy(m4aPath: string): boolean {
	const probePcm = "/tmp/samuel-energy-probe.pcm";
	tryRemove(probePcm);

	try {
		execFileSync("ffmpeg", [
			"-y", "-i", m4aPath,
			"-ar", "16000", "-ac", "1", "-f", "s16le", probePcm,
		], { stdio: "ignore" });
	} catch {
		return true; // on error, let it through
	}

	let pcmData: Buffer;
	try {
		pcmData = readFileSync(probePcm);
	} catch {
		return true;
	}
	tryRemove(probePcm);

	if (pcmData.length < 1600) return false;

	const durationMs = (pcmData.length * 1000) / 32000;
	if (durationMs < 400) {
		console.error(`[learning-audio] too short (${Math.round(durationMs)}ms < 400ms), skipping`);
		return false;
	}

	let sumSq = 0;
	const sampleCount = Math.floor(pcmData.length / 2);
	for (let i = 0; i < pcmData.length - 1; i += 2) {
		const sample = pcmData.readInt16LE(i) / 32768.0;
		sumSq += sample * sample;
	}
	const rms = Math.sqrt(sumSq / sampleCount);
	const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -100;

	if (rmsDb < -40) {
		console.error(`[learning-audio] audio too quiet (RMS=${rmsDb.toFixed(1)}dB < -40dB), skipping Whisper`);
		return false;
	}

	console.error(`[learning-audio] energy OK (RMS=${rmsDb.toFixed(1)}dB, ${Math.round(durationMs)}ms)`);
	return true;
}

function convertToPcmBase64(m4aPath: string): string | null {
	const pcmPath = `${m4aPath}.pcm`;
	try {
		execFileSync("ffmpeg", [
			"-y", "-i", m4aPath,
			"-ar", "24000", "-ac", "1", "-f", "s16le", pcmPath,
		], { stdio: "ignore" });
	} catch {
		return null;
	}
	try {
		const pcmData = readFileSync(pcmPath);
		tryRemove(pcmPath);
		if (!pcmData.length) return null;
		return pcmData.toString("base64");
	} catch {
		return null;
	}
}

// Stop a child process and WAIT for it to actually exit. Critical for the
// audio recorder helper — its SIGTERM handler calls AVAssetWriter.finishWriting()
// to commit the moov atom, which can take 3-5s on a busy system. The old
// implementation busy-waited via execFileSync("sleep") which BLOCKED the
// event loop, so child.exitCode was NEVER updated (libuv processes 'exit'
// in the loop) — every stop hit the timeout and SIGKILL'd the helper
// mid-finalize, producing a moov-less m4a that ffmpeg can salvage but
// OpenAI's mp4 demuxer rejects as "Audio file might be corrupted or
// unsupported". The helper's internal finalize timeout is 5s, so we
// give it 8s here as a hard upper bound.
function stopChildProcessAsync(
	child: ChildProcess,
	timeoutSecs = 8,
): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return;
		}
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			resolve();
		};
		child.once("exit", finish);
		child.kill("SIGTERM");
		setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) {
				console.error(
					`[record-helper] finalize timeout after ${timeoutSecs}s — sending SIGKILL`,
				);
				child.kill("SIGKILL");
			}
			// Don't resolve here directly — the SIGKILL will fire 'exit' and
			// the listener above resolves naturally. As a safety net, resolve
			// after a short grace.
			setTimeout(finish, 500);
		}, timeoutSecs * 1000);
	});
}

// ── Learning audio internal ─────────────────────────────────────────────────

function startLearningAudioInternal(): void {
	if (learningAudioChild) return;
	if (recordingChild) return;

	const helper = findRecordHelper();
	tryRemove(LEARNING_AUDIO_PATH);

	const myPid = String(process.pid);
	learningAudioChild = spawn(helper, [
		LEARNING_AUDIO_PATH,
		"--exclude-pid", myPid,
		"--exclude-bundle", "com.samuel.assistant",
		"--exclude-bundle", "com.github.Electron",
	], { stdio: ["ignore", "ignore", "inherit"] });

	console.error(
		`[learning-audio] started pid=${learningAudioChild.pid} (excluding own pid=${myPid} + bundle)`,
	);

	learningAudioChild.on("exit", () => {
		learningAudioChild = null;
	});
}

async function stopLearningAudioInternal(): Promise<void> {
	if (!learningAudioChild) return;
	const child = learningAudioChild;
	learningAudioChild = null;
	await stopChildProcessAsync(child, 8);
	console.error("[learning-audio] stopped");
}

// ── URL encoding ────────────────────────────────────────────────────────────

function urlEncode(s: string): string {
	return encodeURIComponent(s).replace(/%20/g, "%20");
}

// ── HTML helpers ────────────────────────────────────────────────────────────

function extractHtmlTag(html: string, tag: string): string | null {
	const open = `<${tag}`;
	const close = `</${tag}>`;
	const start = html.indexOf(open);
	if (start === -1) return null;
	const gtIdx = html.indexOf(">", start);
	if (gtIdx === -1) return null;
	const afterOpen = gtIdx + 1;
	const end = html.indexOf(close, afterOpen);
	if (end === -1) return null;
	return html.slice(afterOpen, end).trim();
}

function stripHtmlToText(html: string): string {
	let out = "";
	let inTag = false;
	let i = 0;
	while (i < html.length) {
		if (html[i] === "<") {
			const rest = html.slice(i);
			if (rest.startsWith("<br>") || rest.startsWith("<br/>") || rest.startsWith("<br />")) {
				out += "\n";
				const gt = rest.indexOf(">");
				i += (gt >= 0 ? gt + 1 : 4);
				continue;
			}
			inTag = true;
			i++;
		} else if (html[i] === ">") {
			inTag = false;
			i++;
		} else if (!inTag) {
			out += html[i];
			i++;
		} else {
			i++;
		}
	}
	return out
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#x27;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

function htmlEntityDecode(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x27;/g, "'");
}

function extractReadableText(html: string): string {
	let text = html;
	// Remove script and style blocks
	text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
	text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
	// Block elements to newlines
	for (const tag of ["<br", "<p", "<div", "<li", "<h1", "<h2", "<h3", "<h4", "<tr"]) {
		text = text.split(tag).join(`\n${tag}`);
	}
	return stripHtmlToText(text)
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.join("\n");
}

// ── Exported commands ───────────────────────────────────────────────────────

export async function start_recording(): Promise<string> {
	const helper = findRecordHelper();
	if (recordingChild) throw new Error("Recording already in progress");

	tryRemove(RECORDING_PATH);

	recordingChild = spawn(helper, [RECORDING_PATH], {
		stdio: ["ignore", "ignore", "inherit"],
	});

	console.error(`[recording] started pid=${recordingChild.pid}`);
	recordingChild.on("exit", () => {
		recordingChild = null;
	});

	return "Recording started";
}

export async function stop_recording(): Promise<string> {
	if (!recordingChild) throw new Error("No recording in progress");

	const child = recordingChild;
	recordingChild = null;
	await stopChildProcessAsync(child, 8);

	console.error("[recording] stopped");

	if (!existsSync(RECORDING_PATH)) {
		throw new Error("Recording file not found — capture may have failed");
	}

	const size = statSync(RECORDING_PATH).size;
	console.error(`[recording] file size: ${(size / 1024).toFixed(1)}KB`);
	return RECORDING_PATH;
}

export async function analyze_recording(): Promise<RecordingAnalysis> {
	const config = readConfigInternal();
	const apiKey = config.apiKey;
	if (!apiKey) throw new Error("No API key configured");

	if (!existsSync(RECORDING_PATH)) {
		throw new Error("No recording file found — record first");
	}

	console.error("[recording] transcribing with gpt-4o-transcribe...");

	const whisperBody = await transcribeFile(
		apiKey, RECORDING_PATH, "gpt-4o-transcribe",
		"Transcribe the dialogue from this video/anime clip accurately. There may be background music and sound effects. Ignore any system messages at the very start like 'Recording has started'.",
	);

	if ((whisperBody as any).error) {
		throw new Error(`Transcribe API: ${(whisperBody as any).error.message ?? "unknown"}`);
	}

	const fullText: string = (whisperBody as any).text ?? "";

	// Split by sentence-ending punctuation
	const terminators = new Set(["。", "！", "？", "!", "?", "."]);
	const transcriptLines: ScriptLine[] = [];
	let current = "";
	for (const ch of fullText) {
		current += ch;
		if (terminators.has(ch)) {
			const trimmed = current.trim();
			if (trimmed) {
				transcriptLines.push({
					timestamp: `#${transcriptLines.length + 1}`,
					text: trimmed,
				});
			}
			current = "";
		}
	}
	const leftover = current.trim();
	if (leftover) {
		transcriptLines.push({
			timestamp: `#${transcriptLines.length + 1}`,
			text: leftover,
		});
	}

	if (!fullText) {
		return {
			transcript: transcriptLines,
			translated_transcript: [],
			vocabulary: [],
			grammar: [],
			summary: "No speech detected in the recording.",
		};
	}

	console.error(
		`[recording] transcript: ${fullText.length} chars, ${transcriptLines.length} segments — analyzing with GPT-4o...`,
	);

	// Step 2: Analyze with GPT-4o
	const analysisPrompt = `You are a language tutor. Analyze the following transcript from a video/anime clip. First detect what language is being spoken, then provide a full breakdown. The audio may contain background music/SFX — do your best.

NOTE: Ignore any system messages at the start (e.g. "Recording has started" or instructions about recording). Focus only on the actual dialogue.

Transcript:
${fullText}

Return a JSON object with exactly these fields:
{
  "translated_transcript": [
    { "original": "original line in source language", "translation": "English translation" }
  ],
  "vocabulary": [
    { "word": "original word", "reading": "pronunciation/reading aid", "meaning": "English meaning", "level": "proficiency level" }
  ],
  "grammar": [
    { "pattern": "grammar pattern name", "explanation": "Clear explanation in English", "examples": ["actual phrase from transcript that uses this pattern"] }
  ],
  "summary": "Brief English summary of what was said (2-3 sentences)"
}

Guidelines:
- Detect the language automatically from the transcript.
- For translated_transcript: include every meaningful dialogue line with its English translation.
- Include ALL meaningful vocabulary.
- For vocabulary: word in original script, reading/pronunciation aid, English meaning, proficiency level.
- For grammar: extract grammar patterns actually used in the transcript.
- Summary should explain the scene/conversation briefly in English.
- Return ONLY valid JSON, no markdown fences.`;

	const gptData = (await openaiChat(apiKey, "gpt-4o", [
		{ role: "user", content: analysisPrompt },
	], 4000, 0.3)) as any;

	const content = extractChatContent(gptData) || "{}";
	const cleaned = stripFences(content);

	let analysis: any;
	try {
		analysis = JSON.parse(cleaned);
	} catch {
		analysis = { vocabulary: [], grammar: [], summary: content };
	}

	const translatedTranscript: ScriptLine[] = (analysis.translated_transcript ?? [])
		.filter((t: any) => t.original)
		.map((t: any) => ({
			timestamp: t.original,
			text: t.translation ?? "",
		}));

	const vocabulary: VocabEntry[] = (analysis.vocabulary ?? [])
		.filter((v: any) => v.word)
		.map((v: any) => ({
			word: v.word,
			reading: v.reading ?? "",
			meaning: v.meaning ?? "",
			level: v.level ?? "—",
		}));

	const grammar: GrammarPoint[] = (analysis.grammar ?? [])
		.filter((g: any) => g.pattern)
		.map((g: any) => ({
			pattern: g.pattern,
			explanation: g.explanation ?? "",
			examples: Array.isArray(g.examples)
				? g.examples.filter((e: unknown) => typeof e === "string")
				: [],
		}));

	const summary: string = analysis.summary ?? "Analysis complete.";

	console.error(
		`[recording] analysis done: ${vocabulary.length} vocab, ${grammar.length} grammar points`,
	);

	return {
		transcript: transcriptLines,
		translated_transcript: translatedTranscript,
		vocabulary,
		grammar,
		summary,
	};
}

export async function transcribe_recording(): Promise<string> {
	const config = readConfigInternal();
	const apiKey = config.apiKey;
	if (!apiKey) throw new Error("No API key configured");

	if (!existsSync(RECORDING_PATH)) {
		throw new Error("No recording file found — record first");
	}

	console.error("[recording] transcribing with gpt-4o-transcribe...");

	const whisperBody = await transcribeFile(
		apiKey, RECORDING_PATH, "gpt-4o-transcribe",
		"Transcribe accurately. There may be background music and sound effects. Ignore system messages like 'Recording has started'.",
	);

	if ((whisperBody as any).error) {
		throw new Error(`Transcribe API: ${(whisperBody as any).error.message ?? "unknown"}`);
	}

	const text: string = (whisperBody as any).text ?? "";
	console.error(`[recording] transcript: ${text.length} chars`);
	return text;
}

export async function start_learning_audio(): Promise<void> {
	acquireAudioCapture("learning");
}

export async function stop_learning_audio(): Promise<void> {
	await releaseAudioCapture("learning");
}

export async function flush_learning_audio(): Promise<void> {
	// Force a fresh helper so the next chunk is bounded. Keep the consumer
	// set intact — flushing learning shouldn't tear down a watcher capture
	// that wants to keep running.
	if (audioConsumers.size > 0) {
		await stopLearningAudioInternal();
		tryRemove(LEARNING_AUDIO_PATH);
		startLearningAudioInternal();
	}
}

// Watcher counterparts — same underlying capture, separate consumer slot so
// learning mode and the watcher loop can hold the helper independently.
export async function start_watcher_audio(): Promise<void> {
	acquireAudioCapture("watcher");
}

export async function stop_watcher_audio(): Promise<void> {
	await releaseAudioCapture("watcher");
}

// Language-agnostic chunk read for the watcher loop. Strips the learning-mode
// language filter + vocab-hint generation since watch triggers can fire on
// any audio content (errors, voice tone, generic phrases, foreign-language
// passages …). Returns a simple `{transcript}` shape; null transcript means
// nothing usable this cycle (silence, hallucination, self-voice, race lost).
export async function check_watcher_audio(): Promise<{ transcript: string | null }> {
	const empty = { transcript: null };

	// Single-flight latch — both learning + watcher loops share LEARNING_AUDIO_PATH,
	// and only one of them may rotate the file per cycle. The other tries again
	// next tick.
	if (audioCheckInFlight) return empty;
	if (recordingChild) return empty;
	if (!audioConsumers.has("watcher")) return empty;

	const config = readConfigInternal();
	const apiKey = config.apiKey;
	if (!apiKey) return empty;

	audioCheckInFlight = true;
	try {
		await stopLearningAudioInternal();

		if (!existsSync(LEARNING_AUDIO_PATH)) {
			startLearningAudioInternal();
			return empty;
		}

		const size = statSync(LEARNING_AUDIO_PATH).size;
		if (size < 8000) {
			tryRemove(LEARNING_AUDIO_PATH);
			startLearningAudioInternal();
			return empty;
		}

		if (!audioHasSpeechEnergy(LEARNING_AUDIO_PATH)) {
			tryRemove(LEARNING_AUDIO_PATH);
			startLearningAudioInternal();
			return empty;
		}

		// Per OpenAI docs (https://developers.openai.com/api/docs/guides/speech-to-text#transcriptions),
		// gpt-4o-transcribe supports ONLY 'json' or 'text' response_format —
		// not 'verbose_json' (whisper-1 only). Pre-filters (audioHasSpeechEnergy
		// RMS check + isWhisperHallucination + isSelfVoice) cover the silence
		// case that no_speech_prob used to gate, so dropping the segment-level
		// signal is safe here.
		const whisperBody = await transcribeFile(
			apiKey, LEARNING_AUDIO_PATH, "gpt-4o-transcribe",
			"Transcribe the audio accurately. Focus on spoken words; ignore background music or sound effects. If no speech, return empty.",
		);

		tryRemove(LEARNING_AUDIO_PATH);
		startLearningAudioInternal();

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const transcript = ((whisperBody as any).text ?? "").trim();
		if (!transcript || transcript.length < 5) return empty;

		if (isWhisperHallucination(transcript)) {
			console.error(`[watcher-audio] filtered hallucination: ${truncateStr(transcript, 80)}`);
			return empty;
		}
		if (isSelfVoice(transcript)) {
			console.error(`[watcher-audio] filtered self-voice: ${truncateStr(transcript, 80)}`);
			return empty;
		}

		console.error(`[watcher-audio] transcript: ${truncateStr(transcript, 120)}`);
		return { transcript };
	} catch (err) {
		console.error(`[watcher-audio] check failed: ${err instanceof Error ? err.message : err}`);
		return empty;
	} finally {
		audioCheckInFlight = false;
	}
}

export async function check_learning_audio(args: {
	language: string;
}): Promise<AudioCheckResult> {
	const empty: AudioCheckResult = {
		transcript: null,
		hint: null,
		pcm_audio_base64: null,
	};

	const config = readConfigInternal();
	const apiKey = config.apiKey;
	if (!apiKey) throw new Error("No API key");

	if (recordingChild) return empty;
	// Yield to the watcher loop if it's mid-cycle on the same audio file.
	// This call already gets retried every CHECK_INTERVAL_MS by useLearningMode.
	if (audioCheckInFlight) return empty;

	// Body kept at the existing indentation to minimize diff churn — the
	// try/finally only exists to release the audioCheckInFlight latch on
	// every exit path, including thrown exceptions and early returns.
	audioCheckInFlight = true;
	try {
	await stopLearningAudioInternal();

	if (!existsSync(LEARNING_AUDIO_PATH)) {
		startLearningAudioInternal();
		return empty;
	}

	const size = statSync(LEARNING_AUDIO_PATH).size;
	if (size < 8000) {
		tryRemove(LEARNING_AUDIO_PATH);
		startLearningAudioInternal();
		if (size > 0) {
			console.error(`[learning-audio] clip too small (${(size / 1024).toFixed(1)}KB < 8KB threshold), skipping`);
		}
		return empty;
	}

	console.error(`[learning-audio] clip: ${(size / 1024).toFixed(1)}KB`);

	if (!audioHasSpeechEnergy(LEARNING_AUDIO_PATH)) {
		tryRemove(LEARNING_AUDIO_PATH);
		startLearningAudioInternal();
		return empty;
	}

	console.error("[learning-audio] transcribing...");

	const targetLangCode: Record<string, string> = {
		japanese: "ja", chinese: "zh", mandarin: "zh", korean: "ko",
		spanish: "es", french: "fr", german: "de", italian: "it", portuguese: "pt",
	};
	const langCode = targetLangCode[args.language.toLowerCase()] ?? "ja";

	// Per OpenAI docs (https://developers.openai.com/api/docs/guides/speech-to-text#transcriptions),
	// gpt-4o-transcribe supports ONLY 'json' or 'text' response_format —
	// not 'verbose_json' (whisper-1 only). We lose Whisper's internal
	// language detection and segment-level no_speech_prob; we cover both
	// with cheaper alternatives below (script-based language guess +
	// existing energy/hallucination/self-voice filters).
	const whisperBody = await transcribeFile(
		apiKey, LEARNING_AUDIO_PATH, "gpt-4o-transcribe",
		"Transcribe the dialogue speech accurately. There may be background music and sound effects — focus on the spoken words only. If no speech, return empty.",
	);

	const pcmBase64 = convertToPcmBase64(LEARNING_AUDIO_PATH);
	if (pcmBase64) {
		console.error("[learning-audio] converted to PCM16 24kHz for realtime injection");
	}

	tryRemove(LEARNING_AUDIO_PATH);
	startLearningAudioInternal();

	const transcript = ((whisperBody as any).text ?? "").trim();

	if (!transcript || transcript.length < 5) {
		console.error("[learning-audio] no speech detected");
		return empty;
	}

	// Script-based language guess. Cheap and reliable for CJK targets
	// (the Unicode blocks below are language-unique). For Latin-script
	// targets (es/fr/de/it/pt) we don't filter — the watch trigger will
	// fire and the language-aware hint generator downstream rejects
	// non-target audio anyway.
	const detectedLang = detectScriptLanguage(transcript);
	if (detectedLang) {
		console.error(`[learning-audio] script-detected language: ${detectedLang}`);
	}

	const langMatchesTarget = !detectedLang
		|| detectedLang === langCode
		|| (langCode === "zh" && detectedLang === "zh");
	if (!langMatchesTarget) {
		console.error(`[learning-audio] detected '${detectedLang}' but target is '${langCode}', skipping watch triggers`);
		return {
			transcript,
			hint: null,
			pcm_audio_base64: pcmBase64,
		};
	}

	if (isWhisperHallucination(transcript)) {
		console.error(`[learning-audio] filtered hallucination: ${truncateStr(transcript, 80)}`);
		return empty;
	}

	if (isSelfVoice(transcript)) {
		console.error(`[learning-audio] filtered self-voice: ${truncateStr(transcript, 80)}`);
		return empty;
	}

	// Filter self-talk markers
	const lower = transcript.toLowerCase();
	const selfTalkMarkers = [
		"sir,", "sir.", "understood, sir", "certainly, sir",
		"how may i assist", "shall i", "let me explain", "let me look",
		"let me check", "let me find", "let me search", "let me help",
		"i'll keep that", "i'll look into", "i'll help", "i'll search",
		"good evening", "good morning", "good afternoon",
		"in japanese that", "in japanese it", "in japanese,",
		"in chinese that", "in chinese it", "in chinese,",
		"in korean that", "in korean it", "in korean,",
		"means '", 'means "', "which means",
		"i heard", "the term", "the word",
		"i can't accurately", "i can't determine", "i can't see",
		"i can't identify", "i don't have the ability",
		"i don't have exact", "i currently can't",
		"from the audio alone", "without clear context",
		"if you'd like, i can", "if you share",
		"would you like me to", "is there anything",
		"i can assist", "i can help", "i can take a look",
		"based on the earlier context",
	];
	if (selfTalkMarkers.some((m) => lower.includes(m))) {
		console.error(`[learning-audio] filtered self-talk: ${truncateStr(transcript, 80)}`);
		return empty;
	}

	// Heuristic: mostly English but target is non-Latin
	const asciiCount = [...lower].filter((c) => c.charCodeAt(0) < 128).length;
	const asciiRatio = asciiCount / Math.max([...lower].length, 1);
	const nonLatinTargets = ["ja", "zh", "ko"];
	if (nonLatinTargets.includes(langCode) && asciiRatio > 0.85 && transcript.length > 20) {
		console.error(`[learning-audio] filtered English audio (${Math.round(asciiRatio * 100)}% ASCII): ${truncateStr(transcript, 80)}`);
		return empty;
	}

	console.error(`[learning-audio] transcript: ${truncateStr(transcript, 120)}`);

	memoryRecordTranscript(transcript);

	const analysisPrompt = `You heard the following audio transcript. Help a ${args.language} learner.
CRITICAL RULE: You may ONLY pick words or phrases that appear VERBATIM in the transcript below. NEVER infer, paraphrase, summarize, or suggest related concepts that are not explicitly present in the text.

PRIORITY 1: If it contains ${args.language} speech, pick 1-2 interesting words or grammar patterns that appear in the transcript and explain them briefly (2-3 sentences, voice-friendly).
PRIORITY 2: If the speech is in English (or another non-${args.language} language), find an interesting word or phrase that was actually said and teach the ${args.language} equivalent.
IMPORTANT FILTERS:
- ONLY use words/phrases that appear verbatim in the transcript.
- NEVER pick character names, proper nouns, or names of people/places.
- NEVER pick common loanwords the learner already knows from English.
- Pick something specific, contextual, and genuinely useful.
Only respond NONE if the transcript is just noise, music, names only, trivial loanwords, or too short.

Transcript: ${transcript}`;

	const gptData = (await openaiChat(apiKey, "gpt-4o-mini", [
		{
			role: "system",
			content: `You are a ${args.language} learning assistant. Keep responses very short and voice-friendly. CRITICAL: If the transcript appears to be an AI assistant speaking rather than actual ${args.language} media content, respond with NONE.`,
		},
		{ role: "user", content: analysisPrompt },
	], 200, 0.3)) as any;

	const hint = extractChatContent(gptData) || "NONE";

	console.error(`[learning-audio] hint: ${truncateStr(hint, 100)}`);

	const hintVal = hint === "NONE" || hint.toUpperCase().startsWith("NONE") ? null : hint;

	return {
		transcript,
		hint: hintVal,
		pcm_audio_base64: pcmBase64,
	};
	} finally {
		audioCheckInFlight = false;
	}
}

export async function check_screen_for_language(args: {
	language: string;
}): Promise<string | null> {
	const config = readConfigInternal();
	const apiKey = config.apiKey;
	if (!apiKey) throw new Error("No API key configured");

	const capture = captureFocusedWindowSync();
	const b64 = capture.base64;
	if (b64.length < 100) return null;

	const currentHash = hashBytes(Buffer.from(b64));
	const currentApp = getFrontmostAppName();
	const now = nowSecs();

	const sameHash = screenStateLastHash === currentHash;
	const sameApp = screenStateLastApp === currentApp;
	const recent = now - screenStateLastAnalysis < 90;
	if (sameHash && sameApp && recent) {
		console.error(`[learning-mode] screen unchanged (app=${currentApp}, ${now - screenStateLastAnalysis}s ago), skipping GPT-4o`);
		return null;
	}

	screenStateLastHash = currentHash;
	screenStateLastApp = currentApp;
	screenStateLastAnalysis = now;

	const prompt = `Scan this screenshot for a ${args.language} learner.
CRITICAL RULE: You may ONLY pick words or text that are ACTUALLY VISIBLE on the screenshot. NEVER invent, infer, or suggest vocabulary that is not literally on screen.

PRIORITY 1: If you find ${args.language} text (subtitles, UI, articles, chat), pick 1-2 interesting words or grammar patterns that are visible on screen and explain them briefly (2-3 sentences, voice-friendly).
PRIORITY 2: If there is interesting English text or a clearly identifiable concept visible on screen, teach the ${args.language} equivalent. Frame it as: "Do you know how to say [X] in ${args.language}? It's [word/phrase] ([reading])."
IMPORTANT FILTERS:
- ONLY reference text or objects that are ACTUALLY VISIBLE in the screenshot.
- If the screen has Chinese/Korean/other non-${args.language} text, respond NONE.
- NEVER pick character names, proper nouns, or names of people/places.
- NEVER pick common loanwords the learner already knows from English.
- NEVER suggest generic vocabulary unrelated to the screen.
- Pick something specific, visually prominent, and genuinely useful.
Respond NONE if: the screen is empty, a plain desktop, has only names, has only non-${args.language} text, or has nothing genuinely teachable.`;

	const bodyPath = "/tmp/samuel-learning-req.json";
	const requestBody = {
		model: "gpt-4o",
		messages: [
			{
				role: "system",
				content: `You are a ${args.language} language learning assistant. You scan screenshots and highlight interesting vocabulary or grammar for a learner. Keep responses very short and suitable for a voice assistant.`,
			},
			{
				role: "user",
				content: [
					{ type: "text", text: prompt },
					{
						type: "image_url",
						image_url: {
							url: `data:image/jpeg;base64,${b64}`,
							detail: "low",
						},
					},
				],
			},
		],
		max_tokens: 300,
	};

	writeFileSync(bodyPath, JSON.stringify(requestBody));

	try {
		const resp = await fetch("https://api.openai.com/v1/chat/completions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: readFileSync(bodyPath, "utf-8"),
			signal: AbortSignal.timeout(20_000),
		});

		tryRemove(bodyPath);

		if (!resp.ok) throw new Error(`curl failed: ${await resp.text()}`);

		const data = await resp.json();
		if (data.error) return null;

		const text = (data?.choices?.[0]?.message?.content ?? "NONE").trim();
		console.error(`[learning-mode] screen check result: ${truncateStr(text, 100)}`);

		if (text === "NONE" || text.toUpperCase().startsWith("NONE")) return null;
		return text;
	} catch (err) {
		tryRemove(bodyPath);
		throw err;
	}
}

export async function check_screen_text(): Promise<string | null> {
	const config = readConfigInternal();
	const apiKey = config.apiKey;
	if (!apiKey) throw new Error("No API key configured");

	const capture = captureFocusedWindowSync();
	const b64 = capture.base64;
	if (b64.length < 100) return null;

	const currentHash = hashBytes(Buffer.from(b64));
	const currentApp = getFrontmostAppName();
	const now = nowSecs();

	const sameHash = watcherScreenLastHash === currentHash;
	const sameApp = watcherScreenLastApp === currentApp;
	const recent = now - watcherScreenLastAnalysis < 90;
	if (sameHash && sameApp && recent) return null;

	watcherScreenLastHash = currentHash;
	watcherScreenLastApp = currentApp;
	watcherScreenLastAnalysis = now;

	const requestBody = {
		model: "gpt-4o-mini",
		messages: [
			{
				role: "system",
				content:
					"Describe the visible text and key visual content on this screenshot in 2-3 sentences. " +
					"Focus on readable text (titles, labels, subtitles, messages, code). " +
					"Be factual and concise. If the screen is a plain desktop or has no meaningful content, say NONE.",
			},
			{
				role: "user",
				content: [
					{ type: "text", text: "What text and content is visible on this screen?" },
					{
						type: "image_url",
						image_url: {
							url: `data:image/jpeg;base64,${b64}`,
							detail: "low",
						},
					},
				],
			},
		],
		max_tokens: 200,
	};

	const bodyPath = "/tmp/samuel-watcher-screen-req.json";
	writeFileSync(bodyPath, JSON.stringify(requestBody));

	try {
		const resp = await fetch("https://api.openai.com/v1/chat/completions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: readFileSync(bodyPath, "utf-8"),
			signal: AbortSignal.timeout(10_000),
		});

		tryRemove(bodyPath);

		if (!resp.ok) throw new Error(`curl failed: ${await resp.text()}`);

		const data = await resp.json();
		if (data.error) return null;

		const text = (data?.choices?.[0]?.message?.content ?? "NONE").trim();
		console.error(`[watcher] screen text: ${truncateStr(text, 100)}`);

		if (text === "NONE" || text.toUpperCase().startsWith("NONE")) return null;
		return text;
	} catch (err) {
		tryRemove(bodyPath);
		throw err;
	}
}

export async function check_audio_for_language(args: {
	language: string;
	duration_secs?: number;
}): Promise<string | null> {
	const config = readConfigInternal();
	const apiKey = config.apiKey;
	if (!apiKey) throw new Error("No API key configured");

	if (recordingChild) return null;

	const helper = findRecordHelper();
	const clipPath = "/tmp/samuel-learning-clip.m4a";
	const duration = args.duration_secs ?? 8;

	tryRemove(clipPath);

	const child = spawn(helper, [clipPath], {
		stdio: ["ignore", "ignore", "inherit"],
	});

	console.error(`[learning-mode] audio clip recording for ${duration}s...`);

	// Wait for duration
	await new Promise((resolve) => setTimeout(resolve, duration * 1000));

	// Use the shared async stop — gives the helper its full 5s finalize
	// budget plus a 3s safety margin before SIGKILL. Old code used a 3s
	// hard cap which interrupted moov-atom writes on busy systems and
	// produced unparseable m4a files.
	await stopChildProcessAsync(child, 8);

	if (!existsSync(clipPath)) {
		console.error("[learning-mode] audio clip not created");
		return null;
	}

	const size = statSync(clipPath).size;
	if (size < 1000) {
		tryRemove(clipPath);
		console.error(`[learning-mode] audio clip too small (${size}B), skipping`);
		return null;
	}

	console.error(`[learning-mode] audio clip: ${(size / 1024).toFixed(1)}KB, transcribing...`);

	const whisperBody = await transcribeFile(
		apiKey, clipPath, "gpt-4o-mini-transcribe",
		"Transcribe any speech in this audio clip. There may be background music and sound effects. If there is no speech, return empty.",
	);

	tryRemove(clipPath);

	const transcript = ((whisperBody as any).text ?? "").trim();

	if (!transcript || transcript.length < 5) {
		console.error("[learning-mode] audio: no speech detected");
		return null;
	}

	console.error(`[learning-mode] audio transcript: ${truncateStr(transcript, 120)}`);

	const analysisPrompt = `Analyze this audio transcript for ${args.language} learners.
If it contains ${args.language} speech, extract ALL notable words with their proficiency level.
If the transcript is NOT in ${args.language}, or is just music/noise/English, respond with exactly: NONE

Return JSON:
{
  "hint": "Brief voice-friendly explanation of 1-2 most interesting words (2-3 sentences max)",
  "words": [
    { "word": "original", "reading": "pronunciation aid", "meaning": "English meaning", "level": "N1/N2/N3/N4/N5" }
  ]
}

Rules:
- For Japanese, use JLPT levels (N5=easiest, N1=hardest)
- Include ALL ${args.language} words you can identify
- Be accurate with levels
- SKIP character names and proper nouns
- Return ONLY valid JSON, no markdown fences. Or exactly "NONE".

Transcript: ${transcript}`;

	const gptData = (await openaiChat(apiKey, "gpt-4o-mini", [
		{
			role: "system",
			content: `You are a ${args.language} language learning assistant. You analyze audio transcripts and extract vocabulary with accurate proficiency levels. Return structured JSON.`,
		},
		{ role: "user", content: analysisPrompt },
	], 500, 0.2)) as any;

	const hint = extractChatContent(gptData) || "NONE";
	console.error(`[learning-mode] audio analysis: ${truncateStr(hint, 100)}`);

	if (hint === "NONE" || hint.toUpperCase().startsWith("NONE")) return null;
	return hint;
}

export async function get_attention_state(): Promise<string> {
	const app = getFrontmostAppName();
	if (!app) return "available";
	for (const focusApp of FOCUS_APPS) {
		if (app.toLowerCase() === focusApp.toLowerCase() || app.includes(focusApp)) {
			return "focused";
		}
	}
	return "available";
}

export async function triage_observation(args: {
	summary: string;
	language: string;
	screen_b64?: string;
	audio_text?: string;
	source?: string;
	observation?: string;
}): Promise<TriageDecision> {
	const config = readConfigInternal();
	const apiKey = config.apiKey;
	if (!apiKey) throw new Error("No API key");

	const source = args.source ?? "screen";
	const observation = args.observation ?? args.summary;

	const memoryContext = memoryGetContext();
	const attention = getFrontmostAppName();

	memoryRecordObservation(`[${source}] ${truncateStr(observation, 80)}`);

	const prompt = `You are deciding whether Samuel, a proactive AI learning companion, should speak up.

User is learning: ${args.language}
Current app: ${attention}
Memory context: ${memoryContext}
Source: ${source} (screen = visual, audio = overheard speech)

Observation:
${observation}

Decide what to do. Return JSON ONLY:
{
  "reasoning": "1-sentence step-by-step reasoning",
  "classification": "ignore|notify|act",
  "confidence": 0.0-1.0,
  "message": "what Samuel should say if not ignore. null if ignore."
}

Rules:
- "ignore": Not useful. Background noise, already-taught vocabulary, a plain empty desktop, or truly generic content.
- "notify": Mildly interesting. A vocabulary word, common phrase, or a "do you know how to say X in ${args.language}?" moment.
- "act": Genuinely interesting and specific. A new word, unusual grammar, or a great cross-language teaching moment. Worth speaking aloud.
- Be conservative — silence (ignore) is better than interrupting needlessly.
- ALWAYS ignore character names, proper nouns, and names of fictional or real people/places.
- ALWAYS ignore observations that look like Samuel's own speech echoed back.
- Only "act" for truly specific, helpful observations.`;

	const data = (await openaiChat(apiKey, "gpt-4o-mini", [
		{ role: "user", content: prompt },
	], 200, 0.2)) as any;

	const content = extractChatContent(data) || "{}";
	const cleaned = stripFences(content);

	let parsed: any;
	try {
		parsed = JSON.parse(cleaned);
	} catch {
		parsed = {};
	}

	const classification = parsed.classification ?? "ignore";
	const confidence = parsed.confidence ?? 0;
	const message = parsed.message ?? observation;

	console.error(
		`[triage] ${classification} (conf=${confidence.toFixed(2)}): ${truncateStr(message, 80)}`,
	);

	if (classification !== "ignore") {
		const words = message
			.split(/\s+/)
			.filter((w: string) => [...w].some((c) => c.charCodeAt(0) > 127))
			.map((w: string) => w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ""))
			.filter((w: string) => w.length > 0);
		if (words.length > 0) {
			memoryRecordVocabulary(words);
		}
	}

	return { classification, confidence, message };
}

export async function record_samuel_speech(args: {
	text: string;
}): Promise<void> {
	if (!args.text.trim()) return;
	samuelRecentSpeech.push(args.text.toLowerCase());
	if (samuelRecentSpeech.length > MAX_SPEECH_BUFFER) {
		samuelRecentSpeech.shift();
	}
}

export async function append_transcript_window(args: {
	text: string;
}): Promise<void> {
	transcriptWindow.push(args.text);
	if (transcriptWindow.length > 20) {
		transcriptWindow.splice(0, transcriptWindow.length - 20);
	}
}

export async function assess_viewing_session(args: {
	language: string;
}): Promise<ViewingAssessment> {
	const config = readConfigInternal();
	const apiKey = config.apiKey;
	if (!apiKey) throw new Error("No API key");

	if (!transcriptWindow.length) {
		return { classification: "silent", message: "", confidence: 0 };
	}

	const transcriptText = transcriptWindow.join("\n");
	const memoryContext = memoryGetContext();

	const prompt = `You are Samuel's viewing advisor. The user is learning ${args.language} by watching anime/video.

User context: ${memoryContext}

Recent transcript from the past ~5 minutes of audio:
---
${transcriptText}
---

Assess the viewing situation. Return JSON ONLY:
{
  "classification": "silent|too_hard|too_easy|repetition|good_match|suggestion",
  "message": "what Samuel should say, in character as a butler. null if silent.",
  "confidence": 0.0-1.0
}

Classification guide:
- "silent" (DEFAULT — use this 70%+ of the time): Nothing worth commenting on.
- "too_hard": The dialogue uses vocabulary/grammar well above the user's stated level.
- "too_easy": Content is clearly below their level.
- "repetition": User has watched this exact content multiple times.
- "good_match": Content difficulty matches their level well. Only say this ONCE per session.
- "suggestion": The user might benefit from switching content.

CRITICAL RULES:
- Default to "silent". Silence is usually the right answer.
- Never be condescending.
- If the user hasn't stored a proficiency level yet, ALWAYS return "silent".
- If message is not null, write it as Samuel would speak: "Sir, ...", brief, one sentence max.`;

	const data = (await openaiChat(apiKey, "gpt-4o-mini", [
		{ role: "user", content: prompt },
	], 200, 0.2)) as any;

	const content = extractChatContent(data) || "{}";
	const cleaned = stripFences(content);

	let parsed: any;
	try {
		parsed = JSON.parse(cleaned);
	} catch {
		parsed = {};
	}

	const classification = parsed.classification ?? "silent";
	const confidence = parsed.confidence ?? 0;
	const message = parsed.message ?? "";

	console.error(
		`[viewing-assess] ${classification} (conf=${confidence.toFixed(2)}): ${truncateStr(message, 80)}`,
	);

	return { classification, message, confidence };
}

export async function transcribe_audio(args: {
	audio_base64: string;
	extension: string;
}): Promise<string> {
	const config = readConfigInternal();
	const apiKey = config.apiKey;
	if (!apiKey) throw new Error("No API key in ~/.books-reader.json");

	const audioBytes = Buffer.from(args.audio_base64, "base64");
	const ext = args.extension || "mp4";
	const tmpPath = `/tmp/samuel-wake-audio.${ext}`;
	writeFileSync(tmpPath, audioBytes);

	const debugPath = `/tmp/samuel-wake-debug.${ext}`;
	try { copyFileSync(tmpPath, debugPath); } catch { /* ignore */ }

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

	const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}` },
		body: form,
		signal: AbortSignal.timeout(10_000),
	});

	tryRemove(tmpPath);

	if (!resp.ok) {
		const errText = await resp.text();
		throw new Error(`Whisper API error: ${errText}`);
	}

	const body = await resp.json();
	if (body.error) {
		throw new Error(`Whisper API: ${body.error.message ?? "unknown"}`);
	}

	const text: string = body.text ?? "";
	console.error(`[wake] whisper: "${text}"`);
	return text;
}

export async function web_search(args: {
	query: string;
	page?: number;
}): Promise<SearchResult[]> {
	const pg = Math.max(args.page ?? 1, 1);
	console.error(`[web] searching: ${args.query} (page ${pg})`);

	// Try Brave HTML fallback directly (SerpAPI requires secrets module)
	const results = await searchBrave(args.query);
	console.error(`[web] brave: ${results.length} results`);
	return results;
}

async function searchBrave(query: string): Promise<SearchResult[]> {
	const encoded = urlEncode(query);
	const url = `https://search.brave.com/search?q=${encoded}`;

	const resp = await fetch(url, {
		headers: {
			"User-Agent":
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			Accept: "text/html,application/xhtml+xml",
		},
		signal: AbortSignal.timeout(10_000),
	});

	if (!resp.ok) throw new Error("Brave search request failed");

	const html = await resp.text();
	return parseBraveResults(html);
}

function parseBraveResults(html: string): SearchResult[] {
	const results: SearchResult[] = [];
	const marker = "search-snippet-title";
	let pos = 0;

	while (true) {
		const idx = html.indexOf(marker, pos);
		if (idx === -1) break;

		const region = html.slice(idx, Math.min(idx + 500, html.length));

		// Extract title
		const titleMatch = region.match(/title="([^"]*)"/);
		const title = titleMatch ? htmlEntityDecode(titleMatch[1]) : null;

		// Extract URL from preceding href
		const beforeStart = Math.max(0, idx - 500);
		const before = html.slice(beforeStart, idx);
		const hrefIdx = before.lastIndexOf('href="https://');
		let url: string | null = null;
		if (hrefIdx !== -1) {
			const start = hrefIdx + 6;
			const endQuote = before.indexOf('"', start);
			if (endQuote !== -1) {
				url = before.slice(start, endQuote);
			}
		}

		if (title && url && !url.includes("brave.com") && !url.includes("cdn.search")) {
			if (!results.some((r) => r.url === url)) {
				results.push({ title, url, snippet: "" });
				if (results.length >= 8) break;
			}
		}

		pos = idx + marker.length;
	}

	return results;
}

export async function web_search_openai(args: {
	query: string;
}): Promise<DeepSearchResult> {
	console.error(`[web] openai deep search: ${args.query}`);
	const config = readConfigInternal();
	const apiKey = config.apiKey;
	if (!apiKey) throw new Error("No OpenAI API key configured");

	const body = {
		model: "gpt-4o-mini",
		tools: [{ type: "web_search" }],
		input: args.query,
	};

	const resp = await fetch("https://api.openai.com/v1/responses", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});

	if (!resp.ok) {
		const errText = await resp.text();
		throw new Error(`OpenAI web search request failed: ${errText}`);
	}

	const json = await resp.json();
	if (json.error) {
		throw new Error(`OpenAI API error: ${json.error.message ?? "unknown error"}`);
	}

	let answer = "";
	const sources: string[] = [];

	if (Array.isArray(json.output)) {
		for (const item of json.output) {
			if (item.type === "message" && Array.isArray(item.content)) {
				for (const block of item.content) {
					if (block.text) answer += block.text;
					if (Array.isArray(block.annotations)) {
						for (const ann of block.annotations) {
							if (ann.type === "url_citation" && ann.url && !sources.includes(ann.url)) {
								sources.push(ann.url);
							}
						}
					}
				}
			}
		}
	}

	if (!answer) throw new Error("OpenAI web search returned no answer");

	console.error(`[web] openai deep search: ${answer.length} chars, ${sources.length} sources`);
	return { answer, sources };
}

export async function web_read(args: { url: string }): Promise<string> {
	console.error(`[web] reading: ${args.url}`);

	const resp = await fetch(args.url, {
		headers: {
			"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
		},
		signal: AbortSignal.timeout(15_000),
	});

	if (!resp.ok) throw new Error("Failed to fetch page");

	const html = await resp.text();
	const title = extractHtmlTag(html, "title") ?? "";
	const text = extractReadableText(html);

	let result = "";
	if (title) result += title + "\n\n";

	if (text.length > 12_000) {
		result += text.slice(0, 12_000) + "\n\n[Truncated — page is very long]";
	} else {
		result += text;
	}

	console.error(`[web] extracted ${result.length} chars`);
	return result;
}
