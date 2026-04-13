import { useCallback, useEffect, useRef, useState } from "react";
import type { WordCardData } from "../lib/session-bridge";

interface Props {
  card: WordCardData | null;
  onDismiss: () => void;
}

const CARD_LIFETIME_MS = 30_000;

export function WordCard({ card, onDismiss }: Props) {
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!card) {
      setVisible(false);
      setExiting(false);
      return;
    }
    setVisible(true);
    setExiting(false);
    timerRef.current = setTimeout(() => dismiss(), CARD_LIFETIME_MS);
    return () => clearTimeout(timerRef.current);
  }, [card]);

  const dismiss = useCallback(() => {
    setExiting(true);
    setTimeout(() => {
      setVisible(false);
      setExiting(false);
      onDismiss();
    }, 400);
  }, [onDismiss]);

  if (!visible || !card) return null;

  return (
    <div className={`vocab-card ${exiting ? "vocab-card-exit" : ""}`}>
      <div className="vocab-card-header">
        <span className="vocab-card-source">📖 Word</span>
        <button onClick={dismiss} className="vocab-card-close-btn" title="Dismiss">×</button>
      </div>
      <div className="word-card-body">
        <div className="word-card-word">{card.word}</div>
        {card.reading && <div className="word-card-reading">{card.reading}</div>}
        <div className="word-card-meaning">{card.meaning}</div>
        {card.context && <div className="word-card-context">{card.context}</div>}
      </div>
    </div>
  );
}
