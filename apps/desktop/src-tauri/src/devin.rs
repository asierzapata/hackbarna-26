//! Agent runner: a minimal ACP client for the Devin CLI.
//!
//! `devin acp` runs the user's own Devin CLI as an Agent Client Protocol server
//! over stdio, authenticated by whatever `devin auth login` stored. That is the
//! "runs under the host's own subscription" slot in ARCHITECTURE.md — the app
//! never holds a model token, it just drives a local process.
//!
//! The protocol is JSON-RPC 2.0, one message per line:
//!
//!   - we call `initialize`, then `session/new` (or `authenticate` first, if the
//!     agent answers `session/new` with the `auth_required` error, -32000)
//!   - `session/prompt` runs a turn; the agent streams `session/update`
//!     notifications while it works, which we forward to the webview as
//!     `devin:update` events, and answers the original request with a stop
//!     reason when the turn ends
//!
//! Requests block on a channel fed by the reader thread, so a long prompt turn
//! never holds a lock that a status check would need.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

/// JSON-RPC error code for "authentication required" (ACP reserves -32000).
const AUTH_REQUIRED: i64 = -32000;

/// How we answer `session/request_permission`.
///
/// Devin is a coding agent: left to itself it will ask to run shell commands
/// and edit files on this machine. For chat we decline, which still lets it
/// answer from the conversation, and the declined call shows up in the thread.
/// Flip this to allow tool use once the canvas MCP server exists and there is
/// something worth approving.
const AUTO_APPROVE_TOOLS: bool = false;

/* ------------------------------------------------------------------ errors */

pub struct RpcError {
    code: i64,
    message: String,
}

impl RpcError {
    fn transport(message: impl Into<String>) -> Self {
        Self { code: 0, message: message.into() }
    }
}

impl From<RpcError> for String {
    fn from(err: RpcError) -> String {
        err.message
    }
}

/* ------------------------------------------------------------- connection */

/// One running `devin acp` process.
struct Conn {
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, Sender<Value>>>>,
    next_id: AtomicU64,
    session_id: Mutex<Option<String>>,
    /// Auth method advertised by `initialize`, e.g. `devin-browser`.
    auth_method: Mutex<Option<String>>,
    /// Agent title from `initialize`, kept so a reconnect can still report it.
    agent: Mutex<Option<String>>,
    /// Kept so the child is killed when the connection is dropped.
    child: Mutex<Child>,
}

impl Drop for Conn {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            // Reap it, so a disconnect does not leave a zombie behind.
            let _ = child.wait();
        }
    }
}

impl Conn {
    fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = channel();
        self.pending.lock().unwrap().insert(id, tx);

        write_message(
            &self.stdin,
            &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        )?;

        // The sender is dropped if the process dies, which unblocks us.
        let reply = rx
            .recv()
            .map_err(|_| RpcError::transport("devin acp exited before replying"))?;

        if let Some(err) = reply.get("error") {
            return Err(RpcError {
                code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
                message: err
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error")
                    .to_string(),
            });
        }
        Ok(reply.get("result").cloned().unwrap_or(Value::Null))
    }
}

fn write_message(stdin: &Mutex<ChildStdin>, msg: &Value) -> Result<(), RpcError> {
    let mut out = stdin.lock().unwrap();
    writeln!(out, "{}", msg).map_err(|e| RpcError::transport(e.to_string()))?;
    out.flush().map_err(|e| RpcError::transport(e.to_string()))
}

/* ----------------------------------------------------------- reader thread */

/// Reads the agent's stdout forever: routes responses to whoever is waiting,
/// forwards `session/update` to the webview, and answers the handful of
/// requests the agent makes of us.
fn reader_loop(
    app: AppHandle,
    stdout: ChildStdout,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, Sender<Value>>>>,
) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };

        let id = msg.get("id").cloned();
        // Owned, so an arm is free to move `msg`.
        let method = msg.get("method").and_then(Value::as_str).map(str::to_string);

        match (method.as_deref(), id) {
            // Response to one of our requests.
            (None, Some(Value::Number(n))) => {
                if let Some(id) = n.as_u64() {
                    if let Some(tx) = pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(msg);
                    }
                }
            }
            // Request from the agent — must be answered or the turn stalls.
            (Some(method), Some(id)) => {
                let result = match method {
                    "session/request_permission" => Some(permission_reply(&msg)),
                    _ => None,
                };
                let reply = match result {
                    Some(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                    None => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": -32601, "message": format!("{method} not supported") }
                    }),
                };
                let _ = write_message(&stdin, &reply);
            }
            // Notification.
            (Some("session/update"), None) => {
                if let Some(update) = msg.pointer("/params/update") {
                    let _ = app.emit("devin:update", update);
                }
            }
            _ => {}
        }
    }

    // Drop every waiting sender first so blocked callers fail fast, *then*
    // clear the shared slot — order matters, a caller may hold it.
    pending.lock().unwrap().clear();
    if let Some(state) = app.try_state::<Devin>() {
        *state.0.lock().unwrap() = None;
    }
    let _ = app.emit("devin:closed", ());
}

