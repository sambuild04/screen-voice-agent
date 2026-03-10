use std::process::Command;

/// Transcribe a short audio clip using OpenAI's Whisper API.
/// Audio is passed as base64-encoded data (mp4/webm from MediaRecorder).
#[tauri::command]
pub async fn transcribe_audio(audio_base64: String, extension: String) -> Result<String, String> {
    let config = crate::commands::read_config_internal()?;
    let api_key = config
        .api_key
        .ok_or("No API key in ~/.books-reader.json")?;

    let audio_bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        &audio_base64,
    )
    .map_err(|e| format!("base64 decode: {e}"))?;

    let ext = if extension.is_empty() { "mp4" } else { &extension };
    let tmp_path = format!("/tmp/samuel-wake-audio.{ext}");
    std::fs::write(&tmp_path, &audio_bytes)
        .map_err(|e| format!("write temp audio: {e}"))?;

    // Save a debug copy so we can listen to what was captured
    let debug_path = format!("/tmp/samuel-wake-debug.{ext}");
    let _ = std::fs::copy(&tmp_path, &debug_path);

    eprintln!(
        "[wake] transcribing {:.1}KB audio ({ext}) — debug copy at {debug_path}",
        audio_bytes.len() as f64 / 1024.0
    );

    // Prompt priming: Whisper uses this to expect specific vocabulary,
    // dramatically improving detection of "Hey Samuel" over hallucinations.
    let output = Command::new("curl")
        .args([
            "-s",
            "--max-time",
            "10",
            "-X",
            "POST",
            "https://api.openai.com/v1/audio/transcriptions",
            "-H",
            &format!("Authorization: Bearer {api_key}"),
            "-F",
            &format!("file=@{tmp_path}"),
            "-F",
            "model=whisper-1",
            "-F",
            "language=en",
            "-F",
            "prompt=Hey Samuel",
        ])
        .output()
        .map_err(|e| format!("curl error: {e}"))?;

    let _ = std::fs::remove_file(&tmp_path);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Whisper API error: {stderr}"));
    }

    let body: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| format!("parse response: {e}"))?;

    if let Some(err) = body.get("error") {
        return Err(format!("Whisper API: {}", err["message"].as_str().unwrap_or("unknown")));
    }

    let text = body["text"].as_str().unwrap_or("").to_string();
    eprintln!("[wake] whisper: \"{text}\"");
    Ok(text)
}
