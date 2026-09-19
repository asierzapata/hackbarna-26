//! Agent runner: a minimal ACP client for the host's own coding agent.
//!
//! Two providers, one protocol. `devin acp` and `codex-acp` are both Agent
//! Client Protocol servers over stdio, so the difference between them is a
//! command line and an environment variable — everything below the launcher is
//! shared. That is the "runs under the host's own subscription" slot in
//! ARCHITECTURE.md: the app never holds a model token, it drives a local
//! process that already has one.
//!
//! | Provider | Command | Subscription | API key |
//! | --- | --- | --- | --- |
//! | Devin | `devin acp` | `devin auth login` creds, else ACP `authenticate` | `WINDSURF_API_KEY` |
//! | OpenAI | `npx -y @agentclientprotocol/codex-acp` | ChatGPT login, via ACP `authenticate` | `CODEX_API_KEY` |
//!
//! The protocol is JSON-RPC 2.0, one message per line:
//!
//!   - we call `initialize`, then `session/new` (or `authenticate` first, if the
//!     agent answers `session/new` with the `auth_required` error, -32000)
//!   - `session/prompt` runs a turn; the agent streams `session/update`
//!     notifications while it works, which we forward to the webview as
//!     `agent:update` events, and answers the original request with a stop
//!     reason when the turn ends
//!
//! Requests block on a channel fed by the reader thread, so a long prompt turn
//! never holds a lock that a status check would need.
//!
//! Only one provider is connected at a time: signing into the other one
//! replaces the connection. A typed API key arrives with the sign-in call and
//! goes into the child's environment; we never write it anywhere, but note that
//! the Codex adapter caches whatever it authenticated with in its own
//! `$CODEX_HOME/auth.json`, which is why signing out deletes that file.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::canvas_mcp::{AgentWorkspace, CanvasMcp};

/// JSON-RPC error code for "authentication required" (ACP reserves -32000).
const AUTH_REQUIRED: i64 = -32000;

/// How we answer `session/request_permission`.
///
/// These are coding agents: left to themselves they will ask to run shell
/// commands and edit files on this machine. For chat we decline, which still
/// lets them answer from the conversation, and the declined call shows up in
/// the thread. Flip this to allow tool use once the canvas MCP server exists
/// and there is something worth approving.
const AUTO_APPROVE_TOOLS: bool = false;

/* ----------------------------------------------------------------- errors */

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

/* --------------------------------------------------------------- providers */

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Devin,
    Openai,
}

impl Provider {
    fn label(self) -> &'static str {
        match self {
            Provider::Devin => "Devin",
            Provider::Openai => "OpenAI",
        }
    }

    /// Env var carrying the API key into the child, per adapter.
    fn key_var(self) -> &'static str {
        match self {
            Provider::Devin => "WINDSURF_API_KEY",
            Provider::Openai => "CODEX_API_KEY",
        }
    }
}

/// Which credentials the user picked in the Sign In menu.
#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthMode {
    /// The agent's own login: stored CLI credentials, or a browser flow.
    Subscription,
    /// A key the user typed, held for this run only.
    ApiKey,
}

/// A binary plus the arguments and environment that turn it into an ACP server.
struct Launch {
    program: PathBuf,
    args: Vec<&'static str>,
    env: Vec<(String, String)>,
}

/// A bundled macOS app inherits a stripped PATH (`/usr/bin:/bin:...`), so the
/// usual install locations have to be probed explicitly rather than trusted to
/// resolve by name.
fn find_bin(name: &str, override_var: &str) -> Option<PathBuf> {
    if let Ok(explicit) = std::env::var(override_var) {
        let path = PathBuf::from(explicit);
        if path.exists() {
            return Some(path);
        }
    }

    let mut dirs: Vec<PathBuf> = std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    )
    .collect();

    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(&home);
        dirs.push(home.join(".local/bin"));
        // nvm keeps every node it installs in its own prefix and puts none of
        // them anywhere else, so a stripped PATH loses npx entirely.
        if let Ok(versions) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            dirs.extend(versions.flatten().map(|entry| entry.path().join("bin")));
        }
    }
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));

    dirs.into_iter().map(|dir| dir.join(name)).find(|p| p.exists())
}

