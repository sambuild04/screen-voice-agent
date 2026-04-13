use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use crate::memory;

/// Safe UTF-8 truncation — never slices in the middle of a multi-byte character.
fn truncate_str(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

static DEFAULT_DISPLAY: AtomicU32 = AtomicU32::new(1);

// Holds the child process for the system audio recorder (Swift helper)
static RECORDING_CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);

// Persistent audio recorder for learning mode (separate from manual recording)
static LEARNING_AUDIO_CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);
const LEARNING_AUDIO_PATH: &str = "/tmp/samuel-learning-audio.m4a";

// Screen change detection state
struct ScreenState {
    last_hash: u64,
    last_app: String,
    last_analysis: Instant,
}
static SCREEN_STATE: Mutex<Option<ScreenState>> = Mutex::new(None);


// Apps where Samuel stays silent (deep focus)
const FOCUS_APPS: &[&str] = &[
    "Cursor", "Code", "Xcode", "Terminal", "iTerm2",
    "Notion", "Obsidian", "Pages", "Word", "Alacritty",
    "kitty", "Warp", "IntelliJ", "PyCharm", "WebStorm",
];

const TEMP_FILES: &[&str] = &[
    "/tmp/samuel-recording.m4a",
    "/tmp/samuel-screen.png",
    "/tmp/samuel-screen.jpg",
    "/tmp/samuel-screen-debug.jpg",
    "/tmp/samuel-wake-audio.webm",
    "/tmp/samuel-wake-audio.mp4",
    "/tmp/samuel-wake-debug.webm",
    "/tmp/samuel-wake-debug.mp4",
    "/tmp/samuel-learning-req.json",
    "/tmp/samuel-learning-clip.m4a",
    "/tmp/samuel-learning-audio.m4a",
];