/// Picks the option matching our policy, preferring a one-shot answer.
fn permission_reply(msg: &Value) -> Value {
    let options = msg
        .pointer("/params/options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let wanted: [&str; 2] = if AUTO_APPROVE_TOOLS {
        ["allow_once", "allow_always"]
    } else {
        ["reject_once", "reject_always"]
    };

    let chosen = wanted.iter().find_map(|kind| {
        options
            .iter()
            .find(|o| o.get("kind").and_then(Value::as_str) == Some(kind))
            .and_then(|o| o.get("optionId"))
            .and_then(Value::as_str)
    });

    match chosen {
        Some(option_id) => json!({ "outcome": { "outcome": "selected", "optionId": option_id } }),
        None => json!({ "outcome": { "outcome": "cancelled" } }),
    }
}

/* -------------------------------------------------------------- the binary */

/// A bundled macOS app inherits a stripped PATH (`/usr/bin:/bin:...`), so the
/// CLI's default install location has to be probed explicitly.
fn devin_binary() -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var("DEVIN_BIN") {
        let path = PathBuf::from(explicit);
        if path.exists() {
            return Some(path);
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(&home).join(".local/bin/devin"));
    }
    candidates.push(PathBuf::from("/opt/homebrew/bin/devin"));
    candidates.push(PathBuf::from("/usr/local/bin/devin"));

    candidates.into_iter().find(|p| p.exists())
}

/* --------------------------------------------------------------- the state */

#[derive(Default)]
pub struct Devin(Mutex<Option<Arc<Conn>>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DevinStatus {
    /// `ready` | `needs_login` | `unavailable`
    state: &'static str,
    /// Agent title from `initialize`, e.g. "Devin Agent".
    agent: Option<String>,
    message: Option<String>,
}

impl DevinStatus {
    fn unavailable(message: impl Into<String>) -> Self {
        Self { state: "unavailable", agent: None, message: Some(message.into()) }
    }
}

/// Spawns `devin acp` and completes the `initialize` handshake.
fn open(app: &AppHandle) -> Result<(Arc<Conn>, Option<String>), RpcError> {
    if let Some(conn) = app.state::<Devin>().0.lock().unwrap().clone() {
        let agent = conn.agent.lock().unwrap().clone();
        return Ok((conn, agent));
    }

    let bin = devin_binary().ok_or_else(|| {
        RpcError::transport("Devin CLI not found. Install it, or set DEVIN_BIN to its path.")
    })?;

    let mut child = Command::new(&bin)
        .arg("acp")
        // The CLI logs heavily to stderr and also writes a log file; piping it
        // without draining would eventually fill the pipe and wedge the agent.
        .stderr(Stdio::null())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| RpcError::transport(format!("could not start `{} acp`: {e}", bin.display())))?;

    let stdin = Arc::new(Mutex::new(child.stdin.take().expect("piped stdin")));
    let stdout = child.stdout.take().expect("piped stdout");
    let pending: Arc<Mutex<HashMap<u64, Sender<Value>>>> = Arc::default();

    {
        let app = app.clone();
        let stdin = stdin.clone();
        let pending = pending.clone();
        std::thread::spawn(move || reader_loop(app, stdout, stdin, pending));
    }

    let conn = Arc::new(Conn {
        stdin,
        pending,
        next_id: AtomicU64::new(1),
        session_id: Mutex::new(None),
        auth_method: Mutex::new(None),
        agent: Mutex::new(None),
        child: Mutex::new(child),
    });

    let init = conn.request(
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientInfo": { "name": "kan", "version": env!("CARGO_PKG_VERSION") },
            // No fs or terminal capability: the agent keeps its tools to itself
            // rather than reaching through us into the user's machine.
            "clientCapabilities": {
                "fs": { "readTextFile": false, "writeTextFile": false },
                "terminal": false
            }
        }),
    )?;

    *conn.auth_method.lock().unwrap() = init
        .pointer("/authMethods/0/id")
        .and_then(Value::as_str)
        .map(str::to_string);

    let agent = init
        .pointer("/agentInfo/title")
        .and_then(Value::as_str)
        .map(str::to_string);
    *conn.agent.lock().unwrap() = agent.clone();

    *app.state::<Devin>().0.lock().unwrap() = Some(conn.clone());
    Ok((conn, agent))
}