/// Scratch working directory under the app data dir. The agent wants a cwd;
/// give it an empty one of ours rather than whatever the app was launched from.
fn scratch(app: &AppHandle, name: &str) -> Result<PathBuf, RpcError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| RpcError::transport(e.to_string()))?
        .join(name);
    std::fs::create_dir_all(&dir).map_err(|e| RpcError::transport(e.to_string()))?;
    Ok(dir)
}

fn launch_spec(
    app: &AppHandle,
    provider: Provider,
    api_key: Option<&str>,
) -> Result<Launch, RpcError> {
    let mut env: Vec<(String, String)> = Vec::new();
    if let Some(key) = api_key {
        env.push((provider.key_var().to_string(), key.to_string()));
    }

    match provider {
        Provider::Devin => {
            let program = find_bin("devin", "DEVIN_BIN").ok_or_else(|| {
                RpcError::transport(
                    "Devin CLI not found. Install it, or set DEVIN_BIN to its path.",
                )
            })?;
            Ok(Launch { program, args: vec!["acp"], env })
        }
        Provider::Openai => {
            let program = find_bin("npx", "NPX_BIN").ok_or_else(|| {
                RpcError::transport(
                    "npx not found; it is needed to run the Codex ACP adapter. \
                     Install Node, or set NPX_BIN to npx's path.",
                )
            })?;
            // The Devin CLI is a Codex fork and owns `~/.codex`, including an
            // `auth.json` holding *Devin* tokens in Codex's format. Pointing
            // the adapter at a home of our own keeps the two from reading each
            // other's credentials.
            env.push((
                "CODEX_HOME".to_string(),
                scratch(app, "codex-home")?.to_string_lossy().into_owned(),
            ));
            Ok(Launch {
                program,
                args: vec!["-y", "@agentclientprotocol/codex-acp"],
                env,
            })
        }
    }
}

/* ------------------------------------------------------------- connection */

/// Hands out one id per connection, so a dying reader thread can tell whether
/// the connection it was reading is still the active one.
static NEXT_CONN: AtomicU64 = AtomicU64::new(1);

/// One running ACP server.
struct Conn {
    id: u64,
    provider: Provider,
    /// Credentials this child was started with. A child's environment cannot be
    /// changed after the fact, so a different choice needs a different child.
    mode: AuthMode,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, Sender<Value>>>>,
    next_id: AtomicU64,
    session_id: Mutex<Option<String>>,
    session_canvas: Mutex<Option<String>>,
    prompt_lock: Mutex<()>,
    canvas_mcp: Arc<CanvasMcp>,
    workspace: AgentWorkspace,
    /// Auth methods advertised by `initialize`, as `(id, name)`.
    auth_methods: Mutex<Vec<(String, String)>>,
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

        if let Err(error) = write_message(
            &self.stdin,
            &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        ) {
            self.pending.lock().unwrap().remove(&id);
            return Err(error);
        }

        // The sender is dropped if the process dies, which unblocks us.
        let reply = rx.recv_timeout(std::time::Duration::from_secs(300));
        self.pending.lock().unwrap().remove(&id);
        let reply = reply.map_err(|_| RpcError::transport("the agent exited or timed out before replying"))?;

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

