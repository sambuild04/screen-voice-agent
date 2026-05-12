/**
 * Bridge between the RealtimeSession transport and tool functions.
 *
 * Four distinct injection helpers exist on purpose; each has a different
 * delivery shape and the callers depend on the difference. Keep them
 * separate even though they look similar:
 *   sendTextToSession    — user-role text, triggers `response.create`.
 *   sendTextAndRespond   — system-style text, triggers `response.create`.
 *   sendSilentContext    — system-style text, NO response trigger.
 *   injectCorrection     — system message biasing the *next* turn (Reflexion).
 *
 * NOTE: A `sendAudioClip` PCM16 helper used to live here for piping system
 * audio directly into the Realtime session. It was removed in commit
 * dea376f because the model misidentified the spoken language. Re-introduce
 * only after the language-confusion problem is solved.
 */

type SendImageFn = (base64Jpeg: string) => void;
type SendTextFn = (text: string) => void;
type ScreenTargetFn = (appName: string) => void;
type RecordingActionFn = (action: "start" | "stop" | "processing" | "analyze" | "results" | "error", payload?: unknown) => void;
type LearningLanguageFn = (language: string | null) => void;
type SendSilentContextFn = (text: string) => void;
type SendTextAndRespondFn = (text: string) => void;
type UIUpdateFn = (component: string, property: string, value: string) => string;
type SetVolumeFn = (pct: number) => void;
type SetPassiveListeningFn = (passive: boolean) => void;
type DiscardLastTurnFn = (reason: string) => { removed: number; cancelled: boolean };
type InjectCorrectionFn = (lesson: string) => void;

let sendImageFn: SendImageFn | null = null;
let sendTextFn: SendTextFn | null = null;
let screenTargetFn: ScreenTargetFn | null = null;
let recordingActionFn: RecordingActionFn | null = null;
let learningLanguageFn: LearningLanguageFn | null = null;
let sendSilentContextFn: SendSilentContextFn | null = null;
let sendTextAndRespondFn: SendTextAndRespondFn | null = null;
let uiUpdateFn: UIUpdateFn | null = null;
let setVolumeFn: SetVolumeFn | null = null;
let setPassiveListeningFn: SetPassiveListeningFn | null = null;
let discardLastTurnFn: DiscardLastTurnFn | null = null;
let injectCorrectionFn: InjectCorrectionFn | null = null;

export function registerDiscardLastTurn(fn: DiscardLastTurnFn | null) {
  discardLastTurnFn = fn;
}

export function registerInjectCorrection(fn: InjectCorrectionFn | null) {
  injectCorrectionFn = fn;
}

/**
 * Inject a freshly-recorded correction into the live session as a system
 * message so the model applies it on the very next turn (Reflexion in-session
 * loop). Persisted corrections are also written to disk and re-applied on
 * future sessions via the system prompt prefix.
 *
 * Uses `conversation.item.create` with role: "system" rather than
 * `session.update({instructions})` because the latter has a known reliability
 * bug in the current Realtime API where instruction changes can be silently
 * ignored mid-session. System messages on the conversation timeline always
 * land.
 */
export function injectCorrection(lesson: string): boolean {
  if (!injectCorrectionFn) return false;
  injectCorrectionFn(lesson);
  return true;
}

/**
 * Erase the last user turn (and any in-flight or completed assistant reply
 * to it) from the live RealtimeSession. Used when the user says "that wasn't
 * me" / "that's not my voice" / "ignore that last one" — typically because
 * background audio (a video, music, another person) was misheard as a
 * command. Returns counts so the calling tool can confirm what happened.
 */
export function discardLastTurn(reason: string): { removed: number; cancelled: boolean } {
  if (!discardLastTurnFn) return { removed: 0, cancelled: false };
  return discardLastTurnFn(reason);
}

export function registerSetVolume(fn: SetVolumeFn | null) {
  setVolumeFn = fn;
}

export function setVolume(pct: number): boolean {
  if (!setVolumeFn) return false;
  setVolumeFn(pct);
  return true;
}

export function registerSetPassiveListening(fn: SetPassiveListeningFn | null) {
  setPassiveListeningFn = fn;
}

/**
 * Switch Samuel between normal listening (auto-respond to clear user speech)
 * and passive listening (only respond when explicitly addressed by name or
 * via chat). Use when the user is watching/playing media and the mic is
 * picking up dialogue that gets misinterpreted as commands.
 */
export function setPassiveListening(passive: boolean): boolean {
  if (!setPassiveListeningFn) return false;
  setPassiveListeningFn(passive);
  return true;
}

export function registerSendImage(fn: SendImageFn | null) {
  sendImageFn = fn;
}

export function registerSendText(fn: SendTextFn | null) {
  sendTextFn = fn;
}

/**
 * Inject a text message into the Realtime session as a user message
 * and trigger a response. Used when UI-driven actions need Samuel to react.
 */
