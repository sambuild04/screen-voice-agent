use std::fs;
use std::path::PathBuf;
use std::process::Command;

const SAMUEL_DIR: &str = ".samuel";
const PLUGINS_DIR: &str = "plugins";

fn plugins_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let dir = home.join(SAMUEL_DIR).join(PLUGINS_DIR);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Create plugins dir: {e}"))?;
    }
    Ok(dir)
}

/// Sanitize plugin name to prevent path traversal
fn safe_name(name: &str) -> Result<String, String> {
    let clean = name
        .trim()
        .replace(['/', '\\'], "")
        .replace("..", "")
        .replace(' ', "_");
    if clean.is_empty() || clean.starts_with('.') {
        return Err("Invalid plugin name".to_string());
    }
    Ok(clean)
}

#[tauri::command]
pub async fn get_plugin_dir() -> Result<String, String> {
    let dir = plugins_dir()?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn list_plugins() -> Result<Vec<String>, String> {
    let dir = plugins_dir()?;
    let mut names = Vec::new();

    let entries = fs::read_dir(&dir).map_err(|e| format!("Read plugins dir: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map_or(false, |ext| ext == "js") {
            if let Some(stem) = path.file_stem() {
                names.push(stem.to_string_lossy().to_string());
            }
        }
    }

    names.sort();
    Ok(names)
}

#[tauri::command]
pub async fn read_plugin(name: String) -> Result<String, String> {
    let clean = safe_name(&name)?;
    let path = plugins_dir()?.join(format!("{clean}.js"));
    fs::read_to_string(&path).map_err(|e| format!("Read plugin '{clean}': {e}"))
}

#[tauri::command]
pub async fn write_plugin(name: String, code: String) -> Result<String, String> {
    let clean = safe_name(&name)?;
    let dir = plugins_dir()?;
    let path = dir.join(format!("{clean}.js"));

    // Back up existing plugin before overwrite
    if path.exists() {
        let backup = dir.join(format!("{clean}.js.backup"));
        let _ = fs::copy(&path, &backup);
        eprintln!("[plugins] backed up {clean}.js → {clean}.js.backup");
    }

    fs::write(&path, &code).map_err(|e| format!("Write plugin '{clean}': {e}"))?;
    eprintln!("[plugins] wrote {clean}.js ({} bytes)", code.len());
    Ok(format!("Plugin '{clean}' saved."))
}

#[tauri::command]
pub async fn delete_plugin(name: String) -> Result<String, String> {
    let clean = safe_name(&name)?;
    let path = plugins_dir()?.join(format!("{clean}.js"));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Delete plugin '{clean}': {e}"))?;
        eprintln!("[plugins] deleted {clean}.js");
        Ok(format!("Plugin '{clean}' removed."))
    } else {
        Err(format!("Plugin '{clean}' not found."))
    }
}

/// Helper: call OpenAI chat completions and return the message content.
fn call_openai(api_key: &str, model: &str, system: &str, user: &str, temp: f64, max_tokens: u32) -> Result<String, String> {
    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "temperature": temp,
        "max_tokens": max_tokens
    });

    let body_str = serde_json::to_string(&body).map_err(|e| format!("JSON: {e}"))?;
    let tmp = "/tmp/samuel-plugin-llm.json";
    fs::write(tmp, &body_str).map_err(|e| format!("Write tmp: {e}"))?;

    let output = Command::new("/usr/bin/curl")
        .args([
            "-s", "-f",
            "-X", "POST",
            "https://api.openai.com/v1/chat/completions",
            "-H", &format!("Authorization: Bearer {api_key}"),
            "-H", "Content-Type: application/json",
            "-d", &format!("@{tmp}"),
        ])
        .output()
        .map_err(|e| format!("curl: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("LLM call failed: {stderr}"));
    }

    let resp: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| format!("Parse response: {e}"))?;

    resp["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .ok_or_else(|| "No content in LLM response".to_string())
}

/// Strip markdown code fences the model sometimes wraps around output.
fn strip_fences(code: &str) -> String {
    let s = code
        .strip_prefix("```javascript")
        .or_else(|| code.strip_prefix("```js"))
        .or_else(|| code.strip_prefix("```"))
        .unwrap_or(code);
    s.strip_suffix("```").unwrap_or(s).trim().to_string()
}