    /// The advertised method matching the user's choice.
    ///
    /// Ids are not standardised — Devin advertises `devin-browser`, the Codex
    /// adapter advertises a ChatGPT login and an API-key method — so we match
    /// on the shape of the id and name rather than on a fixed list.
    fn auth_method(&self, mode: AuthMode) -> Option<String> {
        let methods = self.auth_methods.lock().unwrap();
        let is_key = |(id, name): &&(String, String)| {
            let haystack = format!("{} {}", id.to_lowercase(), name.to_lowercase());
            haystack.contains("api") || haystack.contains("key")
        };
        match mode {
            AuthMode::ApiKey => methods.iter().find(is_key),
            AuthMode::Subscription => methods
                .iter()
                .find(|m| !is_key(m))
                .or_else(|| methods.first()),
        }
        .map(|(id, _)| id.clone())
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
    conn_id: u64,
    stdout: ChildStdout,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, Sender<Value>>>>,
    canvas_mcp: Arc<CanvasMcp>,
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
                    "session/request_permission" => Some(permission_reply(&msg, &canvas_mcp)),
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
                    let session_id = msg.pointer("/params/sessionId").and_then(Value::as_str);
                    if let Some(session_id) = session_id {
                        canvas_mcp.record_tool_call(session_id, update);
                    }
                    if let Some(turn_id) = session_id.and_then(|id| canvas_mcp.active_turn(id)) {
                        let _ = app.emit_to("main", "agent:update", json!({"turnId": turn_id, "update": update}));
                    }
                }
            }
            _ => {}
        }
    }

    // Drop every waiting sender first so blocked callers fail fast, *then*
    // clear the shared slot — order matters, a caller may hold it.
    pending.lock().unwrap().clear();

    // Switching providers kills this child on purpose and a newer connection is
    // already in the slot by now, so only the active one reports itself gone.
    let was_active = app
        .try_state::<Agent>()
        .map(|state| {
            let mut slot = state.0.lock().unwrap();
            let active = slot.as_ref().is_some_and(|conn| conn.id == conn_id);
            if active {
                *slot = None;
            }
            active
        })
        .unwrap_or(false);

    if was_active {
        let _ = app.emit("agent:closed", ());
    }
}

