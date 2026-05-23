import * as config from "./config.js";
import * as capture from "./capture.js";
import * as memory from "./memory.js";
import * as secrets from "./secrets.js";
import * as plugins from "./plugins.js";
import * as oauth from "./oauth.js";
import * as browser from "./browser.js";
import * as cua from "./cua.js";
import * as learning from "./learning.js";
import * as fileOps from "./file-ops.js";
import * as misc from "./misc.js";
import * as wakeWord from "./wake-word.js";
import * as appPerms from "./app-permissions.js";
import * as axObserver from "./ax-observer.js";
import * as dataExport from "./data-export.js";

// All IPC args arrive as plain objects from the renderer process.
// We cast loosely since the Rust→TS port preserves the same arg shapes.
type A = Record<string, unknown>;

const handlers: Record<string, (args: A) => Promise<unknown>> = {
	// Forward renderer-side logs to the main process terminal so we can
	// see what the model is doing without opening DevTools.
	debug_log: async (a) => {
		const tag = (a.tag as string) ?? "renderer";
		const message = (a.message as string) ?? "";
		const level = (a.level as string) ?? "log";
		const out = `[${tag}] ${message}`;
		if (level === "warn") console.warn(out);
		else if (level === "error") console.error(out);
		else console.log(out);
		return null;
	},

	get_config: () => config.get_config(),
	create_ephemeral_key: () => config.create_ephemeral_key(),

	capture_active_window: (a) => capture.capture_active_window(a as never),
	capture_if_changed: () => capture.capture_if_changed(),
	capture_screen_now: () => capture.capture_screen_now(),
	capture_all_displays: () => capture.capture_all_displays(),
	native_screenshot: () => capture.native_screenshot(),
	list_displays: () => capture.list_displays(),
	set_default_display: (a) => capture.set_default_display(a as never),
	get_selected_text: () => capture.get_selected_text(),
	set_system_volume: (a) => capture.set_system_volume(a as never),

	memory_clear: () => memory.memory_clear(),
	memory_get_context: () => memory.memory_get_context(),
	memory_set_fact: (a) => memory.memory_set_fact(a as never),
	memory_mark_known: (a) => memory.memory_mark_known(a as never),
	memory_add_correction: (a) => memory.memory_add_correction(a as never),
	memory_snapshot: () => memory.memory_snapshot(),
	memory_delete_item: (a) => memory.memory_delete_item(a as never),
	data_export: (a) => dataExport.data_export(a as never),
	extract_session_feedback: (a) => memory.extract_session_feedback(a as never),
	watch_add: (a) => memory.watch_add(a as never),
	watch_remove: (a) => memory.watch_remove(a as never),
	watch_list: () => memory.watch_list(),
	watch_clear: () => memory.watch_clear(),
	watch_check: (a) => memory.watch_check(a as never),
	watch_get_classifier: (a) => memory.watch_get_classifier(a as never),
	watch_mark_fired: (a) => memory.watch_mark_fired(a as never),
	watch_evaluate_classifier: (a) => memory.watch_evaluate_classifier(a as never),
	watch_flush_digests: (a) => memory.watch_flush_digests(a as never),
	watch_reset_unmatched: (a) => memory.watch_reset_unmatched(a as never),
	watch_update: (a) => memory.watch_update(a as never),
	watch_suppress_term: (a) => memory.watch_suppress_term(a as never),
	watch_cleanup_stale: (a) => memory.watch_cleanup_stale(a as never),

	get_secret: (a) => secrets.get_secret(a as never),
	set_secret: (a) => secrets.set_secret(a as never),
	delete_secret: (a) => secrets.delete_secret(a as never),
	list_secrets: () => secrets.list_secrets(),

	get_plugin_dir: () => plugins.get_plugin_dir(),
	list_plugins: () => plugins.list_plugins(),
	read_plugin: (a) => plugins.read_plugin(a as never),
	write_plugin: (a) => plugins.write_plugin(a as never),
	delete_plugin: (a) => plugins.delete_plugin(a as never),
	generate_plugin_code: (a) => plugins.generate_plugin_code(a as never),
	judge_plugin_code: (a) => plugins.judge_plugin_code(a as never),
	diagnose_plugin_failure: (a) => plugins.diagnose_plugin_failure(a as never),

	oauth_flow: (a) => oauth.oauth_flow(a as never),
	oauth_refresh: (a) => oauth.oauth_refresh(a as never),

	browser_command: (a) =>
		browser.browser_command(a.action as string, (a.params ?? {}) as Record<string, unknown>),
	browser_close: () => browser.browser_close(),

	cua_run: (a) => cua.cua_run(a.task as string, a.url as string | undefined),
	cua_run_native: (a) => cua.cua_run_native(a.task as string, a.app as string | undefined),
	native_computer_action: (a) =>
		Promise.resolve(cua.native_computer_action(a as never, 1.0, 1.0)),

	start_recording: () => learning.start_recording(),
	stop_recording: () => learning.stop_recording(),
	analyze_recording: () => learning.analyze_recording(),
	transcribe_recording: () => learning.transcribe_recording(),
	start_learning_audio: () => learning.start_learning_audio(),
	stop_learning_audio: () => learning.stop_learning_audio(),
	flush_learning_audio: () => learning.flush_learning_audio(),
	check_learning_audio: (a) => learning.check_learning_audio(a as never),
	start_watcher_audio: () => learning.start_watcher_audio(),
	stop_watcher_audio: () => learning.stop_watcher_audio(),
	check_watcher_audio: () => learning.check_watcher_audio(),
	check_screen_for_language: (a) => learning.check_screen_for_language(a as never),
	check_screen_text: () => learning.check_screen_text(),
	check_audio_for_language: (a) => learning.check_audio_for_language(a as never),
	get_attention_state: () => learning.get_attention_state(),
	triage_observation: (a) => learning.triage_observation(a as never),
	record_samuel_speech: (a) => learning.record_samuel_speech(a as never),
	append_transcript_window: (a) => learning.append_transcript_window(a as never),
	assess_viewing_session: (a) => learning.assess_viewing_session(a as never),
	web_search: (a) => learning.web_search(a as never),
	web_search_openai: (a) => learning.web_search_openai(a as never),
	web_read: (a) => learning.web_read(a as never),

	transcribe_audio: (a) => wakeWord.transcribe_audio(a as never),

	agent_write_file: (a) => fileOps.agent_write_file(a as never),
	agent_read_file: (a) => fileOps.agent_read_file(a as never),
	agent_list_directory: (a) => fileOps.agent_list_directory(a as never),

	open_app: (a) => misc.open_app(a as never),
	read_app_content: (a) => misc.read_app_content(a as never),
	list_app_windows: () => misc.list_app_windows(),
	list_browser_tabs: (a) => misc.list_browser_tabs(a as never),
	switch_browser_tab: (a) => misc.switch_browser_tab(a as never),
	desktop_click: (a) => misc.desktop_click(a as never),
	desktop_type: (a) => misc.desktop_type(a as never),
	desktop_key: (a) => misc.desktop_key(a as never),
	desktop_scroll: (a) => misc.desktop_scroll(a as never),
	focus_app: (a) => misc.focus_app(a as never),
	press_element: (a) => misc.press_element(a as never),
	ax_type: (a) => misc.ax_type(a as never),
	get_user_activity: () => misc.get_user_activity(),
	check_accessibility_permission: () => misc.check_accessibility_permission(),
	skill_list_summaries: () => misc.skill_list_summaries(),
	skill_delete: (a) => misc.skill_delete(a as never),

	check_app_permission: (a) => appPerms.check_app_permission(a as never),
	set_app_permission: (a) => appPerms.set_app_permission(a as never),
	list_app_permissions: () => appPerms.list_app_permissions(),
	clear_app_permissions: () => appPerms.clear_app_permissions(),

	start_ax_observer: () => axObserver.start_ax_observer(),
	stop_ax_observer: () => axObserver.stop_ax_observer(),
	ax_observer_status: () => axObserver.ax_observer_status(),
};

// Frontend uses camelCase but handlers expect snake_case; convert here.
function toSnakeCase(str: string): string {
	return str.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
}

function convertKeysToSnake(
	obj: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		out[toSnakeCase(k)] = v;
	}
	return out;
}

export async function handleInvoke(
	command: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const handler = handlers[command];
	if (!handler) {
		throw new Error(`Unknown command: ${command}`);
	}
	return handler(convertKeysToSnake(args));
}
