import { invoke } from "@tauri-apps/api/core";
import type { ContentLine } from "./session-bridge";

// ── YouTube metadata via oEmbed ──────────────────────────────────────────────

export function extractVideoId(url: string): string | null {
  const match =
    url.match(/[?&]v=([^&#]+)/) ??
    url.match(/youtu\.be\/([^?&#]+)/) ??
    url.match(/\/embed\/([^?&#]+)/);
  return match?.[1] ?? null;
}

interface YouTubeMeta {
  title: string;
  author: string;
  videoId: string;
}

export async function fetchYouTubeMeta(url: string): Promise<YouTubeMeta> {
  const videoId = extractVideoId(url);
  if (!videoId) throw new Error("Invalid YouTube URL");

  const res = await fetch(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
  );
  if (!res.ok) throw new Error(`oEmbed failed: ${res.status}`);

  const data = await res.json();
  return {
    title: data.title ?? "",
    author: data.author_name ?? "",
    videoId,
  };
}

// ── Parse song name from YouTube title ───────────────────────────────────────

function parseSongInfo(title: string, author: string): { track: string; artist: string } {
  let track = title;
  let artist = author;

  // Strip bracketed metadata: (cover), [Official MV], 【フルver】, etc.
  track = track
    .replace(/\s*[\[【(（].*?(official|mv|music video|pv|full|lyric|ノンクレジット|OP|ED|opening|ending|cover|ver|カバー|フル).*?[\]】)）]/gi, "")
    .trim();

  // Strip everything after ｜ or | (often show/anime credits)
  track = track.replace(/\s*[｜|].+$/, "").trim();

  // "Artist - Track" pattern
  const dashMatch = track.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (dashMatch) {
    artist = dashMatch[1].trim();
    track = dashMatch[2].trim();
  }

  // "Track / Artist" pattern
  const slashMatch = track.match(/^(.+?)\s*\/\s*(.+)$/);
  if (slashMatch) {
    track = slashMatch[1].trim();
    artist = slashMatch[2].trim();
  }

  // Japanese quotes 「Track」
  const bracketMatch = track.match(/「(.+?)」/);
  if (bracketMatch) {
    track = bracketMatch[1].trim();
  }

  // Strip loose suffixes: フルver, full ver, cover, カバー
  track = track.replace(/\s+(フルver|full\s*ver\.?|cover|カバー)\s*$/gi, "").trim();

  // Strip character/cast names after the core song+artist (common in anime covers)
  // e.g. "キセキ GReeeen  綾小路清隆＆椎名ひより" → "キセキ GReeeen"
  // Heuristic: if multiple double-width spaces or very long, truncate at reasonable boundary
  if (track.length > 40) {
    const dblSpace = track.indexOf("  ");
    if (dblSpace > 5) {
      track = track.slice(0, dblSpace).trim();
    }
  }

  return { track, artist };
}

// ── Simple internet lyrics search ───────────────────────────────────────────
// lyrics.ovh — free, no auth, aggregates from Genius / AZLyrics / Lyrics.com

async function searchLyricsOvh(artist: string, track: string): Promise<string | null> {
  try {
    const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(track)}`;
    console.log("[lyrics] lyrics.ovh:", url);
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.lyrics?.trim();
    return text && text.length > 20 ? text : null;
  } catch (e) {
    console.log("[lyrics] lyrics.ovh failed:", e);
    return null;
  }
}

// ── LRCLIB — synced timestamps ──────────────────────────────────────────────

interface LrcLibResult {
  syncedLyrics: string | null;
  plainLyrics: string | null;
  trackName: string;
  artistName: string;
}

async function searchLrcLib(track: string, artist: string): Promise<LrcLibResult | null> {
  try {
    const exactUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(artist)}`;
    console.log("[lyrics] LRCLIB exact:", exactUrl);

    let res = await fetch(exactUrl);
    if (res.ok) {
      const data = await res.json();
      if (data.syncedLyrics || data.plainLyrics) {
        return {
          syncedLyrics: data.syncedLyrics,
          plainLyrics: data.plainLyrics,
          trackName: data.trackName ?? track,
          artistName: data.artistName ?? artist,
        };
      }
    }

    const searchUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(`${track} ${artist}`)}`;
    console.log("[lyrics] LRCLIB search:", searchUrl);

    res = await fetch(searchUrl);
    if (res.ok) {
      const results = await res.json();
      if (Array.isArray(results) && results.length > 0) {
        const best = results[0];
        return {
          syncedLyrics: best.syncedLyrics,
          plainLyrics: best.plainLyrics,
          trackName: best.trackName ?? track,
          artistName: best.artistName ?? artist,
        };
      }
    }
  } catch (e) {
    console.log("[lyrics] LRCLIB failed:", e);
  }

  return null;
}

// ── Genius via Rust backend (backup for when APIs miss) ─────────────────────

async function searchGenius(track: string, artist: string): Promise<string | null> {
  try {
    const text = await invoke<string>("fetch_genius_lyrics", { track, artist });
    return text && text.trim().length > 20 ? text.trim() : null;
  } catch (e) {
    console.log("[lyrics] Genius failed:", e);
    return null;
  }
}

// ── Parsers ─────────────────────────────────────────────────────────────────

function parseSyncedLyrics(lrc: string): ContentLine[] {
  const lines: ContentLine[] = [];
  let idx = 0;

  for (const raw of lrc.split("\n")) {
    const match = raw.match(/^\[(\d+):(\d+)\.(\d+)\]\s*(.*)$/);
    if (!match) continue;

    const text = match[4].trim();
    if (!text) continue;

    const mins = parseInt(match[1], 10);
    const secs = parseInt(match[2], 10);
    const ms = parseInt(match[3].padEnd(3, "0").slice(0, 3), 10);
    const timestamp = mins * 60 + secs + ms / 1000;

    lines.push({ text, timestamp, source_index: idx });
    idx++;
  }

  return lines;
}

function parsePlainLyrics(text: string): ContentLine[] {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l, i) => ({ text: l.trim(), timestamp: null, source_index: i }));
}

// ── Merge plain text with synced timestamps ─────────────────────────────────

function mergeTextWithTimestamps(plainText: string, lrcSynced: string): ContentLine[] {
  const textLines = plainText
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => l.trim());

  const lrcLines = parseSyncedLyrics(lrcSynced);

  if (lrcLines.length > 0 && Math.abs(textLines.length - lrcLines.length) <= Math.max(3, lrcLines.length * 0.25)) {
    return textLines.map((text, i) => ({
      text,
      timestamp: i < lrcLines.length ? lrcLines[i].timestamp : null,
      source_index: i,
    }));
  }

  return textLines.map((text, i) => ({
    text,
    timestamp: null,
    source_index: i,
  }));
}

// ── Main: fetch lyrics for a YouTube URL ─────────────────────────────────────

export interface LyricsResult {
  lines: ContentLine[];
  title: string;
  artist: string;
  videoId: string;
  synced: boolean;
  source: string;
}

export async function fetchLyricsForYouTube(
  url: string,
  onProgress: (msg: string) => void,
): Promise<LyricsResult> {
  onProgress("Fetching video info…");
  const meta = await fetchYouTubeMeta(url);
  console.log("[lyrics] meta:", meta.title, "by", meta.author);

  const { track, artist } = parseSongInfo(meta.title, meta.author);
  console.log("[lyrics] parsed:", track, "by", artist);

  onProgress("Searching for lyrics…");

  // Search all sources in parallel — simple internet lookups
  const [lrcResult, ovhText, geniusText] = await Promise.all([
    searchLrcLib(track, artist),
    searchLyricsOvh(artist, track),
    searchGenius(track, artist),
  ]);

  // Pick the best text: lyrics.ovh > genius > lrclib plain
  const bestText = ovhText ?? geniusText ?? lrcResult?.plainLyrics ?? null;
  const textSource = ovhText ? "lyrics.ovh" : geniusText ? "genius" : lrcResult?.plainLyrics ? "lrclib" : null;

  const displayTitle = lrcResult
    ? `${lrcResult.trackName} — ${lrcResult.artistName}`
    : meta.title;
  const displayArtist = lrcResult?.artistName ?? artist;

  // Best case: accurate text + synced timestamps
  if (bestText && lrcResult?.syncedLyrics) {
    console.log(`[lyrics] merging ${textSource} text with LRCLIB timestamps`);
    const lines = mergeTextWithTimestamps(bestText, lrcResult.syncedLyrics);
    const hasTimes = lines.some((l) => l.timestamp !== null);
    return {
      lines,
      title: displayTitle,
      artist: displayArtist,
      videoId: meta.videoId,
      synced: hasTimes,
      source: `${textSource}+lrclib`,
    };
  }

  // LRCLIB synced only (timestamps + its own text)
  if (lrcResult?.syncedLyrics) {
    console.log("[lyrics] using LRCLIB synced");
    const lines = parseSyncedLyrics(lrcResult.syncedLyrics);
    if (lines.length > 0) {
      return {
        lines,
        title: displayTitle,
        artist: displayArtist,
        videoId: meta.videoId,
        synced: true,
        source: "lrclib",
      };
    }
  }

  // Plain text from any source (no timestamps)
  if (bestText) {
    console.log(`[lyrics] using ${textSource} (no timestamps)`);
    return {
      lines: parsePlainLyrics(bestText),
      title: displayTitle,
      artist: displayArtist,
      videoId: meta.videoId,
      synced: false,
      source: textSource!,
    };
  }

  console.log("[lyrics] no lyrics found from any source");
  return {
    lines: [],
    title: meta.title,
    artist: meta.author,
    videoId: meta.videoId,
    synced: false,
    source: "none",
  };
}
