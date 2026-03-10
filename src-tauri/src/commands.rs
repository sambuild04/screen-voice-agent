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