/// Remove leftover temp files from previous sessions.
pub fn cleanup_temp_files() {
    for path in TEMP_FILES {
        let _ = fs::remove_file(path);
    }
    eprintln!("[cleanup] removed stale temp files");
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CaptureResult {
    pub base64: String,
    pub app_name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DisplayInfo {
    pub index: u32,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Config {
    pub api_key: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub delay_ms: Option<u64>,
}

fn find_peekaboo() -> &'static str {
    static PATHS: &[&str] = &["/opt/homebrew/bin/peekaboo", "/usr/local/bin/peekaboo"];
    for p in PATHS {
        if std::path::Path::new(p).exists() {
            return p;
        }
    }
    "peekaboo"
}

fn run_peekaboo(args: &[&str]) -> Result<String, String> {
    let bin = find_peekaboo();
    let output = Command::new(bin)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run peekaboo ({bin}): {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("peekaboo error: {stderr}"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Mint a short-lived ephemeral client token via POST /v1/realtime/client_secrets.
/// The frontend SDK uses this token to establish its own WebRTC connection.
#[tauri::command]
pub async fn create_ephemeral_key() -> Result<String, String> {
    eprintln!("[ephemeral-key] requesting...");
    let config = read_config_internal()?;
    let api_key = config
        .api_key
        .ok_or("No API key configured in ~/.books-reader.json or OPENAI_API_KEY env")?;

    let body = serde_json::json!({
        "session": {
            "type": "realtime",
            "model": "gpt-realtime"
        }
    });

    let output = Command::new("/usr/bin/curl")
        .args([
            "-s",
            "--max-time", "10",
            "-X", "POST",
            "https://api.openai.com/v1/realtime/client_secrets",
            "-H", &format!("Authorization: Bearer {api_key}"),
            "-H", "Content-Type: application/json",
            "-d", &body.to_string(),
        ])
        .output()
        .map_err(|e| {
            eprintln!("[ephemeral-key] curl failed: {e}");
            format!("Failed to call OpenAI: {e}")
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("[ephemeral-key] error: {stderr}");
        return Err(format!("Ephemeral key error: {stderr}"));
    }

    let response_str = String::from_utf8_lossy(&output.stdout).to_string();
    let response: serde_json::Value = serde_json::from_str(&response_str)
        .map_err(|e| {
            eprintln!("[ephemeral-key] parse error: {e}");
            format!("Parse ephemeral key response: {e}")
        })?;

    if let Some(err) = response.get("error") {
        eprintln!("[ephemeral-key] OpenAI error: {err}");
        return Err(format!("OpenAI error: {err}"));
    }

    eprintln!("[ephemeral-key] success");
    response["value"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| format!("No 'value' in ephemeral key response: {response_str}"))
}



/// Capture a window or display. If `app_name` is provided, target that app;
/// otherwise use the default display chosen via the UI picker.
#[tauri::command]
pub async fn capture_active_window(app_name: Option<String>) -> Result<CaptureResult, String> {
    capture_focused_window(app_name)
}

/// Read the currently selected/highlighted text from any app via the clipboard.
/// Saves and restores the user's clipboard contents.
#[tauri::command]
pub async fn get_selected_text() -> Result<String, String> {
    // 1. Save current clipboard
    let prev = Command::new("pbpaste")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    // 2. Clear clipboard so we can detect if Cmd+C wrote something
    let _ = Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            if let Some(ref mut stdin) = child.stdin {
                use std::io::Write;
                let _ = stdin.write_all(b"");
            }
            child.wait()
        });

    // 3. Simulate Cmd+C on the user-facing app
    let target = get_user_facing_app().unwrap_or_default();
    eprintln!("[selected-text] copying from: {:?}", target);

    let copy_script = if target.is_empty() {
        // No specific app found — just send Cmd+C globally
        r#"tell application "System Events" to keystroke "c" using command down"#.to_string()
    } else {
        format!(
            r#"tell application "{target}" to activate
delay 0.1
tell application "System Events" to keystroke "c" using command down"#
        )
    };
    let _ = Command::new("/usr/bin/osascript")
        .args(["-e", &copy_script])
        .output();

    // 4. Brief pause for clipboard to update
    std::thread::sleep(std::time::Duration::from_millis(200));

    // 5. Read the new clipboard
    let selected = Command::new("pbpaste")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    // 6. Restore original clipboard
    let mut restore = Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("pbcopy restore: {e}"))?;
    if let Some(ref mut stdin) = restore.stdin {
        use std::io::Write;
        let _ = stdin.write_all(prev.as_bytes());
    }
    let _ = restore.wait();

    eprintln!("[selected-text] got: {:?}", truncate_str(&selected, 80));
    Ok(selected)
}

/// Enumerate connected displays for the UI picker.
#[tauri::command]
pub async fn list_displays() -> Result<Vec<DisplayInfo>, String> {
    // NSScreen descriptions via AppleScript — returns localized display names.
    let script = r#"
use framework "AppKit"
set screens to current application's NSScreen's screens()
set output to ""
repeat with i from 1 to count of screens
  set scr to item i of screens
  set nm to (scr's localizedName()) as text
  set output to output & i & "|" & nm & linefeed
end repeat
return output"#;
    let out = Command::new("/usr/bin/osascript")
        .args(["-l", "AppleScript", "-e", script])
        .output()
        .map_err(|e| format!("list_displays: {e}"))?;
    let raw = String::from_utf8_lossy(&out.stdout);
    let mut displays = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        if let Some((idx_str, name)) = line.split_once('|') {
            if let Ok(idx) = idx_str.trim().parse::<u32>() {
                displays.push(DisplayInfo { index: idx, name: name.trim().to_string() });
            }
        }
    }
    if displays.is_empty() {
        displays.push(DisplayInfo { index: 1, name: "Main Display".to_string() });
    }
    eprintln!("[displays] found: {:?}", displays);
    Ok(displays)
}

/// Set which display to capture by default when no specific app is requested.
#[tauri::command]
pub async fn set_default_display(index: u32) -> Result<(), String> {
    DEFAULT_DISPLAY.store(index, Ordering::Relaxed);
    eprintln!("[displays] default set to {index}");
    Ok(())
}

/// Determine which macOS display (1-indexed) holds the given app's main window.
fn find_display_for_app(app: &str) -> Option<u32> {
    // Get the window's top-left {x, y} position
    let script = format!(
        r#"tell application "System Events"
  try
    set appProc to application process "{}"
    set winPos to position of window 1 of appProc
    return ((item 1 of winPos) as text) & "," & ((item 2 of winPos) as text)
  on error
    return "none"
  end try
end tell"#,
        app
    );
    let out = Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .output()
        .ok()?;
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if raw == "none" || raw.is_empty() { return None; }
    let parts: Vec<&str> = raw.split(',').collect();
    if parts.len() != 2 { return None; }
    let wx: f64 = parts[0].trim().parse().ok()?;
    let wy: f64 = parts[1].trim().parse().ok()?;

    // Get each screen's frame (origin + size) to determine which display
    let screen_script = r#"
use framework "AppKit"
set screens to current application's NSScreen's screens()
set output to ""
repeat with i from 1 to count of screens
  set scr to item i of screens
  set f to scr's frame()
  set ox to (f's origin's x) as real
  set oy to (f's origin's y) as real
  set sw to (f's |size|'s width) as real
  set sh to (f's |size|'s height) as real
  set output to output & i & "|" & ox & "|" & oy & "|" & sw & "|" & sh & linefeed
end repeat
return output"#;
    let s_out = Command::new("/usr/bin/osascript")
        .args(["-l", "AppleScript", "-e", screen_script])
        .output()
        .ok()?;
    let s_raw = String::from_utf8_lossy(&s_out.stdout);
    for line in s_raw.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }
        let fields: Vec<&str> = line.split('|').collect();
        if fields.len() != 5 { continue; }
        let idx: u32 = fields[0].trim().parse().ok()?;
        let ox: f64 = fields[1].trim().parse().ok()?;
        let oy: f64 = fields[2].trim().parse().ok()?;
        let sw: f64 = fields[3].trim().parse().ok()?;
        let sh: f64 = fields[4].trim().parse().ok()?;
        if wx >= ox && wx < ox + sw && wy >= oy && wy < oy + sh {
            return Some(idx);
        }
    }
    None
}

/// Internal helper — captures what the user is looking at.
fn capture_focused_window(requested_app: Option<String>) -> Result<CaptureResult, String> {
    let tmp_png = "/tmp/samuel-screen.png";
    let tmp_jpg = "/tmp/samuel-screen.jpg";
    let debug_jpg = "/tmp/samuel-screen-debug.jpg";

    // Resolve which app to target
    let target_app = if let Some(ref name) = requested_app {
        if name.is_empty() {
            // Empty string means "auto-detect the user's real foreground app"
            get_user_facing_app()
        } else {
            // User/model specified an app by name — find the best match from visible apps
            let script = r#"tell application "System Events"
  set appList to name of every application process whose visible is true
  set output to ""
  repeat with a in appList
    set output to output & a & linefeed
  end repeat
  return output
end tell"#;
            let app_output = Command::new("/usr/bin/osascript")
                .args(["-e", script])
                .output()
                .map_err(|e| format!("Get app list: {e}"))?;
            let app_list_raw = String::from_utf8_lossy(&app_output.stdout);
            let needle = name.to_lowercase();
            app_list_raw
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .find(|l| l.to_lowercase().contains(&needle))
        }
    } else {
        // No app specified at all — auto-detect user-facing app
        get_user_facing_app()
    };

    let app_label = target_app.clone()
        .or_else(|| requested_app.clone())
        .unwrap_or_else(|| "Desktop".to_string());
    eprintln!("[capture] target: {:?} (requested: {:?})", app_label, requested_app);

    let mut used_full_screen = false;

    // Try peekaboo window capture for the resolved app
    if let Some(ref app) = target_app {
        let _ = run_peekaboo(&[
            "image", "--app", app, "--format", "png", "--path", tmp_png,
        ]);
    }

    let peekaboo_ok = fs::metadata(tmp_png)
        .map(|m| m.len() > 10_000)
        .unwrap_or(false);

    if !peekaboo_ok {
        let _ = fs::remove_file(tmp_png);

        // Decide which display to capture
        let display_idx = if let Some(ref app) = target_app {
            find_display_for_app(app).unwrap_or_else(|| DEFAULT_DISPLAY.load(Ordering::Relaxed))
        } else {
            DEFAULT_DISPLAY.load(Ordering::Relaxed)
        };

        eprintln!("[capture] falling back to display {display_idx}");
        let d_flag = format!("-D{display_idx}");
        let sc = Command::new("/usr/sbin/screencapture")
            .args(["-x", &d_flag, tmp_png])
            .output()
            .map_err(|e| format!("screencapture failed: {e}"))?;
        if !sc.status.success() {
            return Err("screencapture failed".to_string());
        }
        used_full_screen = true;
    }

    let data = fs::read(tmp_png).map_err(|e| format!("Read capture: {e}"))?;
    eprintln!("[capture] raw PNG: {} bytes", data.len());

    if data.len() < 1000 {
        let _ = fs::remove_file(tmp_png);
        return Err("Captured image too small — check Screen Recording permissions.".to_string());
    }

    let sips_result = Command::new("/usr/bin/sips")
        .args([
            "--resampleWidth", "1024",
            "--setProperty", "format", "jpeg",
            "--setProperty", "formatOptions", "60",
            tmp_png,
            "--out", tmp_jpg,
        ])
        .output();

    let _ = fs::remove_file(tmp_png);

    let final_path = match sips_result {
        Ok(output) if output.status.success() => tmp_jpg,
        _ => return Err("Failed to resize screenshot".to_string()),
    };

    let jpg_data = fs::read(final_path).map_err(|e| format!("Read JPEG: {e}"))?;
    eprintln!("[capture] final JPEG: {} bytes (full_screen={})", jpg_data.len(), used_full_screen);

    let _ = fs::copy(final_path, debug_jpg);
    let _ = fs::remove_file(final_path);

    let label = if used_full_screen {
        let d = if let Some(ref app) = target_app {
            find_display_for_app(app)
                .map(|i| format!("Display {i}"))
                .unwrap_or_else(|| format!("Display {}", DEFAULT_DISPLAY.load(Ordering::Relaxed)))
        } else {
            format!("Display {}", DEFAULT_DISPLAY.load(Ordering::Relaxed))
        };
        format!("{d} ({app_label})")
    } else {
        app_label
    };

    let b64 = base64::engine::general_purpose::STANDARD.encode(&jpg_data);
    Ok(CaptureResult { base64: b64, app_name: label })
}

/// PLACEHOLDER_CUA_START
/// Read the user config from ~/.books-reader.json.
#[tauri::command]
pub async fn get_config() -> Result<Config, String> {
    read_config_internal()
}

pub fn read_config_internal() -> Result<Config, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let path = home.join(".books-reader.json");

    if !path.exists() {
        let api_key = std::env::var("OPENAI_API_KEY").ok();
        return Ok(Config {
            api_key,
            provider: Some("openai".to_string()),
            model: None,
            delay_ms: Some(800),
        });
    }

    let contents = fs::read_to_string(&path).map_err(|e| format!("Read config: {e}"))?;
    let raw: serde_json::Value =
        serde_json::from_str(&contents).map_err(|e| format!("Parse config: {e}"))?;

    let api_key = raw["apiKey"]
        .as_str()
        .map(String::from)
        .or_else(|| std::env::var("OPENAI_API_KEY").ok());

    Ok(Config {
        api_key,
        provider: raw["provider"].as_str().map(String::from),
        model: raw["model"].as_str().map(String::from),
        delay_ms: raw["delayMs"].as_u64().or(Some(800)),
    })
}