export function sendTextToSession(text: string): boolean {
  if (!sendTextFn) return false;
  sendTextFn(text);
  return true;
}

export function registerScreenTarget(fn: ScreenTargetFn | null) {
  screenTargetFn = fn;
}

/**
 * Inject a captured page image directly into the Realtime session.
 * Returns true if the image was sent, false if no session is active.
 */
export function sendImageToSession(base64Jpeg: string): boolean {
  if (!sendImageFn) return false;
  sendImageFn(base64Jpeg);
  return true;
}

/** Notify the UI which app/window the agent just captured. */
export function notifyScreenTarget(appName: string) {
  screenTargetFn?.(appName);
}

export function registerRecordingAction(fn: RecordingActionFn | null) {
  recordingActionFn = fn;
}

/** Notify the UI about a recording state change. */
export function notifyRecordingAction(action: "start" | "stop" | "processing" | "analyze" | "results" | "error", payload?: unknown) {
  recordingActionFn?.(action, payload);
}

// ---------------------------------------------------------------------------
// Learning Mode bridge
// ---------------------------------------------------------------------------

export function registerLearningLanguage(fn: LearningLanguageFn | null) {
  learningLanguageFn = fn;
}

/** Called by Samuel's set_learning_language tool to activate/deactivate learning mode. */
export function notifyLearningLanguage(language: string | null) {
  learningLanguageFn?.(language);
}

export function registerSendSilentContext(fn: SendSilentContextFn | null) {
  sendSilentContextFn = fn;
}

/**
 * Inject background context into the session WITHOUT triggering a response.
 * Samuel receives this as conversation history he can reference when asked,
 * but won't proactively speak about it.
 */
export function sendSilentContext(text: string): boolean {
  if (!sendSilentContextFn) return false;
  sendSilentContextFn(text);
  return true;
}

export function registerSendTextAndRespond(fn: SendTextAndRespondFn | null) {
  sendTextAndRespondFn = fn;
}

/**
 * Inject a text message into the session and trigger a model response.
 * Used by the learning mode hook to surface hints proactively.
 */
export function sendTextAndRespond(text: string): boolean {
  if (!sendTextAndRespondFn) return false;
  sendTextAndRespondFn(text);
  return true;
}

// ---------------------------------------------------------------------------
// UI Update bridge
// ---------------------------------------------------------------------------

export function registerUIUpdate(fn: UIUpdateFn | null) {
  uiUpdateFn = fn;
}

/** Called by Samuel's update_ui tool to change UI properties via voice. */
export function applyUIUpdate(component: string, property: string, value: string): string {
  if (!uiUpdateFn) {
    console.warn("[session-bridge] applyUIUpdate called but no uiUpdateFn registered");
    return "UI update not available.";
  }
  return uiUpdateFn(component, property, value);
}

// ---------------------------------------------------------------------------
// Plugin reload bridge
// ---------------------------------------------------------------------------

type ReloadPluginsFn = () => Promise<void>;
let reloadPluginsFn: ReloadPluginsFn | null = null;

export function registerReloadPlugins(fn: ReloadPluginsFn | null) {
  reloadPluginsFn = fn;
}

/** Trigger a hot-reload of all plugins into the live session. */
export async function reloadPlugins(): Promise<boolean> {
  if (!reloadPluginsFn) return false;
  await reloadPluginsFn();
  return true;
}

// ---------------------------------------------------------------------------
// Plugin proposal/approval bridge
// ---------------------------------------------------------------------------

export interface PluginProposal {
  name: string;
  summary: string;
}

export type PluginBuildPhase = "generating" | "validating" | "retrying" | "checking" | "installing" | "reloading" | "diagnosing" | "repairing" | "done" | "error";

export interface PluginBuildProgress {
  name: string;
  phase: PluginBuildPhase;
  error?: string;
}

type ProposalChangeFn = (proposal: PluginProposal | null) => void;
type BuildProgressFn = (progress: PluginBuildProgress | null) => void;
let proposalChangeFn: ProposalChangeFn | null = null;
let buildProgressFn: BuildProgressFn | null = null;
let currentProposal: PluginProposal | null = null;

export function registerPluginProposalChange(fn: ProposalChangeFn | null) {
  proposalChangeFn = fn;
}

export function registerPluginBuildProgress(fn: BuildProgressFn | null) {
  buildProgressFn = fn;
}

/** Called by Samuel's propose_plugin tool to show the approval UI. */
export function showPluginProposal(proposal: PluginProposal) {
  currentProposal = proposal;
  proposalChangeFn?.(proposal);
}

/** Called by Approve/Reject buttons to clear the proposal card. */
export function clearPluginProposal() {
  currentProposal = null;
  proposalChangeFn?.(null);
}

/** Update the plugin build progress indicator. */
export function notifyPluginBuildProgress(progress: PluginBuildProgress | null) {
  buildProgressFn?.(progress);
}

export function getCurrentProposal(): PluginProposal | null {
  return currentProposal;
}
