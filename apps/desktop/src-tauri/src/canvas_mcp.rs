use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

const MAX_MESSAGE: usize = 2 * 1024 * 1024;
const TOOL_NAMES: [&str; 8] = ["addNode", "updateNode", "removeNodes", "connectNodes", "arrange", "focusNodes", "groupNodes", "getCanvas"];
type ToolResult = Result<Value, String>;
type Emit = dyn Fn(Value) -> Result<(), String> + Send + Sync;

#[derive(Clone)]
struct Turn {
    id: String,
    canvas_id: Option<String>,
    session_id: String,
}

struct State {
    token: String,
    turn: Option<Turn>,
    pending: HashMap<String, Sender<ToolResult>>,
    canvas_tool_calls: HashSet<String>,
}

pub struct AgentWorkspace(pub PathBuf);

impl Drop for AgentWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.0.join(".devin/mcp_config.json"));
        let _ = std::fs::remove_dir(self.0.join(".devin"));
        let _ = std::fs::remove_dir(&self.0);
    }
}

pub struct CanvasMcp {
    address: SocketAddr,
    tools: Vec<Value>,
    state: Mutex<State>,
    emit: Box<Emit>,
}

fn nonce() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Could not generate canvas bridge token")?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn read_message(reader: &mut impl BufRead) -> Result<Option<Value>, String> {
    let mut line = String::new();
    let size = reader
        .take((MAX_MESSAGE + 1) as u64)
        .read_line(&mut line)
        .map_err(|_| "Could not read bridge message")?;
    if size == 0 {
        return Ok(None);
    }
    if size > MAX_MESSAGE || !line.ends_with('\n') {
        return Err("Bridge message too large or incomplete".into());
    }
    serde_json::from_str(&line)
        .map(Some)
        .map_err(|_| "Invalid bridge JSON".into())
}

fn write_message(writer: &mut impl Write, value: &Value) -> Result<(), String> {
    let text = value.to_string();
    if text.len() > MAX_MESSAGE {
        return Err("Bridge response too large".into());
    }
    writeln!(writer, "{text}")
        .and_then(|_| writer.flush())
        .map_err(|_| "Could not write bridge message".into())
}

impl CanvasMcp {
    pub fn start(app: AppHandle, tools: Vec<Value>) -> Result<Arc<Self>, String> {
        Self::with_emitter(
            tools,
            Box::new(move |event| {
                app.emit_to("main", "canvas:tool", event)
                    .map_err(|error| error.to_string())
            }),
        )
    }

    fn with_emitter(tools: Vec<Value>, emit: Box<Emit>) -> Result<Arc<Self>, String> {
        if tools.len() != TOOL_NAMES.len() || TOOL_NAMES.iter().any(|name| {
            tools.iter().filter(|tool| tool["name"] == *name && tool["inputSchema"]["type"] == "object").count() != 1
        }) {
            return Err("Expected the eight canvas tool schemas".into());
        }
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|error| error.to_string())?;
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let bridge = Arc::new(Self {
            address: listener.local_addr().map_err(|error| error.to_string())?,
            tools,
            state: Mutex::new(State {
                token: nonce()?,
                turn: None,
                pending: HashMap::new(),
                canvas_tool_calls: HashSet::new(),
            }),
            emit,
        });
        let weak = Arc::downgrade(&bridge);
        std::thread::spawn(move || {
            let connections = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            while weak.strong_count() > 0 {
                match listener.accept() {
                    Ok((mut socket, _)) => {
                        if connections.load(std::sync::atomic::Ordering::SeqCst) >= 8 {
                            continue;
                        }
                        let Some(bridge) = weak.upgrade() else { break };
                        connections.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        let count = connections.clone();
                        std::thread::spawn(move || {
                            let _ = socket.set_read_timeout(Some(Duration::from_secs(3)));
                            let _ = socket.set_write_timeout(Some(Duration::from_secs(3)));
                            let request = read_message(&mut BufReader::new(&socket));
                            let response = match request {
                                Ok(Some(request)) => bridge.dispatch(&request),
                                _ => json!({"error": "Invalid bridge request"}),
                            };
                            let _ = write_message(&mut socket, &response);
                            count.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                        });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(20))
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(bridge)
    }

    pub fn config(&self) -> Result<Value, String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        Ok(json!({
            "name": "kan-canvas", "command": executable, "args": ["--canvas-mcp"],
            "env": [
                {"name": "KAN_CANVAS_BRIDGE_ADDR", "value": self.address.to_string()},
                {"name": "KAN_CANVAS_BRIDGE_TOKEN", "value": self.state.lock().unwrap().token}
            ]
        }))
    }

    pub fn workspace(&self, base: &Path, devin: bool) -> Result<AgentWorkspace, String> {
        let path = base.join(nonce()?);
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&path).map_err(|error| error.to_string())?;
        let workspace = AgentWorkspace(path);
        if devin {
            builder
                .create(workspace.0.join(".devin"))
                .map_err(|error| error.to_string())?;
            let server = self.config()?;
            let env: serde_json::Map<String, Value> = server["env"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| {
                    (
                        entry["name"].as_str().unwrap().to_string(),
                        entry["value"].clone(),
                    )
                })
                .collect();
            let config = json!({"mcpServers": {"kan-canvas": {
                "command": server["command"], "args": server["args"], "env": env
            }}});
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(workspace.0.join(".devin/mcp_config.json"))
                .map_err(|error| error.to_string())?;
            write!(file, "{config}").map_err(|error| error.to_string())?;
        }
        Ok(workspace)
    }

    pub fn rotate_session(&self) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if state.turn.is_some() {
            return Err("An agent turn is still running".into());
        }
        state.token = nonce()?;
        state.canvas_tool_calls.clear();
        Ok(())
    }

