use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const FLASHCARD_DIR: &str = "/tmp/samuel-flashcards";
const FLASHCARD_DB: &str = "/tmp/samuel-flashcards/deck.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Flashcard {
    pub id: String,
    pub word: String,
    pub hint: String,
    pub transcript: String,
    pub audio_path: Option<String>,
    pub screenshot_path: Option<String>,
    pub source: String,
    pub created_at: u64,
    pub review_count: u32,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct FlashcardDeck {
    cards: Vec<Flashcard>,
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn ensure_dir() {
    let _ = fs::create_dir_all(FLASHCARD_DIR);
}

fn load_deck() -> FlashcardDeck {
    ensure_dir();
    fs::read_to_string(FLASHCARD_DB)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_deck(deck: &FlashcardDeck) {
    ensure_dir();
    if let Ok(json) = serde_json::to_string_pretty(deck) {
        let _ = fs::write(FLASHCARD_DB, json);
    }
}

/// Save the current learning audio clip to the flashcards directory.
/// Returns the path to the saved clip, or None if the source doesn't exist.
pub fn save_audio_clip(source_path: &str) -> Option<String> {
    if !Path::new(source_path).exists() {
        return None;
    }
    ensure_dir();
    let ts = now_epoch();
    let dest = format!("{FLASHCARD_DIR}/clip-{ts}.m4a");
    fs::copy(source_path, &dest).ok()?;
    eprintln!("[flashcards] saved audio clip: {dest}");
    Some(dest)
}

/// Save a screenshot (base64 JPEG) to the flashcards directory.
/// Returns the path to the saved image.
pub fn save_screenshot(b64_jpeg: &str) -> Option<String> {
    ensure_dir();
    let ts = now_epoch();
    let dest = format!("{FLASHCARD_DIR}/screen-{ts}.jpg");
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        b64_jpeg,
    )
    .ok()?;
    fs::write(&dest, bytes).ok()?;
    eprintln!("[flashcards] saved screenshot: {dest}");
    Some(dest)
}

/// Add a flashcard to the deck.
pub fn add_card(
    word: String,
    hint: String,
    transcript: String,
    audio_path: Option<String>,
    screenshot_path: Option<String>,
    source: String,
) -> Flashcard {
    let mut deck = load_deck();
    let card = Flashcard {
        id: format!("fc-{}", now_epoch()),
        word,
        hint,
        transcript,
        audio_path,
        screenshot_path,
        source,
        created_at: now_epoch(),
        review_count: 0,
    };
    deck.cards.push(card.clone());
    save_deck(&deck);
    eprintln!("[flashcards] added card: {} (deck size: {})", card.id, deck.cards.len());
    card
}

/// Clean up the entire flashcards directory (called on app launch).
pub fn cleanup() {
    if Path::new(FLASHCARD_DIR).exists() {
        let count = fs::read_dir(FLASHCARD_DIR)
            .map(|entries| entries.count())
            .unwrap_or(0);
        let _ = fs::remove_dir_all(FLASHCARD_DIR);
        eprintln!("[flashcards] cleaned up {count} files from previous session");
    }
}

// ── Tauri commands ──────────────────────────────────────────

#[tauri::command]
pub async fn get_flashcard_deck() -> Result<Vec<Flashcard>, String> {
    Ok(load_deck().cards)
}

#[tauri::command]
pub async fn save_flashcard(
    word: String,
    hint: String,
    transcript: String,
    audio_clip_path: Option<String>,
    screenshot_path: Option<String>,
    source: String,
) -> Result<Flashcard, String> {
    let audio = audio_clip_path.and_then(|p| {
        if Path::new(&p).exists() { Some(p) } else { None }
    });
    let screenshot = screenshot_path.and_then(|p| {
        if Path::new(&p).exists() { Some(p) } else { None }
    });

    Ok(add_card(word, hint, transcript, audio, screenshot, source))
}

#[tauri::command]
pub async fn delete_flashcard(card_id: String) -> Result<(), String> {
    let mut deck = load_deck();
    if let Some(pos) = deck.cards.iter().position(|c| c.id == card_id) {
        let card = deck.cards.remove(pos);
        if let Some(ref p) = card.audio_path {
            let _ = fs::remove_file(p);
        }
        if let Some(ref p) = card.screenshot_path {
            let _ = fs::remove_file(p);
        }
        save_deck(&deck);
    }
    Ok(())
}

/// Read a flashcard file (audio or image) as base64 for browser playback/display.
#[tauri::command]
pub async fn read_flashcard_file(file_path: String) -> Result<String, String> {
    let data = fs::read(&file_path).map_err(|e| format!("read file: {e}"))?;
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &data);
    Ok(b64)
}

#[tauri::command]
pub async fn increment_flashcard_review(card_id: String) -> Result<(), String> {
    let mut deck = load_deck();
    if let Some(card) = deck.cards.iter_mut().find(|c| c.id == card_id) {
        card.review_count += 1;
        save_deck(&deck);
    }
    Ok(())
}