/// Generate plugin code from a natural language description via GPT-4o.
#[tauri::command]
pub async fn generate_plugin_code(description: String) -> Result<String, String> {
    let config = crate::commands::read_config_internal()?;
    let api_key = config.api_key.ok_or("No API key configured")?;

    let system_prompt = r#"You are a code generator for a Tauri desktop app plugin system.
Generate a JavaScript plugin file that will be executed via `new Function("secrets", "invoke", "sleep", code)(...)`.

The plugin MUST follow this exact shape — use `return { ... }` at the top level:

```
return {
  name: "tool_name",
  description: "What this tool does",
  parameters: {
    type: "object",
    properties: {
      param1: { type: "string", description: "..." }
    },
    required: ["param1"]
  },
  execute: async (args) => {
    // Implementation here
    // Available APIs:
    //   fetch() — make HTTP requests to any URL
    //   fetch("https://r.jina.ai/" + url) — read any URL as clean LLM-friendly text (free, no key)
    //   fetch("https://s.jina.ai/" + encodeURIComponent(query)) — search the web, returns top results as text (free, no key)
    //   secrets.get("key_name") — get a stored API key (returns Promise<string|null>)
    //   invoke(command, args) — call Tauri backend commands (returns Promise<unknown>)
    //     Examples: invoke("capture_active_window", { appName: null }), invoke("get_selected_text")
    //   sleep(ms) — wait for a duration (returns Promise<void>)
    //   JSON.parse/stringify, Date, Math, etc.
    // Return a string result
    return "result";
  }
};
```

Rules:
- ONLY output the raw JavaScript code, no markdown fences, no explanation
- The code runs inside new Function("secrets", "invoke", "sleep", code), so use `return { ... }` not `export default`
- The `secrets` parameter is available in scope — use `await secrets.get("key_name")` for API keys
- The `invoke` parameter calls Tauri backend commands — use for native operations (screen capture, OCR, etc.)
- The `sleep` parameter pauses execution — use `await sleep(400)` for timing between operations
- If an API key is needed and secrets.get() returns null, return a message asking the user to provide the key
- execute() must return a string (or something JSON.stringify-able)
- Use fetch() for any web API calls
- When calling a third-party API, prefer well-documented stable APIs with free tiers
- If unsure about an API endpoint, use Jina Reader (s.jina.ai) to search for docs first, or use r.jina.ai to read the API documentation URL
- Keep it simple and self-contained
- No imports — everything must be inline"#;

    let raw = call_openai(&api_key, "gpt-4o", system_prompt, &description, 0.2, 2000)?;
    let code = strip_fences(&raw);
    eprintln!("[plugins] generated code ({} bytes)", code.len());
    Ok(code)
}

/// Semantic quality check: ask GPT-4o-mini whether generated code matches the user's intent.
/// Returns "ok" if the code looks correct, or a reason string describing the mismatch.
#[tauri::command]
pub async fn judge_plugin_code(description: String, code: String) -> Result<String, String> {
    let config = crate::commands::read_config_internal()?;
    let api_key = config.api_key.ok_or("No API key configured")?;

    let system_prompt = r#"You are a code reviewer for an AI assistant's plugin system.
Given a user's request and the generated JavaScript plugin code, determine if the code
correctly implements what was requested.

Check for:
- Does the code actually do what the user asked? (not a different feature)
- Are API endpoints plausible and correctly used?
- Does the execute() function return a meaningful result?
- Are there obvious logic errors?

Reply ONLY with valid JSON, no other text:
- If the code is correct: { "ok": true }
- If there's an issue: { "ok": false, "reason": "brief description of the problem" }"#;

    let user_msg = format!("REQUEST: {description}\n\nCODE:\n```\n{code}\n```");

    let raw = call_openai(&api_key, "gpt-4o-mini", system_prompt, &user_msg, 0.1, 500)?;

    // Parse the JSON response; tolerate markdown fences around JSON
    let clean = strip_fences(&raw);
    match serde_json::from_str::<serde_json::Value>(&clean) {
        Ok(v) => {
            if v["ok"].as_bool() == Some(true) {
                eprintln!("[plugins] judge: ok");
                Ok("ok".to_string())
            } else {
                let reason = v["reason"].as_str().unwrap_or("Unknown issue").to_string();
                eprintln!("[plugins] judge flagged: {reason}");
                Ok(reason)
            }
        }
        Err(_) => {
            // If we can't parse the response, treat it as ok to avoid blocking
            eprintln!("[plugins] judge: unparseable response, treating as ok");
            Ok("ok".to_string())
        }
    }
}