// ---------------------------------------------------------------------------
// Recording — system audio capture + Whisper transcription + GPT-4o analysis
// ---------------------------------------------------------------------------

const RECORDING_PATH: &str = "/tmp/samuel-recording.m4a";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScriptLine {
    pub timestamp: String,
    pub text: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VocabEntry {
    pub word: String,
    pub reading: String,
    pub meaning: String,
    pub level: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GrammarPoint {
    pub pattern: String,
    pub explanation: String,
    pub examples: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecordingAnalysis {
    pub transcript: Vec<ScriptLine>,
    pub translated_transcript: Vec<ScriptLine>,
    pub vocabulary: Vec<VocabEntry>,
    pub grammar: Vec<GrammarPoint>,
    pub summary: String,
}

fn find_record_helper() -> Result<String, String> {
    // Look for the compiled binary next to the swift source
    let candidates = [
        // dev — relative to the tauri src-tauri dir
        concat!(env!("CARGO_MANIFEST_DIR"), "/helpers/record-audio"),
    ];
    for p in &candidates {
        if std::path::Path::new(p).exists() {
            return Ok(p.to_string());
        }
    }
    Err(
        "record-audio helper not found. Compile it with: \
         swiftc -o src-tauri/helpers/record-audio src-tauri/helpers/record-audio.swift \
         -framework ScreenCaptureKit -framework AVFoundation -framework CoreMedia"
            .to_string(),
    )
}

#[tauri::command]
pub async fn start_recording() -> Result<String, String> {
    let helper = find_record_helper()?;

    let mut guard = RECORDING_CHILD
        .lock()
        .map_err(|e| format!("lock error: {e}"))?;

    if guard.is_some() {
        return Err("Recording already in progress".to_string());
    }

    // Remove stale file
    let _ = fs::remove_file(RECORDING_PATH);

    let child = std::process::Command::new(&helper)
        .arg(RECORDING_PATH)
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Failed to start record-audio: {e}"))?;

    eprintln!("[recording] started pid={}", child.id());
    *guard = Some(child);

    Ok("Recording started".to_string())
}

#[tauri::command]
pub async fn stop_recording() -> Result<String, String> {
    let mut guard = RECORDING_CHILD
        .lock()
        .map_err(|e| format!("lock error: {e}"))?;

    let mut child = guard
        .take()
        .ok_or("No recording in progress")?;

    // Send SIGTERM so the helper finalizes the file
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
        }
    }

    // Wait for clean exit (up to 5s)
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                if start.elapsed().as_secs() > 5 {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => return Err(format!("wait error: {e}")),
        }
    }

    eprintln!("[recording] stopped");

    if !std::path::Path::new(RECORDING_PATH).exists() {
        return Err("Recording file not found — capture may have failed".to_string());
    }

    let meta = fs::metadata(RECORDING_PATH)
        .map_err(|e| format!("stat: {e}"))?;
    eprintln!("[recording] file size: {:.1}KB", meta.len() as f64 / 1024.0);

    Ok(RECORDING_PATH.to_string())
}

