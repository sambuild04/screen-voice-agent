use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

static DEFAULT_DISPLAY: AtomicU32 = AtomicU32::new(1);

// Holds the child process for the system audio recorder (Swift helper)
static RECORDING_CHILD: Mutex<Option<std::process::Child>> = Mutex::new(None);

const TEMP_FILES: &[&str] = &[
    "/tmp/samuel-recording.m4a",
    "/tmp/samuel-page.png",
    "/tmp/samuel-page.jpg",
    "/tmp/samuel-debug.jpg",
    "/tmp/samuel-screen.png",
    "/tmp/samuel-screen.jpg",
    "/tmp/samuel-screen-debug.jpg",
    "/tmp/samuel-cua-screen.png",
    "/tmp/samuel-cua-resized.jpg",
    "/tmp/samuel-cua-debug.jpg",
    "/tmp/samuel-vision-req.json",
    "/tmp/samuel-cua-req.json",
    "/tmp/samuel-wake-audio.webm",
    "/tmp/samuel-wake-audio.mp4",
    "/tmp/samuel-wake-debug.webm",
    "/tmp/samuel-wake-debug.mp4",
    "/tmp/samuel-learning-req.json",
];

/// Remove leftover temp files from previous sessions.
pub fn cleanup_temp_files() {
    for path in TEMP_FILES {
        let _ = fs::remove_file(path);
    }
    eprintln!("[cleanup] removed stale temp files");
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BookWindow {
    pub title: String,
    pub window_id: u64,
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

fn activate_books() -> Result<(), String> {
    Command::new("/usr/bin/osascript")
        .args(["-e", "tell application \"Books\" to activate"])
        .output()
        .map_err(|e| format!("Failed to activate Books: {e}"))?;
    std::thread::sleep(std::time::Duration::from_millis(300));
    Ok(())
}

/// Mint a short-lived ephemeral client token via POST /v1/realtime/client_secrets.
/// The frontend SDK uses this token to establish its own WebRTC connection.
#[tauri::command]
pub async fn create_ephemeral_key() -> Result<String, String> {
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
        .map_err(|e| format!("Failed to call OpenAI: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Ephemeral key error: {stderr}"));
    }

    let response_str = String::from_utf8_lossy(&output.stdout).to_string();
    let response: serde_json::Value = serde_json::from_str(&response_str)
        .map_err(|e| format!("Parse ephemeral key response: {e}"))?;

    if let Some(err) = response.get("error") {
        return Err(format!("OpenAI error: {err}"));
    }

    response["value"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| format!("No 'value' in ephemeral key response: {response_str}"))
}

/// Capture the current Apple Books page and return base64 + app name.
#[tauri::command]
pub async fn capture_page() -> Result<CaptureResult, String> {
    let base64 = capture_page_internal()?;
    Ok(CaptureResult { base64, app_name: "Books".to_string() })
}

/// Focus Apple Books and return window info.
#[tauri::command]
pub async fn focus_book() -> Result<Option<BookWindow>, String> {
    activate_books()?;

    let list_output = run_peekaboo(&["list", "windows", "--app", "Books", "--json"])?;
    let raw: serde_json::Value =
        serde_json::from_str(&list_output).map_err(|e| format!("Parse error: {e}"))?;

    let windows = raw["data"]["windows"].as_array();
    if let Some(wins) = windows {
        for w in wins {
            let title = w["title"].as_str().unwrap_or("");
            if !title.is_empty() {
                return Ok(Some(BookWindow {
                    title: title.to_string(),
                    window_id: w["window_id"].as_u64().unwrap_or(0),
                }));
            }
        }
    }

    Ok(None)
}

#[tauri::command]
pub async fn next_page() -> Result<(), String> {
    activate_books()?;
    std::thread::sleep(std::time::Duration::from_millis(200));
    run_peekaboo(&["hotkey", "--keys", "right", "--app", "Books"])?;
    Ok(())
}

#[tauri::command]
pub async fn prev_page() -> Result<(), String> {
    activate_books()?;
    std::thread::sleep(std::time::Duration::from_millis(200));
    run_peekaboo(&["hotkey", "--keys", "left", "--app", "Books"])?;
    Ok(())
}

#[tauri::command]
pub async fn scroll_down() -> Result<(), String> {
    run_peekaboo(&["scroll", "--direction", "down", "--amount", "5"])?;
    Ok(())
}

#[tauri::command]
pub async fn search_book(query: String) -> Result<(), String> {
    run_peekaboo(&["hotkey", "--keys", "cmd,f", "--app", "Books"])?;
    std::thread::sleep(std::time::Duration::from_millis(500));

    run_peekaboo(&["paste", &query, "--app", "Books"])?;
    std::thread::sleep(std::time::Duration::from_millis(500));

    run_peekaboo(&["hotkey", "--keys", "return", "--app", "Books"])?;
    std::thread::sleep(std::time::Duration::from_millis(300));
    run_peekaboo(&["hotkey", "--keys", "escape", "--app", "Books"])?;
    Ok(())
}

/// Capture the current page and extract text via OpenAI Vision API.
#[tauri::command]
pub async fn analyze_page(prompt: Option<String>) -> Result<String, String> {
    let config = read_config_internal()?;
    let api_key = config
        .api_key
        .ok_or("No API key in ~/.books-reader.json")?;

    let b64 = capture_page_internal()?;

    if b64.len() < 100 {
        return Err("Screenshot appears empty — is Apple Books open and visible?".to_string());
    }

    let user_prompt = prompt.unwrap_or_else(|| {
        "You are an OCR assistant helping a visually impaired user. Transcribe every word visible in this image. Preserve paragraph breaks. Output only the transcribed text, nothing else.".to_string()
    });

    let request_body = serde_json::json!({
        "model": "gpt-4o",
        "messages": [
            {
                "role": "system",
                "content": "You are a reading assistant that helps users read books and content on their screen. The user has purchased this book and is reading it in Apple Books. Your job is to transcribe the visible text so it can be read aloud to them. Always transcribe the full text faithfully."
            },
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": user_prompt },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": format!("data:image/jpeg;base64,{b64}"),
                            "detail": "high"
                        }
                    }
                ]
            }
        ],
        "max_tokens": 4000
    });

    let body_str = serde_json::to_string(&request_body)
        .map_err(|e| format!("JSON error: {e}"))?;

    let body_path = "/tmp/samuel-vision-req.json";
    fs::write(body_path, &body_str)
        .map_err(|e| format!("Failed to write request body: {e}"))?;

    let output = Command::new("/usr/bin/curl")
        .args([
            "-s",
            "--max-time", "30",
            "-X", "POST",
            "https://api.openai.com/v1/chat/completions",
            "-H", &format!("Authorization: Bearer {api_key}"),
            "-H", "Content-Type: application/json",
            "--data-binary", &format!("@{body_path}"),
        ])
        .output()
        .map_err(|e| format!("Vision API call failed: {e}"))?;

    let _ = fs::remove_file(body_path);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("curl failed: {stderr}"));
    }

    let response_str = String::from_utf8_lossy(&output.stdout).to_string();

    if response_str.is_empty() {
        return Err("Vision API returned empty response (timeout or network error)".to_string());
    }

    let response: serde_json::Value = serde_json::from_str(&response_str)
        .map_err(|e| {
            format!(
                "Parse Vision response: {e} — raw: {}",
                &response_str[..200.min(response_str.len())]
            )
        })?;

    if let Some(err) = response.get("error") {
        return Err(format!("Vision API error: {}", err));
    }

    // Check for model refusal
    let message = &response["choices"][0]["message"];
    if let Some(refusal) = message["refusal"].as_str() {
        eprintln!("[vision] model refused: {}", refusal);
        return Err(format!(
            "Vision model refused the image. This usually means Screen Recording \
             permission is missing — the screenshot may be blank. \
             Check System Settings > Privacy > Screen Recording. Refusal: {refusal}"
        ));
    }

    let text = message["content"]
        .as_str()
        .unwrap_or("(Could not extract text from page)")
        .to_string();

    eprintln!("[vision] extracted {} chars", text.len());
    Ok(text)
}

