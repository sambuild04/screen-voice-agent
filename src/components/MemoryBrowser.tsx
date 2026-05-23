import { useCallback, useEffect, useState } from "react";
import { invoke } from "../lib/invoke-bridge";

// Mirror of the MemorySnapshot type returned by `memory_snapshot` in the
// main process. Keep in sync with electron/handlers/memory.ts.
interface MemorySnapshot {
  facts: Array<{ key: string; value: string }>;
  observations: Array<{ index: number; text: string }>;
  transcripts: Array<{ index: number; text: string }>;
  vocabulary: Array<{ word: string; timestamp: number; permanent: boolean }>;
  corrections: Array<{ timestamp: number; what: string; source: string }>;
  watches: Array<{
    id: string;
    description: string;
    enabled: boolean;
    fire_count: number;
    source: string;
  }>;
}

type Category = "fact" | "observation" | "transcript" | "vocabulary" | "correction" | "watch";

interface Props {
  visible: boolean;
  onClose: () => void;
}

function fmtTime(ts: number): string {
  if (!ts || ts === Number.MAX_SAFE_INTEGER) return "—";
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Generic delete-with-confirm row. The category-specific renderers below
// build their own row content but share this control style.
function DeleteRow({
  label,
  detail,
  onDelete,
  busy,
}: {
  label: string;
  detail?: string;
  onDelete: () => void;
  busy: boolean;
}) {
  return (
    <div className="memory-item">
      <div className="memory-item-text">
        <div className="memory-item-label">{label}</div>
        {detail && <div className="memory-item-detail">{detail}</div>}
      </div>
      <button
        className="memory-item-delete"
        onClick={onDelete}
        disabled={busy}
        title="Forget this item"
      >
        Forget
      </button>
    </div>
  );
}

export function MemoryBrowser({ visible, onClose }: Props) {
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  // Tracks which item is mid-delete so we can disable its button. Keyed by
  // `${category}:${key}` to avoid collisions across sections.
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [snap, secrets] = await Promise.all([
        invoke<MemorySnapshot>("memory_snapshot"),
        invoke<string[]>("list_secrets").catch(() => []),
      ]);
      setSnapshot(snap);
      setSecretNames(secrets);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    refresh();
  }, [visible, refresh]);

  const deleteItem = useCallback(
    async (category: Category, key: string | number) => {
      const k = `${category}:${key}`;
      setBusyKey(k);
      try {
        await invoke("memory_delete_item", { category, key });
        await refresh();
      } finally {
        setBusyKey(null);
      }
    },
    [refresh],
  );

  const deleteSecret = useCallback(
    async (name: string) => {
      const k = `secret:${name}`;
      setBusyKey(k);
      try {
        await invoke("delete_secret", { name });
        const updated = await invoke<string[]>("list_secrets").catch(() => []);
        setSecretNames(updated);
      } finally {
        setBusyKey(null);
      }
    },
    [],
  );

  if (!visible) return null;

  const empty = !snapshot
    ? false
    : snapshot.facts.length === 0 &&
      snapshot.observations.length === 0 &&
      snapshot.transcripts.length === 0 &&
      snapshot.vocabulary.length === 0 &&
      snapshot.corrections.length === 0 &&
      snapshot.watches.length === 0 &&
      secretNames.length === 0;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel memory-browser-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h3>Memory Browser</h3>
          <button className="settings-close" onClick={onClose}>&times;</button>
        </div>

        <p className="memory-browser-help">
          Everything Samuel remembers about you, by category. &ldquo;Forget&rdquo;
          deletes that single item from <code>~/.samuel/memory.json</code> right
          away.
        </p>

        {loading && !snapshot && <div className="memory-empty">Loading…</div>}
        {empty && <div className="memory-empty">Nothing remembered yet.</div>}

        {snapshot && snapshot.facts.length > 0 && (
          <Section title={`Facts (${snapshot.facts.length})`}>
            {snapshot.facts.map((f) => (
              <DeleteRow
                key={f.key}
                label={f.key}
                detail={f.value}
                onDelete={() => deleteItem("fact", f.key)}
                busy={busyKey === `fact:${f.key}`}
              />
            ))}
          </Section>
        )}

        {snapshot && snapshot.corrections.length > 0 && (
          <Section title={`Corrections (${snapshot.corrections.length})`}>
            {snapshot.corrections.map((c) => (
              <DeleteRow
                key={c.timestamp}
                label={c.what}
                detail={`${fmtTime(c.timestamp)} · ${c.source}`}
                onDelete={() => deleteItem("correction", c.timestamp)}
                busy={busyKey === `correction:${c.timestamp}`}
              />
            ))}
          </Section>
        )}

        {snapshot && snapshot.watches.length > 0 && (
          <Section title={`Watches (${snapshot.watches.length})`}>
            {snapshot.watches.map((w) => (
              <DeleteRow
                key={w.id}
                label={w.description}
                detail={`${w.id} · ${w.source} · fired ${w.fire_count}× · ${w.enabled ? "enabled" : "disabled"}`}
                onDelete={() => deleteItem("watch", w.id)}
                busy={busyKey === `watch:${w.id}`}
              />
            ))}
          </Section>
        )}

        {snapshot && snapshot.vocabulary.length > 0 && (
          <Section title={`Vocabulary (${snapshot.vocabulary.length})`}>
            {snapshot.vocabulary.map((v) => (
              <DeleteRow
                key={v.word}
                label={v.word}
                detail={v.permanent ? "marked as permanently known" : `last seen ${fmtTime(v.timestamp)}`}
                onDelete={() => deleteItem("vocabulary", v.word)}
                busy={busyKey === `vocabulary:${v.word}`}
              />
            ))}
          </Section>
        )}

        {snapshot && snapshot.observations.length > 0 && (
          <Section title={`Recent Observations (${snapshot.observations.length})`}>
            {snapshot.observations.map((o) => (
              <DeleteRow
                key={o.index}
                label={o.text}
                onDelete={() => deleteItem("observation", o.index)}
                busy={busyKey === `observation:${o.index}`}
              />
            ))}
          </Section>
        )}

        {snapshot && snapshot.transcripts.length > 0 && (
          <Section title={`Recent Transcripts (${snapshot.transcripts.length})`}>
            {snapshot.transcripts.map((t) => (
              <DeleteRow
                key={t.index}
                label={t.text}
                onDelete={() => deleteItem("transcript", t.index)}
                busy={busyKey === `transcript:${t.index}`}
              />
            ))}
          </Section>
        )}

        {secretNames.length > 0 && (
          <Section title={`Stored API Keys & Tokens (${secretNames.length})`}>
            <p className="memory-section-note">
              Names only — the actual values are never shown in the UI.
            </p>
            {secretNames.map((name) => (
              <DeleteRow
                key={name}
                label={name}
                onDelete={() => deleteSecret(name)}
                busy={busyKey === `secret:${name}`}
              />
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="memory-section">
      <div className="memory-section-title">{title}</div>
      {children}
    </div>
  );
}
