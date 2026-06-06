import { useEffect, useState, useCallback } from "react";
import { invoke } from "../lib/invoke-bridge";

// Trial status payload returned by the proxy worker (see proxy/src/index.ts).
interface TrialStatus {
	mode: "trial" | "byok" | "no_proxy" | "proxy_error";
	day?: string;
	usage?: Record<string, { used: number; limit: number }>;
	budget?: { spent: number; cap: number; paused: boolean };
	message?: string;
	status?: number;
}

// Friendly path → label map for the four endpoints the proxy exposes.
// Keep aligned with proxy/src/index.ts LIMITS keys.
const ENDPOINT_LABELS: Record<string, string> = {
	"/v1/realtime/client_secrets": "Voice sessions",
	"/v1/audio/transcriptions": "Transcription",
	"/v1/chat/completions": "Background classifiers",
	"/v1/responses": "Reasoning / Computer Use",
};

function endpointLabel(path: string): string {
	return ENDPOINT_LABELS[path] ?? path;
}

export function ApiKeySection() {
	const [hasUserKey, setHasUserKey] = useState<boolean | null>(null);
	const [status, setStatus] = useState<TrialStatus | null>(null);
	const [keyInput, setKeyInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState<string | null>(null);
	const [showPaste, setShowPaste] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const cfg = await invoke<{ apiKey: string | null }>("get_config", {});
			setHasUserKey(!!cfg.apiKey);
		} catch {
			setHasUserKey(false);
		}
		try {
			const s = await invoke<TrialStatus>("fetch_trial_status", {});
			setStatus(s);
		} catch (err) {
			setStatus({
				mode: "proxy_error",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	async function saveKey() {
		const key = keyInput.trim();
		if (!key) return;
		if (!key.startsWith("sk-")) {
			setNote("That doesn't look like an OpenAI API key (should start with sk-).");
			return;
		}
		setBusy(true);
		setNote(null);
		try {
			await invoke("set_user_api_key", { apiKey: key });
			setKeyInput("");
			setShowPaste(false);
			setNote("Saved. The app is now using your key directly.");
			await refresh();
		} catch (err) {
			setNote(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setBusy(false);
		}
	}

	async function clearKey() {
		if (!confirm("Remove your OpenAI key and switch back to trial mode?")) return;
		setBusy(true);
		setNote(null);
		try {
			await invoke("set_user_api_key", { apiKey: "" });
			setNote("Removed. You're back on the daily trial.");
			await refresh();
		} catch (err) {
			setNote(`Remove failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setBusy(false);
		}
	}

	const trialPaused = status?.mode === "trial" && status.budget?.paused;

	return (
		<div className="settings-section">
			<div className="settings-section-title">OpenAI Connection</div>

			{hasUserKey === true && (
				<>
					<div className="settings-key-status settings-key-status-byok">
						<span className="settings-key-badge">Your key</span>
						<span className="settings-key-text">
							Samuel is calling OpenAI directly with the key you provided. No trial limits, no proxy in the path. Your usage shows up on your OpenAI bill.
						</span>
					</div>
					<button className="settings-btn settings-btn-subtle" onClick={clearKey} disabled={busy}>
						{busy ? "Working…" : "Remove my key (back to trial)"}
					</button>
				</>
			)}

			{hasUserKey === false && (
				<>
					<div className="settings-key-status settings-key-status-trial">
						<span className="settings-key-badge">Trial</span>
						<span className="settings-key-text">
							{trialPaused
								? "The shared daily trial budget is used up for today. Add your own OpenAI API key below to keep using Samuel without limits."
								: "Samuel is using a shared trial connection. Daily caps apply per device. Paste your own OpenAI key to remove all limits."}
						</span>
					</div>

					{status?.mode === "trial" && status.usage && (
						<div className="settings-trial-usage">
							{Object.entries(status.usage).map(([path, q]) => {
								const pct = Math.min(100, Math.round((q.used / Math.max(1, q.limit)) * 100));
								const exhausted = q.used >= q.limit;
								return (
									<div key={path} className="settings-trial-row">
										<div className="settings-trial-row-label">
											<span>{endpointLabel(path)}</span>
											<span className={exhausted ? "settings-trial-count-exhausted" : "settings-trial-count"}>
												{q.used} / {q.limit}
											</span>
										</div>
										<div className="settings-trial-bar">
											<div
												className={`settings-trial-bar-fill${exhausted ? " settings-trial-bar-exhausted" : ""}`}
												style={{ width: `${pct}%` }}
											/>
										</div>
									</div>
								);
							})}
						</div>
					)}

					{status?.mode === "no_proxy" && (
						<div className="settings-key-warn">
							No trial proxy is configured for this build. Add your own OpenAI key below to use Samuel.
						</div>
					)}

					{status?.mode === "proxy_error" && (
						<div className="settings-key-warn">
							Couldn't reach the trial proxy. Add your own OpenAI key below to use Samuel offline of our trial service.
							{status.message && <div className="settings-key-warn-detail">{status.message}</div>}
						</div>
					)}

					{!showPaste ? (
						<button className="settings-btn" onClick={() => setShowPaste(true)} disabled={busy}>
							Use my own OpenAI key
						</button>
					) : (
						<div className="settings-key-form">
							<input
								type="password"
								className="settings-key-input"
								placeholder="sk-..."
								value={keyInput}
								onChange={(e) => setKeyInput(e.target.value)}
								disabled={busy}
								autoFocus
							/>
							<div className="settings-key-form-row">
								<button className="settings-btn" onClick={saveKey} disabled={busy || !keyInput.trim()}>
									{busy ? "Saving…" : "Save"}
								</button>
								<button
									className="settings-btn settings-btn-subtle"
									onClick={() => {
										setShowPaste(false);
										setKeyInput("");
									}}
									disabled={busy}
								>
									Cancel
								</button>
								<a
									className="settings-key-link"
									href="https://platform.openai.com/api-keys"
									target="_blank"
									rel="noreferrer"
								>
									Get a key →
								</a>
							</div>
							<p className="settings-key-help">
								Stored locally in <code>~/.books-reader.json</code>. Never sent anywhere except OpenAI itself.
							</p>
						</div>
					)}
				</>
			)}

			{note && <div className="settings-key-note">{note}</div>}
		</div>
	);
}
