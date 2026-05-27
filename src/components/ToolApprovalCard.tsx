import { useState, useEffect } from "react";
import type { TranscriptEntry } from "../hooks/useRealtime";

const TOOL_DESCRIPTIONS: Record<string, string> = {
	capture_active_window: "Take a screenshot of the active window",
	capture_screen_now: "Take a full-screen screenshot",
	read_app_content: "Read app content via Accessibility Tree",
	read_app: "Read app content via Accessibility Tree",
	list_app_windows: "List all open application windows",
	cua_run_native: "Control your computer (mouse & keyboard)",
	cua_run: "Automate a task in an isolated browser",
	browser_command: "Run a browser automation command",
	open_app: "Open an application",
	agent_write_file: "Write a file to disk",
	agent_read_file: "Read a file from disk",
	native_screenshot: "Take a native screenshot",
	web_search: "Search the web",
	web_search_openai: "Search the web via OpenAI",
	web_read: "Read a web page",
	set_system_volume: "Change system volume",
	native_computer_action: "Perform a computer action (click/type)",
	computer_use: "Operate your computer (see, click, type)",
	listen_in_background: "Listen to system audio (so I can answer questions about what you're playing)",
	set_screen_observation: "Watch your screen continuously (so I can follow along with what you're doing)",
	file_op: "Read or write a file on your computer",
};

const TOOL_ICONS: Record<string, string> = {
	capture_active_window: "📸",
	capture_screen_now: "🖥",
	read_app_content: "👁",
	read_app: "👁",
	list_app_windows: "📋",
	cua_run_native: "🖱",
	cua_run: "🌐",
	browser_command: "🌐",
	open_app: "🚀",
	agent_write_file: "💾",
	agent_read_file: "📄",
	native_screenshot: "📸",
	web_search: "🔍",
	web_search_openai: "🔍",
	web_read: "📖",
	set_system_volume: "🔊",
	native_computer_action: "⚡",
	computer_use: "🖱",
	listen_in_background: "🎧",
	set_screen_observation: "👀",
	file_op: "📁",
};

// Tools that operate on specific apps — eligible for "Always Allow" per-app memory
const APP_SCOPED_TOOLS = new Set([
	"read_app", "read_app_content", "cua_run_native", "computer_use", "open_app",
]);

// Sensitive permissions where we should NOT auto-approve after the
// 10-second countdown — the user has to consciously click Allow. Privacy
// grants like ambient audio capture or continuous screen observation
// would otherwise silently flip on if the user happened to be away from
// the screen when the popup landed.
const NO_AUTO_APPROVE = new Set([
	"listen_in_background",
	"set_screen_observation",
]);

interface Props {
	entry: TranscriptEntry;
	onApprove: (id: string) => void;
	onDeny: (id: string) => void;
	onAlwaysAllow?: (id: string, appName: string) => void;
	onAlwaysDeny?: (id: string, appName: string) => void;
}

export function ToolApprovalCard({ entry, onApprove, onDeny, onAlwaysAllow, onAlwaysDeny }: Props) {
	const approval = entry.approval!;
	const { toolName, args, state } = approval;
	const [expanded, setExpanded] = useState(false);

	const icon = TOOL_ICONS[toolName] ?? "🔧";
	const desc = TOOL_DESCRIPTIONS[toolName] ?? toolName.replace(/_/g, " ");

	// Extract app name from args for per-app permission buttons
	const appName = (args?.app as string) ?? (args?.app_name as string) ?? (args?.name as string) ?? null;
	const isAppScoped = APP_SCOPED_TOOLS.has(toolName) && !!appName;

	const argSummary = args
		? Object.entries(args)
				.filter(([, v]) => v !== undefined && v !== null && v !== "")
				.map(([k, v]) => {
					const val = typeof v === "string" ? v : JSON.stringify(v);
					const truncated = val.length > 60 ? val.slice(0, 57) + "..." : val;
					return `${k}: ${truncated}`;
				})
				.join("\n")
		: null;

	// Auto-approve after 10s if user doesn't interact — disabled for
	// sensitive privacy permissions (audio capture, continuous screen
	// observation), which require an explicit Allow click.
	const autoApprove = !NO_AUTO_APPROVE.has(toolName);
	const [countdown, setCountdown] = useState(10);
	useEffect(() => {
		if (state !== "pending") return;
		if (!autoApprove) return;
		if (countdown <= 0) {
			onApprove(entry.id);
			return;
		}
		const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
		return () => clearTimeout(t);
	}, [countdown, state, entry.id, onApprove, autoApprove]);

	if (state === "approved") {
		return (
			<div className="tool-approval-card tool-approval-resolved">
				<div className="tool-approval-header">
					<span className="tool-approval-icon">{icon}</span>
					<span className="tool-approval-name">{desc}</span>
				</div>
				<div className="tool-approval-badge tool-approval-badge-approved">
					Approved
				</div>
			</div>
		);
	}

	if (state === "denied") {
		return (
			<div className="tool-approval-card tool-approval-resolved">
				<div className="tool-approval-header">
					<span className="tool-approval-icon">{icon}</span>
					<span className="tool-approval-name">{desc}</span>
				</div>
				<div className="tool-approval-badge tool-approval-badge-denied">
					Denied
				</div>
			</div>
		);
	}

	return (
		<div className="tool-approval-card tool-approval-pending">
			<div className="tool-approval-header">
				<span className="tool-approval-icon">{icon}</span>
				<div className="tool-approval-info">
					<span className="tool-approval-name">{desc}</span>
					<span className="tool-approval-tool-id">
						{toolName}{appName ? ` → ${appName}` : ""}
					</span>
				</div>
			</div>

			{argSummary && (
				<button
					className="tool-approval-expand"
					onClick={() => setExpanded(!expanded)}
				>
					{expanded ? "Hide details ▴" : "Show details ▾"}
				</button>
			)}

			{expanded && argSummary && (
				<pre className="tool-approval-args">{argSummary}</pre>
			)}

			<div className="tool-approval-actions">
				<button
					className="tool-approval-btn tool-approval-btn-approve"
					onClick={() => onApprove(entry.id)}
				>
					Allow{autoApprove && countdown < 10 ? ` (${countdown}s)` : ""}
				</button>
				{isAppScoped && onAlwaysAllow && (
					<button
						className="tool-approval-btn tool-approval-btn-always"
						onClick={() => onAlwaysAllow(entry.id, appName)}
						title={`Always allow Samuel to access ${appName}`}
					>
						Always
					</button>
				)}
				<button
					className="tool-approval-btn tool-approval-btn-deny"
					onClick={() => {
						if (isAppScoped && onAlwaysDeny) {
							onAlwaysDeny(entry.id, appName);
						} else {
							onDeny(entry.id);
						}
					}}
				>
					Deny
				</button>
			</div>

			{isAppScoped && (
				<div className="tool-approval-app-hint">
					Samuel wants to access <strong>{appName}</strong>
				</div>
			)}
		</div>
	);
}
