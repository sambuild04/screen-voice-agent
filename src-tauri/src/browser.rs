use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};

/// Holds the communication channels to the browser agent sidecar.
struct BrowserAgent {
    stdin_tx: mpsc::Sender<String>,
    response_rx: Arc<Mutex<mpsc::Receiver<(String, bool, serde_json::Value)>>>,
    _child_pid: u32,
}

static AGENT: Mutex<Option<BrowserAgent>> = Mutex::new(None);

#[derive(Debug, Serialize, Deserialize)]
pub struct BrowserResult {
    pub ok: bool,
    pub data: serde_json::Value,
}

fn ensure_running() -> Result<(), String> {
    let mut guard = AGENT.lock().map_err(|e| format!("Lock: {e}"))?;
    if guard.is_some() {
        return Ok(());
    }

    eprintln!("[browser] spawning browser-agent via npx tsx...");

    // Resolve project root: Tauri binary cwd is src-tauri/, go up one level
    let project_root = std::env::current_dir()
        .map(|d| {
            if d.ends_with("src-tauri") {
                d.parent().unwrap_or(&d).to_path_buf()
            } else {
                d
            }
        })
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    eprintln!("[browser] project root: {}", project_root.display());

    let mut child = Command::new("npx")
        .args(["tsx", "src/lib/browser-agent.ts"])
        .current_dir(&project_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn browser agent: {e}"))?;

    let pid = child.id();

    // Take ownership of stdin, stdout, stderr
    let mut stdin = child.stdin.take().ok_or("No stdin")?;
    let stdout = child.stdout.take().ok_or("No stdout")?;
    let stderr = child.stderr.take().ok_or("No stderr")?;

    // Channel for sending commands to stdin writer thread
    let (stdin_tx, stdin_rx) = mpsc::channel::<String>();

    // Channel for receiving parsed responses from stdout reader thread
    let (resp_tx, resp_rx) = mpsc::channel::<(String, bool, serde_json::Value)>();
    let resp_rx = Arc::new(Mutex::new(resp_rx));

    // Stdin writer thread
    std::thread::spawn(move || {
        for line in stdin_rx {
            if writeln!(stdin, "{}", line).is_err() {
                break;
            }
            if stdin.flush().is_err() {
                break;
            }
        }
    });

    // Stdout reader thread — parses JSON lines and sends responses
    let resp_tx_clone = resp_tx.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(resp) = serde_json::from_str::<serde_json::Value>(&line) {
                let id = resp.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let ok = resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                let data = resp.get("data").cloned().unwrap_or(serde_json::Value::Null);
                if resp_tx_clone.send((id, ok, data)).is_err() {
                    break;
                }
            }
        }
        eprintln!("[browser] stdout reader exited");
    });

    // Stderr logger thread
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(l) = line {
                eprintln!("[browser-agent] {}", l);
            }
        }
    });

    // Reap child in background
    std::thread::spawn(move || {
        let _ = child.wait();
        eprintln!("[browser] child process exited");
    });

    // Wait for the agent to print "ready" on stderr
    std::thread::sleep(std::time::Duration::from_millis(2000));

    *guard = Some(BrowserAgent {
        stdin_tx,
        response_rx: resp_rx,
        _child_pid: pid,
    });

    eprintln!("[browser] agent started (pid={})", pid);
    Ok(())
}

/// Send a JSON command to the browser agent and wait for the response.
#[tauri::command]
pub async fn browser_command(action: String, params: serde_json::Value) -> Result<BrowserResult, String> {
    ensure_running()?;

    let guard = AGENT.lock().map_err(|e| format!("Lock: {e}"))?;
    let agent = guard.as_ref().ok_or("Browser agent not running")?;

    // Build the command JSON with a unique ID
    let id = format!(
        "req_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );

    let mut cmd = if let Some(obj) = params.as_object() {
        obj.clone()
    } else {
        serde_json::Map::new()
    };
    cmd.insert("id".into(), serde_json::Value::String(id.clone()));
    cmd.insert("action".into(), serde_json::Value::String(action));

    let cmd_str = serde_json::to_string(&serde_json::Value::Object(cmd))
        .map_err(|e| format!("JSON: {e}"))?;

    // Send command
    agent.stdin_tx.send(cmd_str).map_err(|e| format!("Send: {e}"))?;

    // Clone the receiver handle for use outside the lock
    let rx = agent.response_rx.clone();
    drop(guard);

    // Wait for the matching response (up to 60s)
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    let rx_guard = rx.lock().map_err(|e| format!("RX lock: {e}"))?;

    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err("Browser command timed out after 60s".into());
        }

        match rx_guard.recv_timeout(remaining) {
            Ok((resp_id, ok, data)) => {
                if resp_id == id {
                    return Ok(BrowserResult { ok, data });
                }
                // Not our response, discard (shouldn't happen with sequential calls)
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err("Browser command timed out after 60s".into());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("Browser agent process exited".into());
            }
        }
    }
}

/// Stop the browser agent process.
#[tauri::command]
pub async fn browser_close() -> Result<String, String> {
    let mut guard = AGENT.lock().map_err(|e| format!("Lock: {e}"))?;
    if let Some(agent) = guard.take() {
        let _ = agent.stdin_tx.send(r#"{"id":"_close","action":"close"}"#.to_string());
        std::thread::sleep(std::time::Duration::from_millis(500));
        // Agent threads will exit when stdin/stdout close
    }
    Ok("Browser closed".into())
}