    pub fn begin(
        &self,
        turn_id: String,
        canvas_id: Option<String>,
        session_id: String,
    ) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if state.turn.is_some() {
            return Err("An agent turn is already running".into());
        }
        state.canvas_tool_calls.clear();
        state.turn = Some(Turn {
            id: turn_id,
            canvas_id,
            session_id,
        });
        Ok(())
    }

    pub fn finish(&self, turn_id: &str) -> bool {
        let mut state = self.state.lock().unwrap();
        if !state.turn.as_ref().is_some_and(|turn| turn.id == turn_id) {
            return false;
        }
        state.turn = None;
        state.canvas_tool_calls.clear();
        for (_, sender) in state.pending.drain() {
            let _ = sender.send(Err("Canvas turn ended".into()));
        }
        true
    }

    pub fn active_turn(&self, session_id: &str) -> Option<String> {
        self.state
            .lock()
            .unwrap()
            .turn
            .as_ref()
            .filter(|turn| turn.session_id == session_id)
            .map(|turn| turn.id.clone())
    }

    fn canvas_tool_name(value: &str) -> bool {
        let name = value.strip_prefix("mcp__kan-canvas__").unwrap_or(value);
        if TOOL_NAMES.contains(&name) {
            return true;
        }
        value
            .strip_prefix("Calling ")
            .and_then(|calling| calling.strip_suffix(" from kan-canvas"))
            .is_some_and(|tool| TOOL_NAMES.contains(&tool))
    }

    pub fn record_tool_call(&self, session_id: &str, update: &Value) {
        let Some(tool_call_id) = update.get("toolCallId").and_then(Value::as_str) else {
            return;
        };
        let name = update
            .get("name")
            .or_else(|| update.get("toolName"))
            .or_else(|| update.get("title"))
            .and_then(Value::as_str);
        let mut state = self.state.lock().unwrap();
        if state.turn.as_ref().is_some_and(|turn| {
            turn.session_id == session_id && name.is_some_and(Self::canvas_tool_name)
        }) {
            state.canvas_tool_calls.insert(tool_call_id.to_string());
        }
    }

    pub fn allows(
        &self,
        session_id: Option<&str>,
        tool_call_id: Option<&str>,
        name: Option<&str>,
    ) -> bool {
        let state = self.state.lock().unwrap();
        let session_matches = state.turn.as_ref().is_some_and(|turn| {
            turn.canvas_id.is_some() && session_id.is_none_or(|session| turn.session_id == session)
        });
        session_matches
            && (name.is_some_and(Self::canvas_tool_name)
                || tool_call_id.is_some_and(|id| state.canvas_tool_calls.contains(id)))
    }

    pub fn complete(
        &self,
        request_id: &str,
        turn_id: &str,
        result: ToolResult,
    ) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if !state.turn.as_ref().is_some_and(|turn| turn.id == turn_id) {
            return Err("Stale canvas turn".into());
        }
        let sender = state
            .pending
            .remove(request_id)
            .ok_or("Unknown canvas request")?;
        sender
            .send(result)
            .map_err(|_| "Canvas request expired".into())
    }

    fn call(&self, token: &str, name: &str, arguments: Value) -> ToolResult {
        if !TOOL_NAMES.contains(&name) {
            return Err("Unknown canvas tool".into());
        }
        let (sender, receiver) = channel();
        let request_id = nonce()?;
        let turn = {
            let mut state = self.state.lock().unwrap();
            if token != state.token {
                return Err("Canvas session expired".into());
            }
            let turn = state
                .turn
                .clone()
                .filter(|turn| turn.canvas_id.is_some())
                .ok_or("No active offline canvas turn")?;
            if state.pending.len() >= 8 {
                return Err("Too many pending canvas tools".into());
            }
            state.pending.insert(request_id.clone(), sender);
            turn
        };
        let result = (self.emit)(json!({
            "requestId": request_id, "turnId": turn.id, "canvasId": turn.canvas_id,
            "name": name, "arguments": arguments,
            "expiresAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64 + 19000
        })).and_then(|_| receiver.recv_timeout(Duration::from_secs(20)).map_err(|_| "Canvas tool timed out".to_string())?);
        self.state.lock().unwrap().pending.remove(&request_id);
        result
    }

    fn dispatch(&self, request: &Value) -> Value {
        let token = request["token"].as_str().unwrap_or("");
        if token != self.state.lock().unwrap().token {
            return json!({"error": "Unauthorized canvas session"});
        }
        let rpc = &request["rpc"];
        let id = rpc.get("id").cloned().unwrap_or(Value::Null);
        let result = match rpc["method"].as_str().unwrap_or("") {
            "initialize" => json!({
                "protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                "serverInfo": {"name": "kan-canvas", "version": env!("CARGO_PKG_VERSION")}
            }),
            "ping" => json!({}),
            "tools/list" => json!({"tools": self.tools}),
            "tools/call" => {
                let result = self.call(
                    token,
                    rpc["params"]["name"].as_str().unwrap_or(""),
                    rpc["params"].get("arguments").cloned().unwrap_or(json!({})),
                );
                match result {
                    Ok(value) => {
                        json!({"content": [{"type": "text", "text": value.to_string()}], "isError": false})
                    }
                    Err(error) => {
                        json!({"content": [{"type": "text", "text": error}], "isError": true})
                    }
                }
            }
            _ => {
                return json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Unsupported MCP method"}})
            }
        };
        json!({"jsonrpc": "2.0", "id": id, "result": result})
    }
}

