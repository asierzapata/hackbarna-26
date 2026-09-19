use serde_json::{json, Value};
use std::{collections::VecDeque, fs::{self, OpenOptions}, io::{Read, Write}, path::PathBuf, sync::{atomic::{AtomicU64, Ordering}, Mutex, OnceLock}, time::{SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Emitter, Manager};

const LIMIT: usize = 500;
const LOG_BYTES: u64 = 1024 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(1);
static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();
#[derive(Default)]
struct Store {
    events: VecDeque<Value>,
    directory: Option<PathBuf>,
    persistence_error: bool,
    writer: Option<std::sync::mpsc::SyncSender<Value>>,
    capture_until: u64,
    stderr: VecDeque<Value>,
}
fn store() -> &'static Mutex<Store> { STORE.get_or_init(|| Mutex::new(Store::default())) }
pub fn now() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn identifier(value: &Value) -> Option<&str> {
    value.as_str().filter(|s| !s.is_empty() && s.len() <= 128 && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c)) && !["sk-", "ghp_", "github_pat_", "eyJ"].iter().any(|prefix| s.starts_with(prefix)))
}
pub fn failure(code: &str, phase: &str, outcome: &str) -> Value {
    json!({"code": code, "phase": phase, "message": code.replace('_', " ").to_lowercase(), "outcome": outcome, "retryable": false})
}
pub fn from_message(message: &str, phase: &str) -> Value {
    let text = message.to_lowercase();
    let code = if text.contains("cancel") { "CANCELLED" }
        else if text.contains("timed out") { "AGENT_TIMEOUT" }
        else if text.contains("exited") || text.contains("disconnected") { "AGENT_EXITED" }
        else if text.contains("structured") || text.contains("json") { "STRUCTURED_OUTPUT_INVALID" }
        else { "AGENT_RPC_FAILED" };
    failure(code, phase, "unknown")
}
pub fn sanitize(input: &Value) -> Value {
    let mut value = json!({"id": format!("native-{}-{}", now(), NEXT.fetch_add(1, Ordering::Relaxed)), "at": now(), "event": "diagnostic.invalid", "source": "native"});
    for key in ["id", "event", "turnId", "runId", "connectionId", "sessionId", "requestId", "toolCallId", "provider", "model", "phase"] {
        if let Some(text) = identifier(&input[key]) { value[key] = json!(text); }
    }
    if ["frontend", "runner", "native"].contains(&input["source"].as_str().unwrap_or("")) { value["source"] = input["source"].clone(); }
    if let Some(tool) = input["tool"].as_str() {
        value["tool"] = json!(if ["addNode", "addMermaidDiagram", "updateNode", "removeNodes", "connectNodes", "arrange", "focusNodes", "groupNodes", "getCanvas", "queryData", "proposeNode"].contains(&tool) { tool } else { "unknown" });
    }
    for key in ["at", "durationMs", "bytes", "attempt", "deadline", "exitCode"] {
        if input[key].is_number() { value[key] = input[key].clone(); }
    }
    if input["failure"].is_object() {
        let original = &input["failure"];
        let code = identifier(&original["code"]).unwrap_or("AGENT_RPC_FAILED");
        let phase = identifier(&original["phase"]).unwrap_or("unknown");
        let outcome = original["outcome"].as_str().filter(|s| ["not_applied", "applied", "unknown"].contains(s)).unwrap_or("unknown");
        let mut error = failure(code, phase, outcome);
        if let Some(issues) = original["issues"].as_array() {
            error["issues"] = json!(issues.iter().take(12).map(|issue| json!({"path": identifier(&issue["path"]).unwrap_or("field"), "code": identifier(&issue["code"]).unwrap_or("invalid")})).collect::<Vec<_>>());
        }
        for key in ["rpcCode", "httpStatus"] { if original[key].is_number() { error[key] = original[key].clone(); } }
        value["failure"] = error;
    }
    value
}
fn persist(directory: &PathBuf, event: &Value) -> std::io::Result<()> {
    let path = directory.join("events.jsonl");
    if fs::metadata(&path).map(|m| m.len() >= LOG_BYTES).unwrap_or(false) {
        fs::rename(&path, directory.join("events.previous.jsonl"))?;
    }
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    writeln!(options.open(path)?, "{event}")
}
pub fn initialize(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let directory = app.path().app_local_data_dir().map(|path| path.join("diagnostics"));
    let mut state = store().lock().unwrap();
    match directory {
        Ok(directory) => {
            let result = fs::create_dir_all(&directory).and_then(|_| {
                #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?; }
                Ok(())
            });
            if result.is_ok() {
                for name in ["events.previous.jsonl", "events.jsonl"] {
                    if let Ok(file) = std::fs::File::open(directory.join(name)) {
                        let mut text = String::new();
                        let _ = file.take(2 * LOG_BYTES).read_to_string(&mut text);
                        for line in text.lines() {
                            if let Ok(event) = serde_json::from_str::<Value>(line) {
                                state.events.push_back(sanitize(&event));
                                while state.events.len() > LIMIT { state.events.pop_front(); }
                            }
                        }
                    }
                }
                let (send, receive) = std::sync::mpsc::sync_channel::<Value>(256);
                state.writer = Some(send);
                state.directory = Some(directory.clone());
                std::thread::spawn(move || {
                    while let Ok(event) = receive.recv() {
                        if persist(&directory, &event).is_err() { store().lock().unwrap().persistence_error = true; }
                    }
                });
            } else { state.persistence_error = true; }
        }
        Err(_) => state.persistence_error = true,
    }
}
pub fn record(app: Option<&AppHandle>, input: Value) {
    let event = sanitize(&input);
    {
        let mut state = store().lock().unwrap();
        if state.events.iter().any(|old| old["id"] == event["id"]) { return; }
        if let Some(writer) = &state.writer {
            if writer.try_send(event.clone()).is_err() { state.persistence_error = true; }
        }
        state.events.push_back(event.clone());
        while state.events.len() > LIMIT { state.events.pop_front(); }
    }
    if let Some(app) = app.or_else(|| APP.get()) { let _ = app.emit_to("main", "agent:diagnostic", event); }
}
fn redact_detail(text: &str, secrets: &[String]) -> String {
    let lower = text.to_lowercase();
    if ["bearer", "token", "secret", "password", "credential", "api_key", "api-key", "authorization", "cookie", "sk-", "ghp_", "github_pat_", "eyj", "http://", "https://"].iter().any(|word| lower.contains(word)) || secrets.iter().any(|secret| !secret.is_empty() && text.contains(secret)) || text.split_whitespace().any(|word| word.len() > 64) {
        "[redacted sensitive line]".into()
    } else { text.chars().filter(|c| !c.is_control()).take(2048).collect() }
}
pub fn drain_stderr(app: AppHandle, connection_id: u64, mut stderr: impl Read + Send + 'static, secrets: Vec<String>) {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 2048];
        let mut line = Vec::new();
        let mut overflow = false;
        let mut total = 0;
        while let Ok(size) = stderr.read(&mut buffer) {
            if size == 0 { break; }
            total += size;
            for byte in &buffer[..size] {
                if *byte != b'\n' {
                    if line.len() < 8192 { line.push(*byte); } else { overflow = true; }
                    continue;
                }
                let mut state = store().lock().unwrap();
                if state.capture_until > now() {
                    let safe = if overflow { "[oversized line omitted]".into() } else { redact_detail(&String::from_utf8_lossy(&line), &secrets) };
                    state.stderr.push_back(json!({"connectionId": connection_id.to_string(), "at": now(), "text": safe}));
                    while state.stderr.len() > 32 { state.stderr.pop_front(); }
                }
                line.clear(); overflow = false;
            }
        }
        record(Some(&app), json!({"event": "process.stderr_closed", "connectionId": connection_id.to_string(), "bytes": total}));
    });
}
#[tauri::command]
pub fn agent_diagnostic_record(app: AppHandle, event: Value) -> Result<(), String> {
    if event.to_string().len() > 16384 { return Err("Diagnostic event too large".into()); }
    record(Some(&app), event);
    Ok(())
}
#[tauri::command]
pub fn agent_diagnostics(turn_id: Option<String>) -> Value {
    let state = store().lock().unwrap();
    json!({"events": state.events.iter().filter(|event| turn_id.as_ref().is_none_or(|id| event["turnId"] == *id || event["runId"] == *id)).collect::<Vec<_>>(), "persistenceError": state.persistence_error, "directory": state.directory, "captureUntil": state.capture_until})
}
#[tauri::command]
pub fn agent_diagnostics_capture(enabled: bool) -> Value {
    let mut state = store().lock().unwrap();
    state.capture_until = if enabled { now() + 5 * 60 * 1000 } else { 0 };
    if !enabled { state.stderr.clear(); }
    json!({"captureUntil": state.capture_until})
}
#[tauri::command]
pub fn agent_diagnostics_details() -> Value {
    let state = store().lock().unwrap();
    json!({"stderr": state.stderr, "captureUntil": state.capture_until})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_never_persists_arbitrary_error_messages_or_payloads() {
        let event = sanitize(&json!({"event":"tool.failed", "arguments":{"secret":"private"}, "failure":{"code":"TOOL_EXECUTION_FAILED","phase":"execution","message":"Bearer private"}, "tool":"private title"}));
        assert!(!event.to_string().contains("private"));
        assert_eq!(event["tool"], "unknown");
    }
    #[test]
    fn details_redact_entire_sensitive_lines_and_bound_text() {
        assert_eq!(redact_detail("Authorization: Bearer fixture", &[]), "[redacted sensitive line]");
        assert_eq!(redact_detail("unlabelled value fixture", &["fixture".into()]), "[redacted sensitive line]");
        assert_eq!(redact_detail("provider failed to initialize", &[]), "provider failed to initialize");
        assert!(redact_detail(&"word ".repeat(1000), &[]).len() <= 2048);
    }
    #[test]
    fn logs_rotate_and_are_private() {
        let directory = std::env::temp_dir().join(format!("kan-diagnostics-test-{}-{}", std::process::id(), now()));
        fs::create_dir(&directory).unwrap();
        let event = json!({"event":"test", "bytes":0});
        persist(&directory, &event).unwrap();
        let path = directory.join("events.jsonl");
        OpenOptions::new().write(true).open(&path).unwrap().set_len(LOG_BYTES + 1).unwrap();
        persist(&directory, &event).unwrap();
        assert!(directory.join("events.previous.jsonl").exists());
        assert!(fs::metadata(&path).unwrap().len() < 1024);
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600); }
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn timeout_and_exit_are_distinct() {
        assert_eq!(from_message("agent turn timed out", "agent")["code"], "AGENT_TIMEOUT");
        assert_eq!(from_message("agent exited", "agent")["code"], "AGENT_EXITED");
    }
}