#[tauri::command]
pub async fn analyze_recording() -> Result<RecordingAnalysis, String> {
    let config = read_config_internal()?;
    let api_key = config
        .api_key
        .ok_or("No API key configured")?;

    if !std::path::Path::new(RECORDING_PATH).exists() {
        return Err("No recording file found — record first".to_string());
    }

    eprintln!("[recording] transcribing with gpt-4o-transcribe (ja)...");

    // Step 1: Transcribe with gpt-4o-transcribe — much better at capturing
    // anime dialogue under background music/SFX than whisper-1.
    // Returns json format (no verbose_json with per-segment timestamps).
    let whisper_output = Command::new("curl")
        .args([
            "-s",
            "--max-time", "120",
            "-X", "POST",
            "https://api.openai.com/v1/audio/transcriptions",
            "-H", &format!("Authorization: Bearer {api_key}"),
            "-F", &format!("file=@{RECORDING_PATH}"),
            "-F", "model=gpt-4o-transcribe",
            "-F", "prompt=Transcribe the dialogue from this video/anime clip accurately. There may be background music and sound effects. Ignore any system messages at the very start like 'Recording has started'.",
        ])
        .output()
        .map_err(|e| format!("curl transcribe: {e}"))?;

    if !whisper_output.status.success() {
        return Err(format!(
            "Transcribe API error: {}",
            String::from_utf8_lossy(&whisper_output.stderr)
        ));
    }

    let whisper_body: serde_json::Value = serde_json::from_slice(&whisper_output.stdout)
        .map_err(|e| format!("parse transcribe response: {e}"))?;

    if let Some(err) = whisper_body.get("error") {
        return Err(format!(
            "Transcribe API: {}",
            err["message"].as_str().unwrap_or("unknown")
        ));
    }

    let full_text = whisper_body["text"]
        .as_str()
        .unwrap_or("")
        .to_string();

    // gpt-4o-transcribe returns plain text without segment timestamps.
    // Split by sentence-ending punctuation (supports CJK and Latin).
    let mut transcript_lines: Vec<ScriptLine> = Vec::new();
    let mut current = String::new();
    let terminators = ['。', '！', '？', '!', '?', '.'];
    for ch in full_text.chars() {
        current.push(ch);
        if terminators.contains(&ch) {
            let trimmed = current.trim().to_string();
            if !trimmed.is_empty() {
                transcript_lines.push(ScriptLine {
                    timestamp: format!("#{}", transcript_lines.len() + 1),
                    text: trimmed,
                });
            }
            current.clear();
        }
    }
    // Leftover text without a terminator
    let leftover = current.trim().to_string();
    if !leftover.is_empty() {
        transcript_lines.push(ScriptLine {
            timestamp: format!("#{}", transcript_lines.len() + 1),
            text: leftover,
        });
    }

    if full_text.is_empty() {
        return Ok(RecordingAnalysis {
            transcript: transcript_lines,
            translated_transcript: vec![],
            vocabulary: vec![],
            grammar: vec![],
            summary: "No speech detected in the recording.".to_string(),
        });
    }

    eprintln!(
        "[recording] transcript: {} chars, {} segments — analyzing with GPT-4o...",
        full_text.len(),
        transcript_lines.len()
    );

    // Step 2: Analyze with GPT-4o
    let analysis_prompt = format!(
        r#"You are a language tutor. Analyze the following transcript from a video/anime clip. First detect what language is being spoken, then provide a full breakdown. The audio may contain background music/SFX — do your best.

NOTE: Ignore any system messages at the start (e.g. "Recording has started" or instructions about recording). Focus only on the actual dialogue.

Transcript:
{full_text}

Return a JSON object with exactly these fields:
{{
  "translated_transcript": [
    {{ "original": "original line in source language", "translation": "English translation" }}
  ],
  "vocabulary": [
    {{ "word": "original word", "reading": "pronunciation/reading aid", "meaning": "English meaning", "level": "proficiency level" }}
  ],
  "grammar": [
    {{ "pattern": "grammar pattern name", "explanation": "Clear explanation in English", "examples": ["actual phrase from transcript that uses this pattern"] }}
  ],
  "summary": "Brief English summary of what was said (2-3 sentences)"
}}

Guidelines:
- Detect the language automatically from the transcript.
- For translated_transcript: include every meaningful dialogue line from the transcript with its English translation. Keep the original text exactly as transcribed.
- Include ALL meaningful vocabulary. Include common words too for beginners.
- For vocabulary: word in original script, reading/pronunciation aid (e.g. hiragana for Japanese, pinyin for Chinese, romaji, etc.), English meaning, proficiency level (e.g. JLPT N5-N1 for Japanese, HSK 1-6 for Chinese, CEFR A1-C2 for European languages, or "—" if unsure).
- For grammar: extract grammar patterns that are actually used in the transcript. For each one, put the pattern name in "pattern", a clear explanation in "explanation", and in "examples" include the actual phrase from the transcript that uses this pattern. Every transcript has grammar — identify at least the key conjugations, sentence forms, and speech patterns.
- Summary should explain the scene/conversation briefly in English.
- Return ONLY valid JSON, no markdown fences."#
    );

    let gpt_payload = serde_json::json!({
        "model": "gpt-4o",
        "messages": [
            { "role": "user", "content": analysis_prompt }
        ],
        "temperature": 0.3,
        "max_tokens": 4000
    });

    let gpt_output = Command::new("curl")
        .args([
            "-s",
            "--max-time", "60",
            "-X", "POST",
            "https://api.openai.com/v1/chat/completions",
            "-H", &format!("Authorization: Bearer {api_key}"),
            "-H", "Content-Type: application/json",
            "-d", &gpt_payload.to_string(),
        ])
        .output()
        .map_err(|e| format!("curl gpt: {e}"))?;

    if !gpt_output.status.success() {
        return Err(format!(
            "GPT API error: {}",
            String::from_utf8_lossy(&gpt_output.stderr)
        ));
    }

    let gpt_body: serde_json::Value = serde_json::from_slice(&gpt_output.stdout)
        .map_err(|e| format!("parse GPT response: {e}"))?;

    if let Some(err) = gpt_body.get("error") {
        return Err(format!(
            "GPT API: {}",
            err["message"].as_str().unwrap_or("unknown")
        ));
    }

    let content = gpt_body["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("{}");

    // Strip potential markdown code fences
    let cleaned = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    eprintln!("[recording] raw GPT grammar: {:?}",
        serde_json::from_str::<serde_json::Value>(cleaned)
            .ok()
            .and_then(|v| v.get("grammar").cloned())
    );

    let analysis: serde_json::Value = serde_json::from_str(cleaned).unwrap_or_else(|_| {
        serde_json::json!({
            "vocabulary": [],
            "grammar": [],
            "summary": content
        })
    });

    let translated_transcript: Vec<ScriptLine> = analysis["translated_transcript"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    Some(ScriptLine {
                        timestamp: t["original"].as_str()?.to_string(),
                        text: t["translation"].as_str().unwrap_or("").to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let vocabulary: Vec<VocabEntry> = analysis["vocabulary"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    Some(VocabEntry {
                        word: v["word"].as_str()?.to_string(),
                        reading: v["reading"].as_str().unwrap_or("").to_string(),
                        meaning: v["meaning"].as_str().unwrap_or("").to_string(),
                        level: v["level"].as_str().unwrap_or("—").to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let grammar: Vec<GrammarPoint> = analysis["grammar"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|g| {
                    Some(GrammarPoint {
                        pattern: g["pattern"].as_str()?.to_string(),
                        explanation: g["explanation"].as_str().unwrap_or("").to_string(),
                        examples: g["examples"]
                            .as_array()
                            .map(|e| {
                                e.iter()
                                    .filter_map(|s| s.as_str().map(String::from))
                                    .collect()
                            })
                            .unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let summary = analysis["summary"]
        .as_str()
        .unwrap_or("Analysis complete.")
        .to_string();

    eprintln!(
        "[recording] analysis done: {} vocab, {} grammar points",
        vocabulary.len(),
        grammar.len()
    );

    Ok(RecordingAnalysis {
        transcript: transcript_lines,
        translated_transcript,
        vocabulary,
        grammar,
        summary,
    })
}

/// Transcribe a recording without running GPT-4o analysis.
/// Returns the raw transcript text — Samuel handles the analysis on demand.
#[tauri::command]
pub async fn transcribe_recording() -> Result<String, String> {
    let config = read_config_internal()?;
    let api_key = config
        .api_key
        .ok_or("No API key configured")?;

    if !std::path::Path::new(RECORDING_PATH).exists() {
        return Err("No recording file found — record first".to_string());
    }

    eprintln!("[recording] transcribing with gpt-4o-transcribe...");

    let whisper_output = Command::new("curl")
        .args([
            "-s",
            "--max-time", "120",
            "-X", "POST",
            "https://api.openai.com/v1/audio/transcriptions",
            "-H", &format!("Authorization: Bearer {api_key}"),
            "-F", &format!("file=@{RECORDING_PATH}"),
            "-F", "model=gpt-4o-transcribe",
            "-F", "prompt=Transcribe accurately. There may be background music and sound effects. Ignore system messages like 'Recording has started'.",
        ])
        .output()
        .map_err(|e| format!("curl transcribe: {e}"))?;

    if !whisper_output.status.success() {
        return Err(format!(
            "Transcribe API error: {}",
            String::from_utf8_lossy(&whisper_output.stderr)
        ));
    }

    let whisper_body: serde_json::Value = serde_json::from_slice(&whisper_output.stdout)
        .map_err(|e| format!("parse transcribe response: {e}"))?;

    if let Some(err) = whisper_body.get("error") {
        return Err(format!(
            "Transcribe API: {}",
            err["message"].as_str().unwrap_or("unknown")
        ));
    }

    let text = whisper_body["text"]
        .as_str()
        .unwrap_or("")
        .to_string();

    eprintln!("[recording] transcript: {} chars", text.len());
    Ok(text)
}

// ---------------------------------------------------------------------------
// Learning Mode — periodic screen scan for target language content
// ---------------------------------------------------------------------------

/// Fast hash of byte data — samples every 64th byte for speed.
fn hash_bytes(data: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    for (i, &byte) in data.iter().enumerate() {
        if i % 64 == 0 {
            byte.hash(&mut hasher);
        }
    }
    hasher.finish()
}

/// Get the frontmost application name via AppleScript.
fn get_frontmost_app_name() -> String {
    let output = Command::new("/usr/bin/osascript")
        .args([
            "-e",
            r#"tell application "System Events" to get name of first application process whose frontmost is true"#,
        ])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        }
        _ => String::new(),
    }
}

/// Apps to skip when auto-detecting the user's real foreground app.
const EXCLUDED_APPS: &[&str] = &["samuel", "cursor", "electron"];

/// Get the user-facing frontmost app, skipping overlay/IDE apps.
/// Returns the first visible app (ordered by layer) that isn't Samuel or Cursor.
fn get_user_facing_app() -> Option<String> {
    let script = r#"tell application "System Events"
  set appList to name of every application process whose visible is true
  return appList
end tell"#;
    let output = Command::new("/usr/bin/osascript")
        .args(["-e", script])
        .output()
        .ok()?;
    if !output.status.success() { return None; }
    let raw = String::from_utf8_lossy(&output.stdout);
    // macOS returns comma-separated, frontmost first
    for name in raw.split(',') {
        let name = name.trim();
        if name.is_empty() { continue; }
        let lower = name.to_lowercase();
        if EXCLUDED_APPS.iter().any(|&ex| lower.contains(ex)) { continue; }
        return Some(name.to_string());
    }
    None
}

/// Capture the active window and ask GPT-4o Vision whether the target language
/// is visible. Uses screen change detection to skip redundant API calls.
#[tauri::command]
pub async fn check_screen_for_language(language: String) -> Result<Option<String>, String> {
    let config = read_config_internal()?;
    let api_key = config
        .api_key
        .ok_or("No API key configured")?;

    let capture = capture_focused_window(None)?;
    let b64 = &capture.base64;

    if b64.len() < 100 {
        return Ok(None);
    }

    // Screen change detection: hash the screenshot, compare with last state
    let current_hash = hash_bytes(b64.as_bytes());
    let current_app = get_frontmost_app_name();
    {
        let mut state = SCREEN_STATE.lock().unwrap();
        if let Some(ref prev) = *state {
            let same_hash = prev.last_hash == current_hash;
            let same_app = prev.last_app == current_app;
            let recent = prev.last_analysis.elapsed().as_secs() < 90;
            if same_hash && same_app && recent {
                eprintln!(
                    "[learning-mode] screen unchanged (app={}, {}s ago), skipping GPT-4o",
                    current_app,
                    prev.last_analysis.elapsed().as_secs()
                );
                return Ok(None);
            }
        }
        *state = Some(ScreenState {
            last_hash: current_hash,
            last_app: current_app.clone(),
            last_analysis: Instant::now(),
        });
    }

    let prompt = format!(
        "Scan this screenshot for a {language} learner.\n\
         CRITICAL RULE: You may ONLY pick words or text that are ACTUALLY VISIBLE on the screenshot. \
         NEVER invent, infer, or suggest vocabulary that is not literally on screen.\n\n\
         PRIORITY 1: If you find {language} text (subtitles, UI, articles, chat), pick 1-2 interesting \
         words or grammar patterns that are visible on screen and explain them briefly (2-3 sentences, voice-friendly).\n\
         PRIORITY 2: If there is interesting English text or a clearly identifiable concept visible \
         on screen, teach the {language} equivalent. Frame it as: \
         \"Do you know how to say [X] in {language}? It's [word/phrase] ([reading]).\"\n\
         IMPORTANT FILTERS:\n\
         - ONLY reference text or objects that are ACTUALLY VISIBLE in the screenshot.\n\
         - If the screen has Chinese/Korean/other non-{language} text, respond NONE. \
         Do NOT use Chinese text as a springboard to teach random {language} vocabulary.\n\
         - NEVER pick character names, proper nouns, or names of people/places \
         (e.g. Gohan/悟飯, Vegeta/ベジータ, Goku/悟空, Naruto, 一ノ瀬, 堀北, etc.).\n\
         - NEVER pick common loanwords the learner already knows from English \
         (e.g. フィニッシュ/finish, テレビ/TV, スマートフォン/smartphone).\n\
         - NEVER suggest generic vocabulary unrelated to the screen (e.g. \"Do you know how to say stairs/school/smartphone?\") \
         when there is nothing on screen that prompted it.\n\
         - Pick something specific, visually prominent, and genuinely useful.\n\
         Respond NONE if: the screen is empty, a plain desktop, has only names, has only non-{language} text, \
         or has nothing genuinely teachable."
    );

    let request_body = serde_json::json!({
        "model": "gpt-4o",
        "messages": [
            {
                "role": "system",
                "content": format!(
                    "You are a {language} language learning assistant. \
                     You scan screenshots and highlight interesting vocabulary or grammar for a learner. \
                     You also teach {language} equivalents of interesting non-{language} content on screen. \
                     Keep responses very short and suitable for a voice assistant."
                )
            },
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": prompt },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": format!("data:image/jpeg;base64,{b64}"),
                            "detail": "low"
                        }
                    }
                ]
            }
        ],
        "max_tokens": 300
    });

    let body_str = serde_json::to_string(&request_body)
        .map_err(|e| format!("JSON error: {e}"))?;

    let body_path = "/tmp/samuel-learning-req.json";
    fs::write(body_path, &body_str)
        .map_err(|e| format!("Write request: {e}"))?;

    let output = Command::new("/usr/bin/curl")
        .args([
            "-s",
            "--max-time", "20",
            "-X", "POST",
            "https://api.openai.com/v1/chat/completions",
            "-H", &format!("Authorization: Bearer {api_key}"),
            "-H", "Content-Type: application/json",
            "--data-binary", &format!("@{body_path}"),
        ])
        .output()
        .map_err(|e| format!("Vision API: {e}"))?;

    let _ = fs::remove_file(body_path);

    if !output.status.success() {
        return Err(format!("curl failed: {}", String::from_utf8_lossy(&output.stderr)));
    }

    let response_str = String::from_utf8_lossy(&output.stdout).to_string();
    if response_str.is_empty() {
        return Ok(None);
    }

    let response: serde_json::Value = serde_json::from_str(&response_str)
        .map_err(|e| format!("Parse response: {e}"))?;

    if response.get("error").is_some() {
        return Ok(None);
    }

    let text = response["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("NONE")
        .trim()
        .to_string();

    eprintln!("[learning-mode] screen check result: {}", truncate_str(&text, 100));

    if text == "NONE" || text.to_uppercase().starts_with("NONE") {
        Ok(None)
    } else {
        Ok(Some(text))
    }
}

/// Record a brief clip of system audio, transcribe it, and check whether the
/// target language is present. Returns vocabulary/grammar hints or None.
#[tauri::command]
pub async fn check_audio_for_language(language: String, duration_secs: Option<u64>) -> Result<Option<String>, String> {
    let config = read_config_internal()?;
    let api_key = config
        .api_key
        .ok_or("No API key configured")?;

    // Don't interfere with an active user recording
    let is_recording = RECORDING_CHILD
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false);
    if is_recording {
        return Ok(None);
    }

    let helper = find_record_helper()?;
    let clip_path = "/tmp/samuel-learning-clip.m4a";
    let duration = duration_secs.unwrap_or(8);

    // Remove stale clip
    let _ = fs::remove_file(clip_path);

    // Start the recorder
    let mut child = Command::new(&helper)
        .arg(clip_path)
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(|e| format!("Failed to start record-audio: {e}"))?;

    eprintln!("[learning-mode] audio clip recording for {}s...", duration);

    // Let it record for the specified duration
    std::thread::sleep(std::time::Duration::from_secs(duration));

    // SIGTERM to finalize the audio file
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }

    // Wait for clean exit (up to 3s)
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed().as_secs() > 3 {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(_) => break,
        }
    }

    if !std::path::Path::new(clip_path).exists() {
        eprintln!("[learning-mode] audio clip not created");
        return Ok(None);
    }

    let meta = fs::metadata(clip_path).ok();
    let size = meta.map(|m| m.len()).unwrap_or(0);
    if size < 1000 {
        let _ = fs::remove_file(clip_path);
        eprintln!("[learning-mode] audio clip too small ({}B), skipping", size);
        return Ok(None);
    }

    eprintln!("[learning-mode] audio clip: {:.1}KB, transcribing...", size as f64 / 1024.0);

    // Transcribe with gpt-4o-transcribe (auto-detect language)
    let whisper_output = Command::new("curl")
        .args([
            "-s",
            "--max-time", "30",
            "-X", "POST",
            "https://api.openai.com/v1/audio/transcriptions",
            "-H", &format!("Authorization: Bearer {api_key}"),
            "-F", &format!("file=@{clip_path}"),
            "-F", "model=gpt-4o-mini-transcribe",
            "-F", "prompt=Transcribe any speech in this audio clip. There may be background music and sound effects. If there is no speech, return empty.",
        ])
        .output()
        .map_err(|e| format!("curl transcribe: {e}"))?;

    let _ = fs::remove_file(clip_path);

    if !whisper_output.status.success() {
        return Ok(None);
    }

    let whisper_body: serde_json::Value = serde_json::from_slice(&whisper_output.stdout)
        .unwrap_or_default();

    let transcript = whisper_body["text"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();

    if transcript.is_empty() || transcript.len() < 5 {
        eprintln!("[learning-mode] audio: no speech detected");
        return Ok(None);
    }

    eprintln!("[learning-mode] audio transcript: {}", truncate_str(&transcript, 120));

    // Ask GPT-4o if this contains the target language and for interesting vocabulary/grammar
    let analysis_prompt = format!(
        "You heard the following audio transcript. Determine if it contains {language} speech. \
         If it does, pick 1-2 interesting words or grammar patterns a {language} learner would \
         benefit from knowing. Give a brief, voice-friendly explanation (2-3 sentences max). \
         If the transcript is NOT in {language}, or is just music/noise/English, respond with exactly: NONE\n\n\
         Transcript: {transcript}"
    );

    let gpt_payload = serde_json::json!({
        "model": "gpt-4o-mini",
        "messages": [
            {
                "role": "system",
                "content": format!(
                    "You are a {language} language learning assistant. \
                     You analyze audio transcripts and highlight interesting vocabulary or grammar \
                     for a learner. Keep responses very short and suitable for a voice assistant."
                )
            },
            { "role": "user", "content": analysis_prompt }
        ],
        "max_tokens": 200,
        "temperature": 0.3
    });

    let gpt_output = Command::new("curl")
        .args([
            "-s",
            "--max-time", "15",
            "-X", "POST",
            "https://api.openai.com/v1/chat/completions",
            "-H", &format!("Authorization: Bearer {api_key}"),
            "-H", "Content-Type: application/json",
            "-d", &gpt_payload.to_string(),
        ])
        .output()
        .map_err(|e| format!("curl gpt: {e}"))?;

    if !gpt_output.status.success() {
        return Ok(None);
    }

    let gpt_body: serde_json::Value = serde_json::from_slice(&gpt_output.stdout)
        .unwrap_or_default();

    let hint = gpt_body["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("NONE")
        .trim()
        .to_string();

    eprintln!("[learning-mode] audio analysis: {}", truncate_str(&hint, 100));

    if hint == "NONE" || hint.to_uppercase().starts_with("NONE") {
        Ok(None)
    } else {
        Ok(Some(hint))
    }
}

// ---------------------------------------------------------------------------
// Autonomy — attention state, triage router, persistent audio monitor
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TriageDecision {
    pub classification: String,
    pub confidence: f64,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AudioCheckResult {
    pub transcript: Option<String>,
    pub hint: Option<String>,
    pub clip_path: Option<String>,
}


/// Detect whether the user is in deep focus, casually available, or idle.
#[tauri::command]
pub async fn get_attention_state() -> Result<String, String> {
    let app = get_frontmost_app_name();
    if app.is_empty() {
        return Ok("available".to_string());
    }
    for focus_app in FOCUS_APPS {
        if app.eq_ignore_ascii_case(focus_app) || app.contains(focus_app) {
            return Ok("focused".to_string());
        }
    }
    Ok("available".to_string())
}

/// Three-way triage: classify an observation as ignore / notify / act.
/// Uses gpt-4o-mini for speed and low cost (~$0.0003 per call).
#[tauri::command]
pub async fn triage_observation(
    observation: String,
    source: String,
    language: String,
) -> Result<TriageDecision, String> {
    let config = read_config_internal()?;
    let api_key = config.api_key.ok_or("No API key")?;

    let memory_context = memory::get_context();
    let attention = get_frontmost_app_name();

    // Record this observation in memory
    let summary = format!("[{source}] {}", truncate_str(&observation, 80));
    memory::record_observation(&summary);

    let prompt = format!(
        r#"You are deciding whether Samuel, a proactive AI learning companion, should speak up.

User is learning: {language}
Current app: {attention}
Memory context: {memory_context}
Source: {source} (screen = visual, audio = overheard speech)

Observation:
{observation}

Decide what to do. Return JSON ONLY:
{{
  "reasoning": "1-sentence step-by-step reasoning",
  "classification": "ignore|notify|act",
  "confidence": 0.0-1.0,
  "message": "what Samuel should say if not ignore. null if ignore."
}}

Rules:
- "ignore": Not useful. Background noise, already-taught vocabulary, a plain empty desktop, or truly generic content (common greetings, "hello", "the", etc).
- "notify": Mildly interesting. A vocabulary word, common phrase, or a "do you know how to say X in {language}?" moment. Show as subtle text card.
- "act": Genuinely interesting and specific. A new word, unusual grammar, or a great cross-language teaching moment. Worth speaking aloud.
- IMPORTANT: Observations do NOT need to be in {language} to be valuable. Teaching the {language} equivalent of interesting English content IS valuable — treat those as notify or act, not ignore.
- Be conservative — silence (ignore) is better than interrupting needlessly, but a good cross-language teaching moment IS worth surfacing.
- If the observation mentions words listed in "User already knows (NEVER mention)", ALWAYS classify as ignore.
- If the observation mentions words listed in "Recently taught (don't repeat today)", classify as ignore.
- If memory shows a user proficiency level (e.g. "intermediate"), skip beginner-level content (basic greetings, numbers, common particles) and focus on content at or above their level.
- ALWAYS ignore character names, proper nouns, and names of fictional or real people/places (e.g. 悟飯/Gohan, ベジータ/Vegeta, 悟空/Goku, ナルト/Naruto). These are NOT vocabulary.
- ALWAYS ignore common English loanwords that are trivially obvious (e.g. フィニッシュ/finish, テレビ/TV) unless they have a genuinely non-obvious {language}-specific nuance.
- ALWAYS ignore observations that look like Samuel's own speech echoed back (e.g. "means X in Japanese", "Understood, sir", "I'll keep that in mind").
- Only "act" for truly specific, helpful observations."#
    );

    let payload = serde_json::json!({
        "model": "gpt-4o-mini",
        "messages": [
            { "role": "user", "content": prompt }
        ],
        "max_tokens": 200,
        "temperature": 0.2
    });

    let output = Command::new("curl")
        .args([
            "-s",
            "--max-time", "10",
            "-X", "POST",
            "https://api.openai.com/v1/chat/completions",
            "-H", &format!("Authorization: Bearer {api_key}"),
            "-H", "Content-Type: application/json",
            "-d", &payload.to_string(),
        ])
        .output()
        .map_err(|e| format!("triage curl: {e}"))?;

    if !output.status.success() {
        return Ok(TriageDecision {
            classification: "ignore".to_string(),
            confidence: 0.0,
            message: String::new(),
        });
    }

    let body: serde_json::Value =
        serde_json::from_slice(&output.stdout).unwrap_or_default();

    let content = body["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("{}");

    let cleaned = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let parsed: serde_json::Value =
        serde_json::from_str(cleaned).unwrap_or_default();

    let classification = parsed["classification"]
        .as_str()
        .unwrap_or("ignore")
        .to_string();
    let confidence = parsed["confidence"].as_f64().unwrap_or(0.0);
    let message = parsed["message"]
        .as_str()
        .unwrap_or(&observation)
        .to_string();

    eprintln!(
        "[triage] {} (conf={:.2}): {}",
        classification,
        confidence,
        truncate_str(&message, 80)
    );

    // Record vocabulary if we're surfacing it
    if classification != "ignore" {
        let words: Vec<String> = message
            .split_whitespace()
            .filter(|w| w.chars().any(|c| !c.is_ascii()))
            .map(|w| w.trim_matches(|c: char| c.is_ascii_punctuation()).to_string())
            .filter(|w| !w.is_empty())
            .collect();
        if !words.is_empty() {
            memory::record_vocabulary(&words);
        }
    }

    Ok(TriageDecision {
        classification,
        confidence,
        message,
    })
}

// ---------------------------------------------------------------------------
// Viewing session assessment — meta-commentary on content difficulty/repetition
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct ViewingAssessment {
    pub classification: String,
    pub message: String,
    pub confidence: f64,
}

/// Accumulates transcript snippets over a 5-minute window for the assessment
static TRANSCRIPT_WINDOW: Mutex<Vec<String>> = Mutex::new(Vec::new());

#[tauri::command]
pub async fn append_transcript_window(text: String) -> Result<(), String> {
    let mut window = TRANSCRIPT_WINDOW.lock().map_err(|e| format!("lock: {e}"))?;
    window.push(text);
    if window.len() > 20 {
        let excess = window.len() - 20;
        window.drain(..excess);
    }
    Ok(())
}

#[tauri::command]
pub async fn assess_viewing_session(language: String) -> Result<ViewingAssessment, String> {
    let config = read_config_internal()?;
    let api_key = config.api_key.ok_or("No API key")?;

    // Collect the transcript window
    let window = {
        let guard = TRANSCRIPT_WINDOW.lock().map_err(|e| format!("lock: {e}"))?;
        guard.clone()
    };

    if window.is_empty() {
        return Ok(ViewingAssessment {
            classification: "silent".to_string(),
            message: String::new(),
            confidence: 0.0,
        });
    }

    let transcript_text = window.join("\n");

    // Record watch and get history stats
    let (session_count, total_minutes) = memory::record_watch(&transcript_text, "");

    let memory_context = memory::get_context();

    let prompt = format!(
        r#"You are Samuel's viewing advisor. The user is learning {language} by watching anime/video.

User context: {memory_context}
Watch history for this content: {session_count} session(s), ~{total_minutes} minutes total across all sessions

Recent transcript from the past ~5 minutes of audio:
---
{transcript_text}
---

Assess the viewing situation. Return JSON ONLY:
{{
  "classification": "silent|too_hard|too_easy|repetition|good_match|suggestion",
  "message": "what Samuel should say, in character as a butler. null if silent.",
  "confidence": 0.0-1.0
}}

Classification guide:
- "silent" (DEFAULT — use this 70%+ of the time): Nothing worth commenting on. Content is fine.
- "too_hard": The dialogue uses vocabulary/grammar well above the user's stated level. For example: news broadcasts, formal speeches, business Japanese, political debates, or dense N1/N2 anime for an N4 learner. Flag this when the content is clearly above their comfort zone.
- "too_easy": Content is clearly below their level (e.g., children's show for an N2 learner). Only flag if dramatically mismatched.
- "repetition": User has watched this exact content {session_count} or more times. Only flag if session_count >= 3.
- "good_match": Content difficulty matches their level well. Only say this ONCE per session, and only if you're genuinely confident.
- "suggestion": The user might benefit from switching content. Only when there's a clear reason.

CRITICAL RULES:
- Default to "silent". Silence is usually the right answer.
- Never be condescending. Samuel is a butler, not a teacher lecturing a student.
- If the user hasn't stored a proficiency level yet, ALWAYS return "silent" (you can't judge difficulty without a baseline).
- If the user's level IS stored (e.g. "JLPT N4"), actively compare it against the transcript. News, political talk shows, business Japanese, and fast native speech are typically N2-N1 level — an N4 learner would struggle with these.
- Repetition is only notable at 3+ sessions — rewatching once or twice is normal study behavior.
- If message is not null, write it as Samuel would speak: "Sir, ...", brief, one sentence max.
- Example messages: "Sir, this program seems rather advanced for your current level — perhaps something lighter?", "Sir, this news broadcast is quite dense — shall I find something more approachable?""#
    );

    let payload = serde_json::json!({
        "model": "gpt-4o-mini",
        "messages": [{ "role": "user", "content": prompt }],
        "max_tokens": 200,
        "temperature": 0.2
    });

    let output = Command::new("curl")
        .args([
            "-s",
            "--max-time", "15",
            "-X", "POST",
            "https://api.openai.com/v1/chat/completions",
            "-H", &format!("Authorization: Bearer {api_key}"),
            "-H", "Content-Type: application/json",
            "-d", &payload.to_string(),
        ])
        .output()
        .map_err(|e| format!("assess curl: {e}"))?;

    if !output.status.success() {
        return Ok(ViewingAssessment {
            classification: "silent".to_string(),
            message: String::new(),
            confidence: 0.0,
        });
    }

    let body: serde_json::Value =
        serde_json::from_slice(&output.stdout).unwrap_or_default();

    let content = body["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("{}");

    let cleaned = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let parsed: serde_json::Value =
        serde_json::from_str(cleaned).unwrap_or_default();

    let classification = parsed["classification"]
        .as_str()
        .unwrap_or("silent")
        .to_string();
    let confidence = parsed["confidence"].as_f64().unwrap_or(0.0);
    let message = parsed["message"]
        .as_str()
        .unwrap_or("")
        .to_string();

    eprintln!(
        "[viewing-assess] {} (conf={:.2}): {}",
        classification,
        confidence,
        truncate_str(&message, 80)
    );

    Ok(ViewingAssessment {
        classification,
        message,
        confidence,
    })
}

// ---------------------------------------------------------------------------
// Persistent audio monitor for learning mode
// ---------------------------------------------------------------------------

fn start_learning_audio_internal() -> Result<(), String> {
    let helper = find_record_helper()?;
    let mut guard = LEARNING_AUDIO_CHILD.lock().map_err(|e| format!("lock: {e}"))?;
    if guard.is_some() {
        return Ok(());
    }
    // Don't conflict with manual recording
    let is_recording = RECORDING_CHILD.lock().map(|g| g.is_some()).unwrap_or(false);
    if is_recording {
        return Ok(());
    }
    let _ = fs::remove_file(LEARNING_AUDIO_PATH);
    // Exclude our own process so Samuel's TTS doesn't get captured
    let my_pid = std::process::id().to_string();
    let child = Command::new(&helper)
        .args([LEARNING_AUDIO_PATH, "--exclude-pid", &my_pid])
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(|e| format!("start learning audio: {e}"))?;
    eprintln!("[learning-audio] started pid={} (excluding own pid={})", child.id(), my_pid);
    *guard = Some(child);
    Ok(())
}

fn stop_learning_audio_internal() -> Result<(), String> {
    let mut guard = LEARNING_AUDIO_CHILD.lock().map_err(|e| format!("lock: {e}"))?;
    if let Some(mut child) = guard.take() {
        #[cfg(unix)]
        unsafe {
            libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
        }
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if start.elapsed().as_secs() > 3 => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
                Err(_) => break,
            }
        }
        eprintln!("[learning-audio] stopped");
    }
    Ok(())
}

/// Start the persistent audio recorder for learning mode.
#[tauri::command]
pub async fn start_learning_audio() -> Result<(), String> {
    start_learning_audio_internal()
}

/// Stop the persistent audio recorder.
#[tauri::command]
pub async fn stop_learning_audio() -> Result<(), String> {
    stop_learning_audio_internal()?;
    let _ = fs::remove_file(LEARNING_AUDIO_PATH);
    Ok(())
}

/// Stop recorder, transcribe accumulated audio, restart recorder, return hints.
#[tauri::command]
pub async fn check_learning_audio(language: String) -> Result<AudioCheckResult, String> {
    let empty = AudioCheckResult { transcript: None, hint: None, clip_path: None };

    let config = read_config_internal()?;
    let api_key = config.api_key.ok_or("No API key")?;

    // Don't interfere with manual recording
    let is_recording = RECORDING_CHILD.lock().map(|g| g.is_some()).unwrap_or(false);
    if is_recording {
        return Ok(empty);
    }

    // Stop recorder to finalize the file
    stop_learning_audio_internal()?;

    if !std::path::Path::new(LEARNING_AUDIO_PATH).exists() {
        let _ = start_learning_audio_internal();
        return Ok(empty);
    }

    let size = fs::metadata(LEARNING_AUDIO_PATH).map(|m| m.len()).unwrap_or(0);
    if size < 1000 {
        let _ = fs::remove_file(LEARNING_AUDIO_PATH);
        let _ = start_learning_audio_internal();
        eprintln!("[learning-audio] clip too small ({size}B)");
        return Ok(empty);
    }

    eprintln!("[learning-audio] clip: {:.1}KB, transcribing...", size as f64 / 1024.0);

    // Map learning language name to ISO 639-1 code for Whisper
    let lang_code = match language.to_lowercase().as_str() {
        "japanese" => "ja",
        "chinese" | "mandarin" => "zh",
        "korean" => "ko",
        "spanish" => "es",
        "french" => "fr",
        "german" => "de",
        "italian" => "it",
        "portuguese" => "pt",
        _ => "ja", // default to Japanese since that's the primary use case
    };

    let whisper_output = Command::new("curl")
        .args([
            "-s",
            "--max-time", "30",
            "-X", "POST",
            "https://api.openai.com/v1/audio/transcriptions",
            "-H", &format!("Authorization: Bearer {api_key}"),
            "-F", &format!("file=@{LEARNING_AUDIO_PATH}"),
            "-F", "model=gpt-4o-mini-transcribe",
            "-F", &format!("language={lang_code}"),
            "-F", "prompt=Transcribe the speech accurately. Ignore background music and sound effects. If no speech, return empty.",
        ])
        .output()
        .map_err(|e| format!("curl: {e}"))?;

    // Save clip to flashcards dir before deleting — we may need it for a flashcard
    let saved_clip_path = crate::flashcards::save_audio_clip(LEARNING_AUDIO_PATH);
    let _ = fs::remove_file(LEARNING_AUDIO_PATH);
    // Restart recorder immediately so we don't miss audio
    let _ = start_learning_audio_internal();

    if !whisper_output.status.success() {
        return Ok(empty);
    }

    let whisper_body: serde_json::Value =
        serde_json::from_slice(&whisper_output.stdout).unwrap_or_default();
    let transcript = whisper_body["text"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();

    if transcript.is_empty() || transcript.len() < 5 {
        eprintln!("[learning-audio] no speech detected");
        return Ok(empty);
    }

    // Filter out Samuel's own TTS voice leaking back into the recorder
    let lower = transcript.to_lowercase();
    let self_talk_markers = [
        "sir,", "sir.", "understood, sir", "in japanese that",
        "in japanese it", "means '", "i'll keep that", "how may i assist",
        "good evening", "shall i", "let me explain",
    ];
    if self_talk_markers.iter().any(|m| lower.contains(m)) {
        eprintln!("[learning-audio] filtered self-talk: {}", truncate_str(&transcript, 80));
        return Ok(empty);
    }

    eprintln!("[learning-audio] transcript: {}", truncate_str(&transcript, 120));

    // Store raw transcript in memory so Samuel can reference it
    memory::record_transcript(&transcript);

    let analysis_prompt = format!(
        "You heard the following audio transcript. Help a {language} learner.\n\
         CRITICAL RULE: You may ONLY pick words or phrases that appear VERBATIM in the transcript below. \
         NEVER infer, paraphrase, summarize, or suggest related concepts that are not explicitly present \
         in the text. If the transcript says '成績', you may teach '成績' — but you must NOT invent \
         '便利な成績確認ツール' or any phrase not actually spoken.\n\n\
         PRIORITY 1: If it contains {language} speech, pick 1-2 interesting words or grammar \
         patterns that appear in the transcript and explain them briefly (2-3 sentences, voice-friendly).\n\
         PRIORITY 2: If the speech is in English (or another non-{language} language), find an \
         interesting word or phrase that was actually said and teach the {language} equivalent. \
         Frame it as: \"I heard [X] — in {language} that's [word/phrase] ([reading]).\"\n\
         IMPORTANT FILTERS:\n\
         - ONLY use words/phrases that appear verbatim in the transcript. No paraphrasing.\n\
         - NEVER pick character names, proper nouns, or names of people/places \
         (e.g. Gohan, Vegeta, Goku, Naruto, 一ノ瀬, 堀北, 綾野 etc.). These are names, not vocabulary.\n\
         - NEVER pick common loanwords that the learner already knows from English \
         (e.g. フィニッシュ/finish, テレビ/TV, ペナルティ/penalty) unless they have a non-obvious nuance.\n\
         - Pick something specific, contextual, and genuinely useful — not trivial.\n\
         Only respond NONE if the transcript is just noise, music, names only, trivial loanwords, or too short to be useful.\n\n\
         Transcript: {transcript}"
    );

    let gpt_payload = serde_json::json!({
        "model": "gpt-4o-mini",
        "messages": [
            {
                "role": "system",
                "content": format!("You are a {language} learning assistant. Keep responses very short and voice-friendly.")
            },
            { "role": "user", "content": analysis_prompt }
        ],
        "max_tokens": 200,
        "temperature": 0.3
    });

    let gpt_output = Command::new("curl")
        .args([
            "-s",
            "--max-time", "15",
            "-X", "POST",
            "https://api.openai.com/v1/chat/completions",
            "-H", &format!("Authorization: Bearer {api_key}"),
            "-H", "Content-Type: application/json",
            "-d", &gpt_payload.to_string(),
        ])
        .output()
        .map_err(|e| format!("curl gpt: {e}"))?;

    if !gpt_output.status.success() {
        return Ok(AudioCheckResult {
            transcript: Some(transcript),
            hint: None,
            clip_path: saved_clip_path,
        });
    }

    let gpt_body: serde_json::Value =
        serde_json::from_slice(&gpt_output.stdout).unwrap_or_default();

    let hint = gpt_body["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("NONE")
        .trim()
        .to_string();

    eprintln!("[learning-audio] hint: {}", truncate_str(&hint, 100));

    let hint_val = if hint == "NONE" || hint.to_uppercase().starts_with("NONE") {
        None
    } else {
        Some(hint)
    };

    // If no useful hint, clean up the saved clip to avoid accumulating unused files
    if hint_val.is_none() {
        if let Some(ref p) = saved_clip_path {
            let _ = fs::remove_file(p);
        }
    }

    Ok(AudioCheckResult {
        transcript: Some(transcript),
        hint: hint_val,
        clip_path: saved_clip_path,
    })
}