/// Find the main book content window ID (the one with a non-empty title like "Traction").
fn find_book_window_id() -> Result<String, String> {
    let list_output = run_peekaboo(&["list", "windows", "--app", "Books", "--json"])?;
    let raw: serde_json::Value =
        serde_json::from_str(&list_output).map_err(|e| format!("Parse error: {e}"))?;

    let windows = raw["data"]["windows"]
        .as_array()
        .ok_or("No windows array in peekaboo output")?;

    // Find the first window with a non-empty title (that's the book content window)
    for w in windows {
        let title = w["title"].as_str().unwrap_or("");
        if !title.is_empty() {
            let wid = w["window_id"].as_u64().ok_or("No window_id")?;
            return Ok(wid.to_string());
        }
    }

    Err("No Apple Books content window found. Is a book open?".to_string())
}

/// Internal capture helper — captures the book window, resizes to max 1024px wide,
/// and converts to JPEG. Keeps a debug copy at /tmp/samuel-debug.jpg.
fn capture_page_internal() -> Result<String, String> {
    let tmp_png = "/tmp/samuel-page.png";
    let tmp_jpg = "/tmp/samuel-page.jpg";
    let debug_jpg = "/tmp/samuel-debug.jpg";
    let window_id = find_book_window_id()?;

    // Capture the specific Books window
    run_peekaboo(&[
        "image",
        "--app", "Books",
        "--window-id", &window_id,
        "--format", "png",
        "--path", tmp_png,
    ])?;

    let data = fs::read(tmp_png).map_err(|e| format!("Failed to read capture: {e}"))?;
    eprintln!("[capture] raw PNG size: {} bytes, window_id: {}", data.len(), window_id);

    if data.len() < 1000 {
        let _ = fs::remove_file(tmp_png);
        return Err(format!(
            "Captured image too small ({} bytes) — Books window may not be visible. \
             Check System Settings > Privacy > Screen Recording for the app.",
            data.len()
        ));
    }

    // Resize to max 1024px wide and convert to JPEG via macOS sips
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
        _ => {
            return Err("Failed to resize/compress screenshot".to_string());
        }
    };

    let jpg_data = fs::read(final_path).map_err(|e| format!("Failed to read JPEG: {e}"))?;
    eprintln!("[capture] final JPEG size: {} bytes", jpg_data.len());

    // Keep a debug copy so we can inspect what was captured
    let _ = fs::copy(final_path, debug_jpg);
    let _ = fs::remove_file(final_path);

    let b64 = base64::engine::general_purpose::STANDARD.encode(&jpg_data);
    Ok(b64)
}

