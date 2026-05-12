// Shared watcher-evaluation pipeline used by both ambient hooks
// (useLearningMode + useWatcherLoop). Keeps the trigger-fan-out logic in
// exactly one place so the two hooks can't drift on dedup / digest / reset
// behaviour.

import { invoke } from "./invoke-bridge";
import { sendTextAndRespond } from "./session-bridge";

export interface WatchCheckMatch {
	id: string;
	description: string;
	message_template: string;
}

export interface ClassifierMatch {
	watch_id: string;
	description: string;
	message_template: string;
	detail: string;
}

export interface WatchAlert {
	id: string;
	condition_type: string;
	source: string;
	enabled: boolean;
}

interface EvalArgs {
	audioText?: string; // empty string means "did not sample audio this tick"
	screenText?: string; // ditto
}

interface EvalResult {
	triggerCount: number;
}

/**
 * Run the three-tier watcher evaluation against newly captured content and
 * fire matched triggers as a single synthetic turn.
 *
 *  - Tier 1: keyword (`watch_check`) — deterministic.
 *  - Tier 2: classifier (`watch_evaluate_classifier`) — small model.
 *  - Tier 3: digest (`watch_flush_digests`) — time-based grouped delivery,
 *    runs every tick regardless of fresh content.
 *
 * `watch_reset_unmatched` is called for any source that was actually sampled
 * this tick, so debounce-armed watches don't slowly accumulate pending state
 * across non-matching ticks.
 */
export async function runWatchEvaluation({
	audioText = "",
	screenText = "",
}: EvalArgs): Promise<EvalResult> {
	const seenIds = new Set<string>();
	const seenMsgs = new Set<string>();
	const triggerMessages: string[] = [];
	const pushMsg = (id: string, raw: string) => {
		if (seenIds.has(id)) return;
		seenIds.add(id);
		const norm = raw.toLowerCase().replace(/\s+/g, " ").trim();
		if (seenMsgs.has(norm)) return;
		seenMsgs.add(norm);
		triggerMessages.push(raw);
	};

	const matchedAudio = new Set<string>();
	const matchedScreen = new Set<string>();
	const hasAudio = audioText.length > 0;
	const hasScreen = screenText.length > 0;

	if (hasAudio || hasScreen) {
		const [audioKw, screenKw] = await Promise.all([
			hasAudio
				? invoke<WatchCheckMatch[]>("watch_check", { text: audioText, source: "audio" })
						.catch(() => [] as WatchCheckMatch[])
				: Promise.resolve([] as WatchCheckMatch[]),
			hasScreen
				? invoke<WatchCheckMatch[]>("watch_check", { text: screenText, source: "screen" })
						.catch(() => [] as WatchCheckMatch[])
				: Promise.resolve([] as WatchCheckMatch[]),
		]);
		for (const m of audioKw) matchedAudio.add(m.id);
		for (const m of screenKw) matchedScreen.add(m.id);
		for (const m of [...audioKw, ...screenKw]) {
			pushMsg(m.id, m.message_template || m.description);
		}

		const [audioCls, screenCls] = await Promise.all([
			hasAudio
				? invoke<ClassifierMatch[]>("watch_evaluate_classifier", {
						content: audioText,
						source: "audio",
					}).catch(() => [] as ClassifierMatch[])
				: Promise.resolve([] as ClassifierMatch[]),
			hasScreen
				? invoke<ClassifierMatch[]>("watch_evaluate_classifier", {
						content: screenText,
						source: "screen",
					}).catch(() => [] as ClassifierMatch[])
				: Promise.resolve([] as ClassifierMatch[]),
		]);
		for (const m of audioCls) matchedAudio.add(m.watch_id);
		for (const m of screenCls) matchedScreen.add(m.watch_id);
		for (const m of [...audioCls, ...screenCls]) {
			const msg = m.message_template
				? m.message_template.replace("{detail}", m.detail)
				: `${m.description}: ${m.detail}`;
			pushMsg(m.watch_id, msg);
		}
	}

	// Reset pending_since for sources we actually sampled — only.
	await Promise.all([
		hasAudio
			? invoke("watch_reset_unmatched", {
					source: "audio",
					matched_ids: Array.from(matchedAudio),
				}).catch(() => {})
			: Promise.resolve(),
		hasScreen
			? invoke("watch_reset_unmatched", {
					source: "screen",
					matched_ids: Array.from(matchedScreen),
				}).catch(() => {})
			: Promise.resolve(),
	]);

	// Tier 3: digest flush — always runs, regardless of fresh content.
	const [audioDigest, screenDigest] = await Promise.all([
		invoke<ClassifierMatch[]>("watch_flush_digests", { source: "audio" })
			.catch(() => [] as ClassifierMatch[]),
		invoke<ClassifierMatch[]>("watch_flush_digests", { source: "screen" })
			.catch(() => [] as ClassifierMatch[]),
	]);
	for (const m of [...audioDigest, ...screenDigest]) {
		const msg = m.message_template
			? m.message_template.replace("{detail}", m.detail)
			: `${m.description}: ${m.detail}`;
		pushMsg(m.watch_id, msg);
	}

	if (triggerMessages.length > 0) {
		const ctxParts: string[] = [];
		if (audioText) ctxParts.push(`audio: ${audioText}`);
		if (screenText) ctxParts.push(`screen: ${screenText}`);
		const ctx = ctxParts.length ? `\n\nContext — ${ctxParts.join(" | ")}` : "";
		sendTextAndRespond(
			`[TRIGGER ALERT] The following watches just matched:\n` +
				triggerMessages.map((m, i) => `${i + 1}. ${m}`).join("\n") +
				`${ctx}\n\n` +
				`Briefly notify the user about what you detected. Be specific. Keep it to 1-2 sentences per trigger.`,
		);
	}

	return { triggerCount: triggerMessages.length };
}