/// Picks the option matching our policy, preferring a one-shot answer.
fn permission_reply(msg: &Value, canvas: &CanvasMcp) -> Value {
    let options = msg
        .pointer("/params/options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let session_id = msg.pointer("/params/sessionId").and_then(Value::as_str);
    let tool_call_id = msg.pointer("/params/toolCall/toolCallId").and_then(Value::as_str);
    let tool_name = msg.pointer("/params/toolCall/name").and_then(Value::as_str);
    let allowed_canvas = canvas.allows(session_id, tool_call_id, tool_name);
    let wanted: [&str; 2] = if AUTO_APPROVE_TOOLS || allowed_canvas {
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

/* --------------------------------------------------------------- the state */

#[derive(Default)]
pub struct Agent(Mutex<Option<Arc<Conn>>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    /// `ready` | `unavailable`
    state: &'static str,
    /// Which provider the status is about, once one has been picked.
    provider: Option<Provider>,
    /// Display name for that provider, e.g. "OpenAI".
    provider_label: Option<&'static str>,
    /// Agent title from `initialize`, e.g. "Devin Agent".
    agent: Option<String>,
    message: Option<String>,
}

impl AgentStatus {
    fn unavailable(provider: Provider, message: impl Into<String>) -> Self {
        Self {
            state: "unavailable",
            provider: Some(provider),
            provider_label: Some(provider.label()),
            agent: None,
            message: Some(message.into()),
        }
    }

    fn ready(provider: Provider, agent: Option<String>) -> Self {
        Self {
            state: "ready",
            provider: Some(provider),
            provider_label: Some(provider.label()),
            agent,
            message: None,
        }
    }
}

/// Spawns the provider's ACP server and completes the `initialize` handshake.
///
/// Reuses a live connection only for a repeat of the same subscription sign-in.
/// The other provider replaces it, since exactly one is active at a time, and a
/// typed key always gets a fresh child — it may not be the key the running one
/// was given, and its environment is fixed at spawn.
fn open(
    app: &AppHandle,
    provider: Provider,
    mode: AuthMode,
    api_key: Option<&str>,
    tools: Vec<Value>,
    canvas_id: Option<String>,
) -> Result<(Arc<Conn>, Option<String>), RpcError> {
    {
        let state = app.state::<Agent>();
        let mut slot = state.0.lock().unwrap();
        if slot.as_ref().is_some_and(|conn| conn.prompt_lock.try_lock().is_err()) {
            return Err(RpcError::transport("An agent turn is still running"));
        }
        let reusable = slot.as_ref().is_some_and(|conn| {
            conn.provider == provider
                && conn.mode == mode
                && mode == AuthMode::Subscription
                && *conn.session_canvas.lock().unwrap() == canvas_id
        });
        match slot.clone() {
            Some(conn) if reusable => {
                let agent = conn.agent.lock().unwrap().clone();
                return Ok((conn, agent));
            }
            // Dropping it kills the child and its reader thread follows on EOF.
            Some(_) => *slot = None,
            None => {}
        }
    }

    let spec = launch_spec(app, provider, api_key)?;
    let canvas_mcp = CanvasMcp::start(app.clone(), tools).map_err(RpcError::transport)?;
    let workspace = canvas_mcp.workspace(&scratch(app, "agent-workspaces")?, provider == Provider::Devin).map_err(RpcError::transport)?;

    let mut child = Command::new(&spec.program)
        .current_dir(&workspace.0)
        .args(&spec.args)
        .envs(spec.env)
        // These CLIs log heavily to stderr and also write a log file; piping it
        // without draining would eventually fill the pipe and wedge the agent.
        .stderr(Stdio::null())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| {
            RpcError::transport(format!("could not start `{}`: {e}", spec.program.display()))
        })?;

    let stdin = Arc::new(Mutex::new(child.stdin.take().expect("piped stdin")));
    let stdout = child.stdout.take().expect("piped stdout");
    let pending: Arc<Mutex<HashMap<u64, Sender<Value>>>> = Arc::default();
    let id = NEXT_CONN.fetch_add(1, Ordering::SeqCst);

    {
        let app = app.clone();
        let stdin = stdin.clone();
        let pending = pending.clone();
        let canvas_mcp = canvas_mcp.clone();
        std::thread::spawn(move || reader_loop(app, id, stdout, stdin, pending, canvas_mcp));
    }

    let conn = Arc::new(Conn {
        id,
        provider,
        mode,
        stdin,
        pending,
        next_id: AtomicU64::new(1),
        session_id: Mutex::new(None),
        session_canvas: Mutex::new(canvas_id),
        prompt_lock: Mutex::new(()),
        canvas_mcp,
        workspace,
        auth_methods: Mutex::new(Vec::new()),
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

    *conn.auth_methods.lock().unwrap() = init
        .get("authMethods")
        .and_then(Value::as_array)
        .map(|methods| {
            methods
                .iter()
                .filter_map(|m| {
                    let id = m.get("id").and_then(Value::as_str)?;
                    let name = m.get("name").and_then(Value::as_str).unwrap_or(id);
                    Some((id.to_string(), name.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();

    let agent = init
        .pointer("/agentInfo/title")
        .and_then(Value::as_str)
        .map(str::to_string);
    *conn.agent.lock().unwrap() = agent.clone();

    *app.state::<Agent>().0.lock().unwrap() = Some(conn.clone());
    Ok((conn, agent))
}

/// Creates the session, running the provider's auth flow if it asks for one.
fn start_session(
    _app: &AppHandle,
    conn: &Conn,
    mode: AuthMode,
    agent: Option<String>,
) -> AgentStatus {
    let provider = conn.provider;
    if conn.session_id.lock().unwrap().is_some() {
        return AgentStatus::ready(provider, agent);
    }

    let cwd = &conn.workspace.0;
    let server = match conn.canvas_mcp.config() {
        Ok(server) => server,
        Err(error) => return AgentStatus::unavailable(provider, error),
    };
    let params = json!({ "cwd": cwd.to_string_lossy(), "mcpServers": [server] });

    // An API key has to be selected explicitly, or an adapter with a stale
    // browser login in its home would quietly use that instead. A subscription
    // is the opposite: try the stored credentials first and only open a browser
    // if the agent says it needs one.
    if mode == AuthMode::ApiKey {
        if let Some(method) = conn.auth_method(mode) {
            if let Err(e) = conn.request("authenticate", json!({ "methodId": method })) {
                return AgentStatus::unavailable(provider, e.message);
            }
        }
    }

    match conn.request("session/new", params.clone()) {
        Ok(result) => finish(conn, result, agent),
        Err(e) if e.code == AUTH_REQUIRED => {
            let Some(method) = conn.auth_method(mode) else {
                return AgentStatus::unavailable(
                    provider,
                    "the agent advertises no way to authenticate",
                );
            };
            match conn
                .request("authenticate", json!({ "methodId": method }))
                .and_then(|_| conn.request("session/new", params))
            {
                Ok(result) => finish(conn, result, agent),
                Err(e) => AgentStatus::unavailable(provider, e.message),
            }
        }
        Err(e) => AgentStatus::unavailable(provider, e.message),
    }
}

fn finish(conn: &Conn, result: Value, agent: Option<String>) -> AgentStatus {
    match result.get("sessionId").and_then(Value::as_str) {
        Some(id) => {
            *conn.session_id.lock().unwrap() = Some(id.to_string());
            AgentStatus::ready(conn.provider, agent)
        }
        None => AgentStatus::unavailable(conn.provider, "agent returned no sessionId"),
    }
}

/* ------------------------------------------------------------ the commands */

/// Starts the chosen provider and opens a session with the chosen credentials.
///
/// `api_key` is only read when `mode` is `api_key` and is handed straight to the
/// child's environment; nothing here writes it down.
#[tauri::command]
pub async fn agent_sign_in(
    app: AppHandle,
    provider: Provider,
    mode: AuthMode,
    api_key: Option<String>,
    tools: Vec<Value>,
    canvas_id: Option<String>,
) -> Result<AgentStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = match mode {
            AuthMode::ApiKey => match api_key.as_deref().map(str::trim) {
                Some(key) if !key.is_empty() => Some(key),
                _ => return AgentStatus::unavailable(provider, "no API key given"),
            },
            AuthMode::Subscription => None,
        };

        let status = match open(&app, provider, mode, key, tools, canvas_id) {
            Ok((conn, agent)) => start_session(&app, &conn, mode, agent),
            Err(e) => AgentStatus::unavailable(provider, e.message),
        };

        // A child that could not open a session is useless, and leaving it in
        // the slot would make the next attempt reuse it and fail the same way.
        if status.state != "ready" {
            let state = app.state::<Agent>();
            let mut slot = state.0.lock().unwrap();
            if slot.as_ref().is_some_and(|conn| conn.session_id.lock().unwrap().is_none()) {
                *slot = None;
            }
        }
        status
    })
    .await
    .map_err(|e| e.to_string())
}

/// Runs one prompt turn. Text streams back as `agent:update` events; this
/// resolves with the stop reason when the turn ends.
#[tauri::command]
pub async fn agent_prompt(app: AppHandle, text: String, turn_id: String, canvas_id: Option<String>) -> Result<String, String> {
    if text.len() > 128 * 1024 || turn_id.is_empty() || turn_id.len() > 128 || canvas_id.as_ref().is_some_and(|id| id.len() > 128) {
        return Err("Invalid agent prompt".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let conn = app.state::<Agent>().0.lock().unwrap().clone().ok_or("no agent is connected")?;
        let _turn = conn.prompt_lock.try_lock().map_err(|_| "An agent turn is already running")?;
        if *conn.session_canvas.lock().unwrap() != canvas_id {
            return Err("Connect the local agent for this canvas before sending a prompt".into());
        }
        let session_id = conn.session_id.lock().unwrap().clone().ok_or("the agent has no session")?;
        conn.canvas_mcp.begin(turn_id.clone(), canvas_id, session_id.clone())?;
        let result = conn.request("session/prompt", json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": text }]
        })).map_err(String::from);
        let was_active = conn.canvas_mcp.finish(&turn_id);
        if result.is_err() {
            let _ = write_message(&conn.stdin, &json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session_id}}));
        }
        if !was_active { return Err("Agent turn cancelled".into()); }
        Ok(result?.get("stopReason").and_then(Value::as_str).unwrap_or("end_turn").to_string())
    }).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn agent_canvas_result(app: AppHandle, request_id: String, turn_id: String, result: Value, error: Option<String>) -> Result<(), String> {
    let conn = app.state::<Agent>().0.lock().unwrap().clone().ok_or("Agent disconnected")?;
    if result.to_string().len() > 2 * 1024 * 1024 { return Err("Canvas result too large".into()); }
    conn.canvas_mcp.complete(&request_id, &turn_id, error.map_or(Ok(result), Err))
}

#[tauri::command]
pub fn agent_cancel(app: AppHandle, turn_id: String) {
    let conn = app.state::<Agent>().0.lock().unwrap().clone();
    if let Some(conn) = conn {
        if conn.canvas_mcp.finish(&turn_id) {
            let session_id = conn.session_id.lock().unwrap().clone();
            let _ = write_message(&conn.stdin, &json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session_id}}));
        }
    }
}

