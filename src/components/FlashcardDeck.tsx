import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Flashcard {
  id: string;
  word: string;
  hint: string;
  transcript: string;
  audio_path: string | null;
  screenshot_path: string | null;
  source: string;
  created_at: number;
  review_count: number;
}

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function FlashcardDeck({ visible, onClose }: Props) {
  const [cards, setCards] = useState<Flashcard[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [screenshotSrc, setScreenshotSrc] = useState<string | null>(null);

  const loadDeck = useCallback(async () => {
    try {
      const deck = await invoke<Flashcard[]>("get_flashcard_deck");
      setCards(deck);
      setCurrentIdx(0);
      setFlipped(false);
    } catch (e) {
      console.warn("[flashcard-deck] load error:", e);
    }
  }, []);

  useEffect(() => {
    if (visible) loadDeck();
  }, [visible, loadDeck]);

  const current = cards[currentIdx];

  // Load screenshot as base64 data URL when the current card changes
  useEffect(() => {
    setScreenshotSrc(null);
    if (!current?.screenshot_path) return;
    let cancelled = false;
    invoke<string>("read_flashcard_file", { filePath: current.screenshot_path })
      .then((b64) => {
        if (!cancelled) setScreenshotSrc(`data:image/jpeg;base64,${b64}`);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [current?.id, current?.screenshot_path]);

  const handlePlayClip = useCallback(async () => {
    if (!current?.audio_path) return;
    if (isPlaying) return;
    try {
      const b64 = await invoke<string>("read_flashcard_file", { filePath: current.audio_path });
      const audio = new Audio(`data:audio/mp4;base64,${b64}`);
      audio.onended = () => setIsPlaying(false);
      audio.onerror = () => setIsPlaying(false);
      audio.play();
      setIsPlaying(true);
      invoke("increment_flashcard_review", { cardId: current.id }).catch(() => {});
    } catch (e) {
      console.warn("[flashcard-deck] playback error:", e);
    }
  }, [current, isPlaying]);

  const handleNext = useCallback(() => {
    if (currentIdx < cards.length - 1) {
      setCurrentIdx((i) => i + 1);
      setFlipped(false);
    }
  }, [currentIdx, cards.length]);

  const handlePrev = useCallback(() => {
    if (currentIdx > 0) {
      setCurrentIdx((i) => i - 1);
      setFlipped(false);
    }
  }, [currentIdx]);

  const handleDelete = useCallback(async () => {
    if (!current) return;
    try {
      await invoke("delete_flashcard", { cardId: current.id });
      setCards((prev) => prev.filter((c) => c.id !== current.id));
      if (currentIdx >= cards.length - 1 && currentIdx > 0) {
        setCurrentIdx((i) => i - 1);
      }
      setFlipped(false);
    } catch (e) {
      console.warn("[flashcard-deck] delete error:", e);
    }
  }, [current, currentIdx, cards.length]);

  if (!visible) return null;

  return (
    <div className="flashcard-overlay" onClick={onClose}>
      <div className="flashcard-panel" onClick={(e) => e.stopPropagation()}>
        <div className="flashcard-panel-header">
          <h3>Scene Flashcards</h3>
          <span className="flashcard-count">
            {cards.length > 0 ? `${currentIdx + 1} / ${cards.length}` : "Empty"}
          </span>
          <button className="flashcard-close" onClick={onClose}>
            &times;
          </button>
        </div>

        {cards.length === 0 ? (
          <div className="flashcard-empty">
            <p>No flashcards saved yet.</p>
            <p>Tap "Save it" on vocab cards to build your deck!</p>
          </div>
        ) : current ? (
          <div className="flashcard-card" onClick={() => setFlipped(!flipped)}>
            {!flipped ? (
              <div className="flashcard-front">
                <div className="flashcard-word">{current.word}</div>
                <div className="flashcard-tap-hint">tap to reveal</div>
              </div>
            ) : (
              <div className="flashcard-back">
                <div className="flashcard-hint">{current.hint}</div>
                {current.transcript && (
                  <div className="flashcard-transcript">
                    {current.transcript}
                  </div>
                )}
                {current.audio_path && (
                  <button
                    className="flashcard-replay-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePlayClip();
                    }}
                  >
                    {isPlaying ? "Playing..." : "Replay Scene Clip"}
                  </button>
                )}
                {screenshotSrc && (
                  <img
                    className="flashcard-screenshot"
                    src={screenshotSrc}
                    alt="scene"
                  />
                )}
              </div>
            )}
          </div>
        ) : null}

        {cards.length > 0 && (
          <div className="flashcard-nav">
            <button onClick={handlePrev} disabled={currentIdx === 0}>
              Prev
            </button>
            <button className="flashcard-delete-btn" onClick={handleDelete}>
              Remove
            </button>
            <button onClick={handleNext} disabled={currentIdx >= cards.length - 1}>
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