pub fn serve_stdio() -> Result<(), String> {
    let address: SocketAddr = std::env::var("KAN_CANVAS_BRIDGE_ADDR")
        .map_err(|_| "Missing bridge address")?
        .parse()
        .map_err(|_| "Invalid bridge address")?;
    if !address.ip().is_loopback() {
        return Err("Bridge must be loopback".into());
    }
    let token = std::env::var("KAN_CANVAS_BRIDGE_TOKEN").map_err(|_| "Missing bridge token")?;
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    while let Some(rpc) = read_message(&mut input)? {
        if rpc.get("id").is_none() {
            continue;
        }
        let mut socket = TcpStream::connect_timeout(&address, Duration::from_secs(3))
            .map_err(|_| "Canvas bridge unavailable")?;
        socket
            .set_read_timeout(Some(Duration::from_secs(25)))
            .map_err(|_| "Bridge timeout unavailable")?;
        socket
            .set_write_timeout(Some(Duration::from_secs(3)))
            .map_err(|_| "Bridge timeout unavailable")?;
        write_message(&mut socket, &json!({"token": token, "rpc": rpc}))?;
        let response = read_message(&mut BufReader::new(socket))?.ok_or("Canvas bridge closed")?;
        if response.get("jsonrpc").is_none() {
            return Err("Canvas bridge session expired".into());
        }
        write_message(&mut output, &response)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bridge() -> Arc<CanvasMcp> {
        let tools = TOOL_NAMES
            .iter()
            .map(|name| json!({"name": name, "inputSchema": {"type": "object"}}))
            .collect();
        CanvasMcp::with_emitter(tools, Box::new(|_| Err("test emitter".into()))).unwrap()
    }

    #[test]
    fn discovery_requires_a_session_secret_and_rotation_revokes_it() {
        let bridge = bridge();
        let token = bridge.state.lock().unwrap().token.clone();
        let request = json!({"token": token, "rpc": {"id": 1, "method": "tools/list"}});
        assert_eq!(bridge.dispatch(&request)["result"]["tools"].as_array().unwrap().len(), 8);
        assert!(bridge.dispatch(&json!({"token": "bad", "rpc": {"id": 1, "method": "tools/list"}})).get("error").is_some());
        bridge.rotate_session().unwrap();
        assert!(bridge.dispatch(&request).get("error").is_some());
    }

    #[test]
    fn calls_and_permissions_are_fenced_by_the_active_turn() {
        let bridge = bridge();
        let token = bridge.state.lock().unwrap().token.clone();
        assert!(bridge
            .call(&token, "addNode", json!({}))
            .unwrap_err()
            .contains("No active"));
        bridge
            .begin("turn".into(), Some("canvas".into()), "session".into())
            .unwrap();
        assert!(bridge.allows(Some("session"), None, Some("mcp__kan-canvas__addNode")));
        assert!(!bridge.allows(Some("session"), None, Some("terminal")));
        assert!(!bridge.allows(Some("old-session"), None, Some("mcp__kan-canvas__addNode")));
        assert!(bridge.allows(Some("session"), None, Some("addNode")));
        assert!(bridge.allows(Some("session"), None, Some("focusNodes")));
        bridge.record_tool_call("session", &json!({"sessionUpdate":"tool_call", "toolCallId":"canvas-call", "name":"mcp__kan-canvas__addNode"}));
        assert!(bridge.allows(Some("session"), Some("canvas-call"), None));
        bridge.record_tool_call("session", &json!({"sessionUpdate":"tool_call", "toolCallId":"title-call", "title":"Calling getCanvas from kan-canvas"}));
        assert!(bridge.allows(Some("session"), Some("title-call"), None));
        assert!(!bridge.allows(Some("session"), Some("terminal-call"), None));
        assert!(bridge
            .begin("second".into(), Some("other".into()), "session".into())
            .is_err());
        assert!(bridge.rotate_session().is_err());
        assert!(!bridge.finish("old-turn"));
        assert!(bridge.finish("turn"));
        assert!(!bridge.allows(Some("session"), None, Some("mcp__kan-canvas__addNode")));
        assert!(bridge.complete("unknown", "turn", Ok(json!({}))).is_err());
    }

    #[test]
    fn devin_workspace_has_private_config_and_cleans_it_up() {
        let bridge = bridge();
        let workspace = bridge.workspace(&std::env::temp_dir(), true).unwrap();
        let path = workspace.0.clone();
        let file = path.join(".devin/mcp_config.json");
        let config: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(
            config["mcpServers"]["kan-canvas"]["args"],
            json!(["--canvas-mcp"])
        );
        assert!(
            config["mcpServers"]["kan-canvas"]["env"]["KAN_CANVAS_BRIDGE_TOKEN"]
                .as_str()
                .is_some()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        drop(workspace);
        assert!(!path.exists());
    }

    #[test]
    fn tool_results_round_trip_and_cancelled_calls_cannot_complete() {
        let (send, receive) = channel();
        let tools = TOOL_NAMES
            .iter()
            .map(|name| json!({"name": name, "inputSchema": {"type": "object"}}))
            .collect();
        let bridge = CanvasMcp::with_emitter(
            tools,
            Box::new(move |event| send.send(event).map_err(|error| error.to_string())),
        )
        .unwrap();
        bridge
            .begin("turn".into(), Some("canvas".into()), "session".into())
            .unwrap();
        let token = bridge.state.lock().unwrap().token.clone();
        let request = json!({"token": token, "rpc": {"id": 7, "method": "tools/call", "params": {"name": "getCanvas", "arguments": {}}}});
        let pending = {
            let bridge = bridge.clone();
            let request = request.clone();
            std::thread::spawn(move || bridge.dispatch(&request))
        };
        let event = receive.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(event["canvasId"], "canvas");
        bridge
            .complete(
                event["requestId"].as_str().unwrap(),
                "turn",
                Ok(json!({"nodes": []})),
            )
            .unwrap();
        assert_eq!(pending.join().unwrap()["result"]["isError"], false);
        let pending = {
            let bridge = bridge.clone();
            std::thread::spawn(move || bridge.dispatch(&request))
        };
        let event = receive.recv_timeout(Duration::from_secs(2)).unwrap();
        bridge.finish("turn");
        assert!(bridge
            .complete(event["requestId"].as_str().unwrap(), "turn", Ok(json!({})))
            .is_err());
        assert_eq!(pending.join().unwrap()["result"]["isError"], true);
        assert!(bridge.state.lock().unwrap().pending.is_empty());
    }

    #[test]
    fn malformed_and_oversized_messages_are_rejected() {
        assert!(read_message(&mut std::io::Cursor::new(b"bad\n")).is_err());
        assert!(read_message(&mut std::io::Cursor::new(vec![b'x'; MAX_MESSAGE + 1])).is_err());
        assert!(read_message(&mut std::io::Cursor::new(b"{}\n"))
            .unwrap()
            .is_some());
    }
}
