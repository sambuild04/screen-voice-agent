use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::process::Command;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BookWindow {
    pub title: String,
    pub window_id: u64,
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

/// Capture the current Apple Books page and return base64 PNG.
#[tauri::command]
pub async fn capture_page() -> Result<String, String> {
    capture_page_internal()
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

/// Read the user config from ~/.books-reader.json.
#[tauri::command]
pub async fn get_config() -> Result<Config, String> {
    read_config_internal()
}

fn read_config_internal() -> Result<Config, String> {
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