#[tauri::command]
pub fn agent_status(app: AppHandle, canvas_id: Option<String>) -> AgentStatus {
    match app.state::<Agent>().0.lock().unwrap().as_ref() {
        Some(conn) if conn.session_id.lock().unwrap().is_some() && *conn.session_canvas.lock().unwrap() == canvas_id => AgentStatus::ready(conn.provider, conn.agent.lock().unwrap().clone()),
        _ => AgentStatus { state: "idle", provider: None, provider_label: None, agent: None, message: None },
    }
}

/// Drops the connection; the child is killed with it, and the reader thread
/// follows it out on EOF. Then deletes a cached API key, if the adapter wrote
/// one.
///
/// Stored *subscription* credentials are deliberately left alone, so
/// reconnecting is one click. Neither adapter advertises the ACP `logout`
/// capability, so clearing those would mean `devin auth logout` or `codex
/// logout`, which would log the user out of their terminal too.
#[tauri::command]
pub fn agent_sign_out(app: AppHandle) {
    let state = app.state::<Agent>();
    let conn = state.0.lock().unwrap().take();

    // Read what we need, then drop the Arc: its `Drop` waits for the child, so
    // the file cannot be rewritten underneath us afterwards.
    let Some((provider, mode)) = conn.map(|conn| {
        let _ = conn.canvas_mcp.rotate_session();
        (conn.provider, conn.mode)
    }) else {
        return;
    };
    if (provider, mode) == (Provider::Openai, AuthMode::ApiKey) {
        forget_cached_api_key(&app);
    }
}

/// Removes the key the Codex adapter cached in its home.
///
/// We pass the key in the environment and never write it ourselves, but the
/// adapter persists whatever it authenticated with to `$CODEX_HOME/auth.json`.
/// Only a file in api-key mode is removed — in ChatGPT mode the same file holds
/// the browser login, which is the user's to keep.
fn forget_cached_api_key(app: &AppHandle) {
    let Ok(path) = scratch(app, "codex-home").map(|dir| dir.join("auth.json")) else {
        return;
    };
    let cached_a_key = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .is_some_and(|json| {
            json.get("auth_mode").and_then(Value::as_str) == Some("apikey")
        });
    if cached_a_key {
        let _ = std::fs::remove_file(&path);
    }
}
