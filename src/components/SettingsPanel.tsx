import { useState } from "react";
import { invoke } from "../lib/invoke-bridge";
import type { UIPreferences } from "../hooks/useUIPreferences";
import { PrivacyPolicy } from "./PrivacyPolicy";
import { MemoryBrowser } from "./MemoryBrowser";

type ToggleKey =
  | "privacy.screen_watch"
  | "privacy.audio_listen"
  | "privacy.screen_read"
  | "privacy.voice_input"
  | "privacy.computer_use"
  | "privacy.local_time"
  | "privacy.location";

interface Props {
  visible: boolean;
  prefs: UIPreferences;
  onToggle: (key: ToggleKey) => void;
  onResetPrefs: () => void;
  onClose: () => void;
}

export function SettingsPanel({ visible, prefs, onToggle, onResetPrefs, onClose }: Props) {
  const [clearing, setClearing] = useState<string | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);

  if (!visible) return null;

  async function exportData(includeSecrets: boolean) {
    if (
      includeSecrets &&
      !confirm(
        "Include API keys and access tokens in the export?\n\n" +
          "The exported file will contain your secrets in plaintext. " +
          "Only do this if you trust the destination (e.g. an encrypted backup).",
      )
    ) {
      return;
    }
    setExporting(true);
    setExportNote(null);
    try {
      // Send the renderer-side localStorage prefs into the export so the
      // single output file is genuinely complete (everything Samuel knows
      // about you across both processes).
      const localStoragePrefs: Record<string, unknown> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        localStoragePrefs[k] = localStorage.getItem(k);
      }
      const result = await invoke<{
        ok: boolean;
        path?: string;
        bytes?: number;
        canceled?: boolean;
        error?: string;
      }>("data_export", { includeSecrets, localStoragePrefs });
      if (result.canceled) {
        setExportNote(null);
      } else if (result.ok && result.path) {
        const kb = Math.max(1, Math.round((result.bytes ?? 0) / 1024));
        setExportNote(`Saved ${kb} KB to ${result.path}`);
      } else if (result.error) {
        setExportNote(`Export failed: ${result.error}`);
      }
    } catch (err) {
      setExportNote(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
    }
  }

  async function clearMemory() {
    if (!confirm("Clear all of Samuel's memories (preferences, vocabulary, corrections)? This cannot be undone.")) return;
    setClearing("memory");
    try {
      await invoke("memory_clear");
    } catch {}
    setClearing(null);
  }

  async function clearSecrets() {
    if (!confirm("Delete all stored API keys and tokens? You will need to re-enter them.")) return;
    setClearing("secrets");
    try {
      const keys = await invoke<string[]>("list_secrets");
      for (const key of keys) {
        await invoke("delete_secret", { name: key });
      }
    } catch {}
    setClearing(null);
  }

  function clearLocalData() {
    if (!confirm("Reset all UI preferences and local settings to defaults? The app will reload.")) return;
    localStorage.clear();
    onResetPrefs();
    window.location.reload();
  }

  async function clearEverything() {
    if (!confirm("Clear ALL data — memory, secrets, preferences, and plugins? This cannot be undone.")) return;
    setClearing("all");
    try { await invoke("memory_clear"); } catch {}
    try {
      const keys = await invoke<string[]>("list_secrets");
      for (const key of keys) await invoke("delete_secret", { name: key });
    } catch {}
    localStorage.clear();
    onResetPrefs();
    setClearing(null);
    window.location.reload();
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h3>Settings</h3>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Privacy Controls</div>

          {/* Master capability switches — disable a tool family entirely.
              Enforced in src/lib/samuel-privacy.ts + tool guards. */}
          <label className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Screen Reading</span>
              <span className="settings-toggle-desc">
                Let Samuel read on-screen content (apps, browser tabs) when you ask
              </span>
            </div>
            <div
              className={`settings-switch ${prefs["privacy.screen_read"] ? "settings-switch-on" : ""}`}
              onClick={() => onToggle("privacy.screen_read")}
            >
              <div className="settings-switch-thumb" />
            </div>
          </label>

          <label className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Voice Input</span>
              <span className="settings-toggle-desc">
                Let Samuel hear your voice for conversation and the wake word
              </span>
            </div>
            <div
              className={`settings-switch ${prefs["privacy.voice_input"] ? "settings-switch-on" : ""}`}
              onClick={() => onToggle("privacy.voice_input")}
            >
              <div className="settings-switch-thumb" />
            </div>
          </label>

          <label className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Computer Use</span>
              <span className="settings-toggle-desc">
                Let Samuel click, type, and operate apps on your desktop
              </span>
            </div>
            <div
              className={`settings-switch ${prefs["privacy.computer_use"] ? "settings-switch-on" : ""}`}
              onClick={() => onToggle("privacy.computer_use")}
            >
              <div className="settings-switch-thumb" />
            </div>
          </label>

          {/* Proactive observation — separate from the master switches.
              These default off and only gate ambient watcher / learning loops. */}
          <label className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Proactive Screen Watch</span>
              <span className="settings-toggle-desc">
                Let Samuel watch your screen between turns for language hints
              </span>
            </div>
            <div
              className={`settings-switch ${prefs["privacy.screen_watch"] ? "settings-switch-on" : ""}`}
              onClick={() => onToggle("privacy.screen_watch")}
            >
              <div className="settings-switch-thumb" />
            </div>
          </label>

          <label className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Proactive Audio Listening</span>
              <span className="settings-toggle-desc">
                Let Samuel passively listen for ambient audio between turns
              </span>
            </div>
            <div
              className={`settings-switch ${prefs["privacy.audio_listen"] ? "settings-switch-on" : ""}`}
              onClick={() => onToggle("privacy.audio_listen")}
            >
              <div className="settings-switch-thumb" />
            </div>
          </label>

          <label className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Local Time</span>
              <span className="settings-toggle-desc">
                Allow Samuel to know your local time and timezone
              </span>
            </div>
            <div
              className={`settings-switch ${prefs["privacy.local_time"] ? "settings-switch-on" : ""}`}
              onClick={() => onToggle("privacy.local_time")}
            >
              <div className="settings-switch-thumb" />
            </div>
          </label>

          <label className="settings-toggle-row">
            <div className="settings-toggle-info">
              <span className="settings-toggle-label">Location</span>
              <span className="settings-toggle-desc">
                Allow Samuel to know your approximate location for contextual help
              </span>
            </div>
            <div
              className={`settings-switch ${prefs["privacy.location"] ? "settings-switch-on" : ""}`}
              onClick={() => onToggle("privacy.location")}
            >
              <div className="settings-switch-thumb" />
            </div>
          </label>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Your Data</div>

          <button className="settings-btn" onClick={() => setMemoryOpen(true)} disabled={clearing !== null}>
            Memory Browser…
          </button>
          <span className="settings-btn-desc">Inspect and delete individual memories, watches, and stored credentials</span>

          <button className="settings-btn" onClick={() => exportData(false)} disabled={exporting || clearing !== null}>
            {exporting ? "Exporting…" : "Export Data…"}
          </button>
          <span className="settings-btn-desc">Save everything Samuel stores about you to a JSON file (excludes API keys)</span>

          <button
            className="settings-btn settings-btn-subtle"
            onClick={() => exportData(true)}
            disabled={exporting || clearing !== null}
          >
            Export Data + API Keys…
          </button>
          <span className="settings-btn-desc">Same export, with secrets in plaintext — back up to an encrypted location only</span>

          {exportNote && <div className="settings-export-note">{exportNote}</div>}
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Bulk Delete</div>

          <button className="settings-btn" onClick={clearMemory} disabled={clearing !== null}>
            {clearing === "memory" ? "Clearing..." : "Clear Memory"}
          </button>
          <span className="settings-btn-desc">Erase Samuel's remembered preferences, vocabulary, and corrections</span>

          <button className="settings-btn" onClick={clearSecrets} disabled={clearing !== null}>
            {clearing === "secrets" ? "Clearing..." : "Clear API Keys"}
          </button>
          <span className="settings-btn-desc">Delete all stored API keys and tokens</span>

          <button className="settings-btn" onClick={clearLocalData} disabled={clearing !== null}>
            Reset Preferences
          </button>
          <span className="settings-btn-desc">Reset UI settings to defaults (reloads the app)</span>

          <button className="settings-btn settings-btn-danger" onClick={clearEverything} disabled={clearing !== null}>
            {clearing === "all" ? "Clearing..." : "Clear Everything"}
          </button>
          <span className="settings-btn-desc">Erase all data — memory, keys, preferences, and start fresh</span>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">About</div>
          <button className="settings-link-btn" onClick={() => setPolicyOpen(true)}>
            Privacy Policy
          </button>
          <p className="settings-note">
            Voice, screen text, and tool inputs are sent to OpenAI when the
            agent is active. Memory and credentials are stored on this
            computer in <code>~/.samuel/</code>. Tap Privacy Policy for the
            full breakdown.
          </p>
        </div>
      </div>
      {policyOpen && <PrivacyPolicy onClose={() => setPolicyOpen(false)} />}
      <MemoryBrowser visible={memoryOpen} onClose={() => setMemoryOpen(false)} />
    </div>
  );
}