/// Capture the full screen (any active app) and return base64 JPEG.
#[tauri::command]
pub async fn capture_screen() -> Result<String, String> {
    let (b64, w, h) = capture_screen_for_cua()?;
    eprintln!("[capture_screen] {}x{}, {} bytes b64", w, h, b64.len());
    Ok(b64)
}

/// Capture a window or display. If `app_name` is provided, target that app;
/// otherwise use the default display chosen via the UI picker.
#[tauri::command]
pub async fn capture_active_window(app_name: Option<String>) -> Result<CaptureResult, String> {
    capture_focused_window(app_name)
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
    } else {
        None
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

// ---------------------------------------------------------------------------
// GPT-5.4 Computer Use Agent — screenshot → model → actions → repeat
// ---------------------------------------------------------------------------

/// Get the macOS logical screen size (points, not pixels).
fn get_logical_screen_size() -> (u32, u32) {
    let output = Command::new("/usr/bin/osascript")
        .args(["-e", "tell application \"Finder\" to get bounds of window of desktop"])
        .output();
    if let Ok(out) = output {
        let s = String::from_utf8_lossy(&out.stdout);
        let parts: Vec<&str> = s.trim().split(", ").collect();
        if parts.len() == 4 {
            let w: u32 = parts[2].parse().unwrap_or(1440);
            let h: u32 = parts[3].parse().unwrap_or(900);
            return (w, h);
        }
    }
    (1440, 900)
}

/// Capture full screen, resize to logical resolution (1440x900 recommended by
/// OpenAI for CUA), convert to JPEG, return base64.
fn capture_screen_for_cua() -> Result<(String, u32, u32), String> {
    let tmp = "/tmp/samuel-cua-screen.png";
    let tmp_resized = "/tmp/samuel-cua-resized.jpg";
    let debug_copy = "/tmp/samuel-cua-debug.jpg";

    let sc_output = Command::new("/usr/sbin/screencapture")
        .args(["-x", "-C", tmp])
        .output()
        .map_err(|e| format!("screencapture failed: {e}"))?;

    if !sc_output.status.success() {
        let stderr = String::from_utf8_lossy(&sc_output.stderr);
        return Err(format!("screencapture error: {stderr}"));
    }

    let raw_size = fs::metadata(tmp).map(|m| m.len()).unwrap_or(0);
    if raw_size < 1000 {
        let _ = fs::remove_file(tmp);
        return Err(format!(
            "Screen capture too small ({raw_size} bytes) — check Screen Recording permission \
             in System Settings > Privacy & Security"
        ));
    }

    let (logical_w, logical_h) = get_logical_screen_size();

    let sips_output = Command::new("/usr/bin/sips")
        .args([
            "--resampleWidth", &logical_w.to_string(),
            "--resampleHeight", &logical_h.to_string(),
            "--setProperty", "format", "jpeg",
            "--setProperty", "formatOptions", "80",
            tmp,
            "--out", tmp_resized,
        ])
        .output()
        .map_err(|e| format!("sips resize failed: {e}"))?;

    let _ = fs::remove_file(tmp);

    if !sips_output.status.success() {
        return Err("Failed to resize/compress screenshot via sips".to_string());
    }

    let data = fs::read(tmp_resized).map_err(|e| format!("Read resized screenshot: {e}"))?;
    let _ = fs::copy(tmp_resized, debug_copy);
    let _ = fs::remove_file(tmp_resized);

    eprintln!("[cua] screenshot: {}x{}, {} bytes JPEG", logical_w, logical_h, data.len());

    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
    Ok((b64, logical_w, logical_h))
}

/// Call the OpenAI Responses API (POST /v1/responses).
fn call_responses_api(api_key: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
    let body_path = "/tmp/samuel-cua-req.json";
    let body_str = serde_json::to_string(body).map_err(|e| format!("JSON error: {e}"))?;

    // Log request size (not content — may contain base64 images)
    eprintln!("[cua-api] POST /v1/responses — {} bytes", body_str.len());

    fs::write(body_path, &body_str).map_err(|e| format!("Write req body: {e}"))?;

    let output = Command::new("/usr/bin/curl")
        .args([
            "-s",
            "--max-time", "90",
            "-X", "POST",
            "https://api.openai.com/v1/responses",
            "-H", &format!("Authorization: Bearer {api_key}"),
            "-H", "Content-Type: application/json",
            "--data-binary", &format!("@{body_path}"),
        ])
        .output()
        .map_err(|e| format!("Responses API call failed: {e}"))?;

    let _ = fs::remove_file(body_path);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("[cua-api] curl failed: {stderr}");
        return Err(format!("curl failed: {stderr}"));
    }

    let response_str = String::from_utf8_lossy(&output.stdout).to_string();
    if response_str.is_empty() {
        eprintln!("[cua-api] empty response (timeout or network error)");
        return Err("Responses API returned empty (timeout?)".to_string());
    }

    let resp: serde_json::Value = serde_json::from_str(&response_str)
        .map_err(|e| {
            eprintln!("[cua-api] parse error: {e} — raw: {}", &response_str[..500.min(response_str.len())]);
            format!("Parse Responses API: {e}")
        })?;

    if let Some(err) = resp.get("error") {
        eprintln!("[cua-api] API error: {err}");
        return Err(format!("Responses API error: {err}"));
    }

    eprintln!("[cua-api] OK — response id={}", resp["id"].as_str().unwrap_or("?"));
    Ok(resp)
}