/// Scratch working directory. The agent wants a cwd; give it an empty one of
/// ours rather than whatever the app happens to be launched from.
fn workspace(app: &AppHandle) -> Result<PathBuf, RpcError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| RpcError::transport(e.to_string()))?
        .join("devin-workspace");
    std::fs::create_dir_all(&dir).map_err(|e| RpcError::transport(e.to_string()))?;
    Ok(dir)
}

/// Creates the session, reporting `needs_login` instead of failing when the
/// CLI has no stored credentials.
fn start_session(app: &AppHandle, conn: &Conn, agent: Option<String>) -> DevinStatus {
    if conn.session_id.lock().unwrap().is_some() {
        return DevinStatus { state: "ready", agent, message: None };
    }

    let cwd = match workspace(app) {
        Ok(cwd) => cwd,
        Err(e) => return DevinStatus::unavailable(e.message),
    };

    match conn.request(
        "session/new",
        json!({ "cwd": cwd.to_string_lossy(), "mcpServers": [] }),
    ) {
        Ok(result) => {
            let id = result.get("sessionId").and_then(Value::as_str).map(str::to_string);
            match id {
                Some(id) => {
                    *conn.session_id.lock().unwrap() = Some(id);
                    DevinStatus { state: "ready", agent, message: None }
                }
                None => DevinStatus::unavailable("agent returned no sessionId"),
            }
        }
        Err(e) if e.code == AUTH_REQUIRED => DevinStatus {
            state: "needs_login",
            agent,
            message: None,
        },
        Err(e) => DevinStatus::unavailable(e.message),
    }
}

/* ------------------------------------------------------------- the commands */

/// Starts the agent and reports whether it is usable, without logging anyone in.
#[tauri::command]
pub async fn devin_connect(app: AppHandle) -> Result<DevinStatus, String> {
    tauri::async_runtime::spawn_blocking(move || match open(&app) {
        Ok((conn, agent)) => start_session(&app, &conn, agent),
        Err(e) => DevinStatus::unavailable(e.message),
    })
    .await
    .map_err(|e| e.to_string())
}

/// Runs the agent's own auth flow (`devin-browser` opens a browser window),
/// then creates the session.
#[tauri::command]
pub async fn devin_login(app: AppHandle) -> Result<DevinStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (conn, agent) = match open(&app) {
            Ok(pair) => pair,
            Err(e) => return DevinStatus::unavailable(e.message),
        };

        let method = conn.auth_method.lock().unwrap().clone();
        let Some(method) = method else {
            return DevinStatus::unavailable("agent advertises no authentication method");
        };

        match conn.request("authenticate", json!({ "methodId": method })) {
            Ok(_) => start_session(&app, &conn, agent),
            Err(e) => DevinStatus::unavailable(e.message),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Runs one prompt turn. Text streams back as `devin:update` events; this
/// resolves with the stop reason when the turn ends.
#[tauri::command]
pub async fn devin_prompt(app: AppHandle, text: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = app
            .state::<Devin>()
            .0
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "Devin is not connected".to_string())?;

        let session_id = conn
            .session_id
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "Devin has no session".to_string())?;

        let result = conn
            .request(
                "session/prompt",
                json!({
                    "sessionId": session_id,
                    "prompt": [{ "type": "text", "text": text }]
                }),
            )
            .map_err(String::from)?;

        Ok(result
            .get("stopReason")
            .and_then(Value::as_str)
            .unwrap_or("end_turn")
            .to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Drops the connection; the child is killed with it, and the reader thread
/// follows it out on EOF.
///
/// This does not touch the CLI's stored credentials — reconnecting is one
/// click. `devin acp` does not advertise the ACP `logout` capability, so
/// clearing credentials would mean `devin auth logout`, which would log the
/// user out of their terminal too.
#[tauri::command]
pub fn devin_disconnect(state: State<'_, Devin>) {
    *state.0.lock().unwrap() = None;
}