/// Execute a single CUA action via peekaboo / osascript.
fn execute_cua_action(action: &serde_json::Value) -> Result<(), String> {
    let action_type = action["type"].as_str().unwrap_or("");
    eprintln!("[cua] action: {action_type} — {action}");

    match action_type {
        "screenshot" => { /* no-op, we always capture after */ }

        "click" => {
            let x = action["x"].as_i64().unwrap_or(0);
            let y = action["y"].as_i64().unwrap_or(0);
            let coords = format!("{x},{y}");
            run_peekaboo(&["click", "--coords", &coords])?;
        }

        "double_click" => {
            let x = action["x"].as_i64().unwrap_or(0);
            let y = action["y"].as_i64().unwrap_or(0);
            let coords = format!("{x},{y}");
            // Click twice rapidly
            run_peekaboo(&["click", "--coords", &coords])?;
            std::thread::sleep(std::time::Duration::from_millis(50));
            run_peekaboo(&["click", "--coords", &coords])?;
        }

        "type" => {
            let text = action["text"].as_str().unwrap_or("");
            if !text.is_empty() {
                run_peekaboo(&["type", text])?;
            }
        }

        "keypress" => {
            // keys can be a string or array of strings
            let keys_str = if let Some(arr) = action["keys"].as_array() {
                arr.iter()
                    .filter_map(|k| k.as_str())
                    .collect::<Vec<_>>()
                    .join(",")
            } else if let Some(s) = action["keys"].as_str() {
                s.to_string()
            } else {
                return Ok(());
            };
            if !keys_str.is_empty() {
                run_peekaboo(&["hotkey", "--keys", &keys_str])?;
            }
        }

        "scroll" => {
            let scroll_y = action["scroll_y"].as_i64().unwrap_or(0);
            let scroll_x = action["scroll_x"].as_i64().unwrap_or(0);
            if scroll_y != 0 {
                let dir = if scroll_y < 0 { "up" } else { "down" };
                let amt = scroll_y.unsigned_abs().min(20).to_string();
                let x = action["x"].as_i64().unwrap_or(0);
                let y = action["y"].as_i64().unwrap_or(0);
                let coords = format!("{x},{y}");
                run_peekaboo(&["scroll", "--direction", dir, "--amount", &amt, "--coords", &coords])?;
            }
            if scroll_x != 0 {
                let dir = if scroll_x < 0 { "left" } else { "right" };
                let amt = scroll_x.unsigned_abs().min(20).to_string();
                run_peekaboo(&["scroll", "--direction", dir, "--amount", &amt])?;
            }
        }

        "wait" => {
            let ms = action["ms"].as_u64().unwrap_or(1000);
            std::thread::sleep(std::time::Duration::from_millis(ms.min(5000)));
        }

        "move" => {
            let x = action["x"].as_i64().unwrap_or(0);
            let y = action["y"].as_i64().unwrap_or(0);
            let coords = format!("{x},{y}");
            run_peekaboo(&["click", "--coords", &coords])?;
        }

        other => {
            eprintln!("[cua] unknown action type: {other}");
        }
    }
    Ok(())
}

/// Extract text output from the Responses API result.
fn extract_cua_text(response: &serde_json::Value) -> String {
    let output = response["output"].as_array();
    if let Some(items) = output {
        for item in items {
            let item_type = item["type"].as_str().unwrap_or("");
            if item_type == "message" {
                if let Some(content) = item["content"].as_array() {
                    for c in content {
                        if c["type"].as_str() == Some("output_text") {
                            if let Some(text) = c["text"].as_str() {
                                return text.to_string();
                            }
                        }
                    }
                }
            }
        }
    }
    "(No text output from computer use agent)".to_string()
}

/// Find a computer_call in the response output.
fn find_computer_call(response: &serde_json::Value) -> Option<serde_json::Value> {
    let output = response["output"].as_array()?;
    for item in output {
        if item["type"].as_str() == Some("computer_call") {
            return Some(item.clone());
        }
    }
    None
}

/// Run a GPT-5.4 Computer Use task against Apple Books.
/// Takes a natural language instruction, drives the UI, and returns the result.
#[tauri::command]
pub async fn computer_use_task(task: String) -> Result<String, String> {
    let config = read_config_internal()?;
    let api_key = config.api_key.ok_or("No API key in ~/.books-reader.json")?;

    eprintln!("[cua] starting task: {}", &task[..task.len().min(120)]);
    activate_books()?;

    let (logical_w, logical_h) = get_logical_screen_size();
    eprintln!("[cua] screen: {}x{}", logical_w, logical_h);

    // Capture an initial screenshot so the model can see the current state
    // and skip the screenshot-first round-trip.
    let (init_screenshot, _, _) = capture_screen_for_cua()?;
    eprintln!("[cua] initial screenshot: {} bytes b64", init_screenshot.len());

    let computer_tool = serde_json::json!({
        "type": "computer",
        "display_width": logical_w,
        "display_height": logical_h,
        "environment": "mac"
    });

    let first_body = serde_json::json!({
        "model": "gpt-5.4",
        "tools": [computer_tool],
        "input": [
            {
                "role": "developer",
                "content": "You are helping a user interact with Apple Books on macOS. \
                    The user has purchased this book. You can see their screen. \
                    Perform the requested task COMPLETELY — do not stop early. \
                    If the task involves multiple steps (e.g. navigating to a chapter), \
                    keep going until you have fully completed it. \
                    When asked to read or transcribe text, include ALL visible book text \
                    in your final text response."
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": task
                    },
                    {
                        "type": "input_image",
                        "image_url": format!("data:image/jpeg;base64,{init_screenshot}")
                    }
                ]
            }
        ]
    });

    eprintln!("[cua] sending first request to gpt-5.4...");
    let mut response = call_responses_api(&api_key, &first_body)?;
    eprintln!("[cua] first response received, id={}", response["id"].as_str().unwrap_or("?"));

    // CUA loop — max 20 turns
    for turn in 0..20 {
        let call = match find_computer_call(&response) {
            Some(c) => c,
            None => {
                eprintln!("[cua] no more computer_call — done after {} turns", turn);
                break;
            }
        };

        let call_id = call["call_id"].as_str().unwrap_or("").to_string();
        let resp_id = response["id"].as_str().unwrap_or("").to_string();

        // GPT-5.4 GA returns batched actions[]; preview returns single action
        let actions: Vec<serde_json::Value> = if let Some(arr) = call["actions"].as_array() {
            arr.clone()
        } else if !call["action"].is_null() {
            vec![call["action"].clone()]
        } else {
            vec![]
        };

        eprintln!("[cua] turn {}: {} action(s), call_id={}", turn, actions.len(), call_id);

        for action in &actions {
            let action_type = action["type"].as_str().unwrap_or("");
            if action_type == "screenshot" {
                continue; // we always capture after executing
            }
            execute_cua_action(action)?;
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        std::thread::sleep(std::time::Duration::from_millis(300));

        let (screenshot_b64, _, _) = capture_screen_for_cua()?;
        eprintln!("[cua] turn {}: captured screenshot, sending back", turn);

        let follow_up = serde_json::json!({
            "model": "gpt-5.4",
            "tools": [computer_tool],
            "previous_response_id": resp_id,
            "input": [{
                "type": "computer_call_output",
                "call_id": call_id,
                "output": {
                    "type": "computer_screenshot",
                    "image_url": format!("data:image/jpeg;base64,{screenshot_b64}")
                }
            }]
        });

        response = call_responses_api(&api_key, &follow_up)?;
    }

    let result = extract_cua_text(&response);
    eprintln!("[cua] final result: {} chars", result.len());
    Ok(result)
}

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

// ---------------------------------------------------------------------------
// Learning Mode — periodic screen scan for target language content
// ---------------------------------------------------------------------------

/// Capture the active window and ask GPT-4o Vision whether the target language
/// is visible. Returns `Some(hints)` with a short voice-friendly summary of
/// interesting vocabulary/grammar, or `None` if nothing relevant is found.
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

    let prompt = format!(
        "Scan this screenshot for any {language} text (subtitles, UI, articles, chat, etc). \
         If you find {language} text, pick 1-2 interesting words or grammar patterns a learner \
         would benefit from knowing. Give a brief, voice-friendly explanation (2-3 sentences max). \
         If there is no {language} text visible at all, respond with exactly: NONE"
    );

    let request_body = serde_json::json!({
        "model": "gpt-4o",
        "messages": [
            {
                "role": "system",
                "content": format!(
                    "You are a {language} language learning assistant. \
                     You scan screenshots and highlight interesting vocabulary or grammar \
                     for a learner. Keep responses very short and suitable for a voice assistant."
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

    eprintln!("[learning-mode] screen check result: {}", &text[..text.len().min(100)]);

    if text == "NONE" || text.to_uppercase().starts_with("NONE") {
        Ok(None)
    } else {
        Ok(Some(text))
    }
}
