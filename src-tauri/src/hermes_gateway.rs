//! Client for the local Hermes gateway's JSON-RPC WebSocket.
//!
//! A ticket comes from `hermes -p <profile> gateway attach --json`. It is
//! single-use, profile-scoped, valid for 30 seconds, and never leaves this
//! module: it travels as the `hermes-gateway-ticket.<T>` WebSocket subprotocol
//! and is never logged, returned, or put in an error. Each call opens one
//! loopback connection, waits for `gateway.ready`, sends one fixed method, and
//! closes. The webview chooses only among the fixed commands below and gets a
//! whitelisted projection of each result, never raw gateway payloads.

use crate::hermes::{
    hermes_command, hermes_path, require_profile_name, sanitize_text, valid_session_id,
};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, http::HeaderValue, protocol::WebSocketConfig, Message,
};

const WIRE_PROTOCOL: &str = "hermes-gateway-v1";
const TICKET_PROTOCOL_PREFIX: &str = "hermes-gateway-ticket.";
/// `attach` without `--start` only asks the control socket.
const ATTACH_TIMEOUT: Duration = Duration::from_secs(20);
/// `attach --start` may start the gateway; Hermes's own default deadline is 60s.
const START_TIMEOUT: Duration = Duration::from_secs(90);
const RPC_TIMEOUT: Duration = Duration::from_secs(60);
const ATTACH_OUTPUT_LIMIT: usize = 64 * 1024;
const FRAME_LIMIT: usize = 16 * 1024 * 1024;
/// Bounds for text fields copied into projections.
pub(crate) const FIELD_LIMIT: usize = 2_000;
pub(crate) const BODY_LIMIT: usize = 64 * 1024;
const MODEL_LIST_LIMIT: usize = 400;
const ROW_LIMIT: usize = 500;
const API_KEY_LIMIT: usize = 4096;

/// A minted ticket and the loopback URL it is good for. Deliberately not
/// `Debug` or `Serialize`, so the ticket cannot be printed or returned.
struct Attach {
    url: String,
    ticket: String,
}

/// Gateway reachability for one profile.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    /// Hermes's verdict, e.g. `ready`, `absent`, `starting`, `draining`.
    state: String,
    /// Hermes's bounded explanation when not ready.
    message: Option<String>,
}

pub(crate) fn bounded(text: &str, limit: usize) -> String {
    sanitize_text(text.as_bytes(), limit)
}

/// Accepts only `ws://<loopback>:<port>/api/ws`. The gateway refuses other
/// peers anyway; this keeps a confused CLI from sending the ticket elsewhere.
fn valid_gateway_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("ws://") else {
        return false;
    };
    let Some(authority) = rest.strip_suffix("/api/ws") else {
        return false;
    };
    let port = ["127.0.0.1:", "[::1]:", "localhost:"]
        .iter()
        .find_map(|host| authority.strip_prefix(host));
    matches!(port, Some(p) if !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit()) && p.parse::<u16>().is_ok_and(|n| n > 0))
}

/// Tickets go into an HTTP header; accept only a plain token alphabet.
fn valid_ticket(ticket: &str) -> bool {
    (16..=1024).contains(&ticket.len())
        && ticket
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~'))
}

/// Parses `gateway attach --json`'s one JSON line.
fn parse_attach(line: &str) -> Result<(GatewayStatus, Option<Attach>), String> {
    let value: Value = serde_json::from_str(line.trim())
        .map_err(|_| "Hermes gave an unexpected gateway answer.".to_string())?;
    let state = value
        .get("state")
        .and_then(Value::as_str)
        .filter(|s| s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'))
        .ok_or("Hermes gave an unexpected gateway answer.")?
        .to_owned();
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .map(|m| bounded(m, 400));
    let attach = match (
        value.get("url").and_then(Value::as_str),
        value.get("ticket").and_then(Value::as_str),
    ) {
        (Some(url), Some(ticket)) if valid_gateway_url(url) && valid_ticket(ticket) => {
            Some(Attach {
                url: url.to_owned(),
                ticket: ticket.to_owned(),
            })
        }
        _ => None,
    };
    Ok((GatewayStatus { state, message }, attach))
}

/// Runs `hermes -p <profile> gateway attach --json [--start]`. Reads only the
/// first JSON line and does not wait for stdout EOF, in case a started
/// gateway inherited the pipe.
async fn attach(
    binary: &Path,
    profile: &str,
    start: bool,
) -> Result<(GatewayStatus, Option<Attach>), String> {
    require_profile_name(profile)?;
    let mut command = hermes_command(binary);
    command.args(["-p", profile, "gateway", "attach", "--json"]);
    if start {
        command.arg("--start");
    }
    command.stderr(std::process::Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|_| "Could not run the installed Hermes CLI.".to_string())?;
    let stdout = child.stdout.take().ok_or("Could not read Hermes output.")?;
    let read = async {
        let mut lines = BufReader::new(stdout).lines();
        let mut seen = 0usize;
        while let Ok(Some(line)) = lines.next_line().await {
            seen += line.len();
            if seen > ATTACH_OUTPUT_LIMIT {
                break;
            }
            if line.trim_start().starts_with('{') {
                return parse_attach(&line);
            }
        }
        Err("Hermes gave no gateway answer.".to_string())
    };
    let timeout = if start { START_TIMEOUT } else { ATTACH_TIMEOUT };
    let result = tokio::time::timeout(timeout, read)
        .await
        .map_err(|_| "Hermes did not answer about its gateway in time.".to_string())?;
    // The attach process exits right after printing; give it a moment, then
    // `kill_on_drop` reaps it if it lingers.
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    result
}

async fn attach_ready(binary: &Path, profile: &str) -> Result<Attach, String> {
    let (status, attach) = attach(binary, profile, false).await?;
    attach.ok_or_else(|| {
        if status.state == "absent" {
            "The Hermes gateway for this agent is not running. Start it first.".to_string()
        } else {
            format!(
                "The Hermes gateway is not ready ({}).",
                status.message.unwrap_or(status.state)
            )
        }
    })
}

/// Bounded, user-facing text for a JSON-RPC error object. `redact` is
/// removed before truncation, so no fragment of it can survive the cut.
fn rpc_error(error: &Value, redact: Option<&str>) -> String {
    let mut message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("request refused")
        .chars()
        .take(64 * 1024)
        .collect::<String>();
    if let Some(secret) = redact.filter(|s| !s.is_empty()) {
        message = message.replace(secret, "[key]");
    }
    format!("Hermes refused the request: {}", bounded(&message, 300))
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// One ticketed gateway connection. Calls are made one at a time; events are
/// ignored and server-to-client requests are declined.
struct Connection {
    socket: Socket,
    next_id: u64,
}

impl Connection {
    /// Dials the gateway with the ticket as a subprotocol and waits for
    /// `gateway.ready`. Consumes the ticket: it is single-use.
    async fn open(attach: Attach) -> Result<Self, String> {
        let mut request = attach
            .url
            .as_str()
            .into_client_request()
            .map_err(|_| "The Hermes gateway address is not valid.".to_string())?;
        let protocols = HeaderValue::from_str(&format!(
            "{WIRE_PROTOCOL}, {TICKET_PROTOCOL_PREFIX}{}",
            attach.ticket
        ))
        .map_err(|_| "The Hermes gateway ticket is not valid.".to_string())?;
        drop(attach.ticket);
        request
            .headers_mut()
            .insert("Sec-WebSocket-Protocol", protocols);
        let mut config = WebSocketConfig::default();
        config.max_message_size = Some(FRAME_LIMIT);
        config.max_frame_size = Some(FRAME_LIMIT);
        let (socket, response) =
            tokio_tungstenite::connect_async_with_config(request, Some(config), false)
                .await
                .map_err(|_| "Could not connect to the Hermes gateway.".to_string())?;
        let negotiated = response
            .headers()
            .get("Sec-WebSocket-Protocol")
            .and_then(|v| v.to_str().ok());
        if negotiated != Some(WIRE_PROTOCOL) {
            return Err("The Hermes gateway spoke an unexpected protocol.".to_string());
        }
        let mut connection = Self { socket, next_id: 0 };
        // The server speaks first.
        while connection.next_frame().await?.0 != Frame::Ready {}
        Ok(connection)
    }

    /// Reads one JSON frame and says what it is. Server requests are declined
    /// here; other frame kinds are left to the caller.
    async fn next_frame(&mut self) -> Result<(Frame, Value), String> {
        loop {
            let Some(message) = self.socket.next().await else {
                return Err("The Hermes gateway connection closed.".to_string());
            };
            let text =
                match message.map_err(|_| "The Hermes gateway connection failed.".to_string())? {
                    Message::Text(text) => text,
                    Message::Close(_) => {
                        return Err("The Hermes gateway closed the connection.".to_string())
                    }
                    _ => continue,
                };
            let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) else {
                continue;
            };
            let kind = classify(&frame);
            if let Frame::ServerRequest(id) = &kind {
                let decline = json!({"jsonrpc": "2.0", "id": id,
                    "error": {"code": -32601, "message": "unsupported"}});
                let _ = self.socket.send(Message::text(decline.to_string())).await;
            }
            return Ok((kind, frame));
        }
    }

    /// Sends one fixed method and returns its `result`. Events and replies to
    /// other requests that arrive meanwhile are ignored.
    async fn call(
        &mut self,
        method: &'static str,
        params: Value,
        redact: Option<&str>,
    ) -> Result<Value, String> {
        self.next_id += 1;
        let request =
            json!({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params});
        self.socket
            .send(Message::text(request.to_string()))
            .await
            .map_err(|_| "The Hermes gateway connection closed.".to_string())?;
        loop {
            let (kind, frame) = self.next_frame().await?;
            if kind == Frame::Response(self.next_id) {
                if let Some(error) = frame.get("error") {
                    return Err(rpc_error(error, redact));
                }
                return Ok(frame.get("result").cloned().unwrap_or(Value::Null));
            }
        }
    }

    async fn close(mut self) {
        let _ = self.socket.close(None).await;
    }
}

/// Opens one connection, makes one call, and closes.
async fn rpc_once(
    attach: Attach,
    method: &'static str,
    params: Value,
    redact: Option<&str>,
) -> Result<Value, String> {
    let session = async {
        let mut connection = Connection::open(attach).await?;
        let result = connection.call(method, params, redact).await;
        connection.close().await;
        result
    };
    tokio::time::timeout(RPC_TIMEOUT, session)
        .await
        .map_err(|_| "The Hermes gateway did not answer in time.".to_string())?
}

#[derive(Debug, PartialEq)]
enum Frame {
    Ready,
    ServerRequest(String),
    /// A reply to one of our requests, by id.
    Response(u64),
    Other,
}

fn classify(frame: &Value) -> Frame {
    if frame.get("method").and_then(Value::as_str) == Some("event") {
        if frame.pointer("/params/type").and_then(Value::as_str) == Some("gateway.ready") {
            return Frame::Ready;
        }
        return Frame::Other;
    }
    match frame.get("id") {
        Some(Value::String(id)) if frame.get("method").is_some() && id.starts_with("srq-") => {
            Frame::ServerRequest(id.clone())
        }
        Some(Value::Number(n)) if frame.get("method").is_none() => {
            n.as_u64().map_or(Frame::Other, Frame::Response)
        }
        _ => Frame::Other,
    }
}

// ---- Stopping a running turn ----

/// How many of the newest events are read to learn the running generation.
const INTERRUPT_EVENT_WINDOW: u64 = 12;
const INTERRUPT_TIMEOUT: Duration = Duration::from_secs(20);

/// The execution generation stamped on a session's most recent events.
fn latest_generation(events: &Value) -> Option<u64> {
    rows(events.get("events"))
        .filter_map(|event| event.get("execution_generation").and_then(Value::as_u64))
        .last()
}

/// Interrupts a session's running turn at the gateway. The chat CLI only
/// detaches when signalled, so this is what actually stops the agent.
///
/// The gateway requires the turn's execution generation, which its event
/// stream carries: the first read learns the stream's epoch and latest
/// sequence, the second reads the newest events. Returns whether the gateway
/// accepted an interrupt for the current generation.
async fn interrupt_with(attach: Attach, session_id: &str) -> Result<bool, String> {
    let session = async {
        let mut connection = Connection::open(attach).await?;
        let outcome = async {
            let head = connection
                .call(
                    "session.events.since",
                    json!({"session_id": session_id, "last_sequence": 0}),
                    None,
                )
                .await?;
            let mut generation = latest_generation(&head);
            if generation.is_none() {
                let latest = head.get("latest_seq").and_then(Value::as_u64).unwrap_or(0);
                let Some(epoch) = head.get("replay_epoch").and_then(Value::as_str) else {
                    return Ok(false);
                };
                let tail = connection
                    .call(
                        "session.events.since",
                        json!({
                            "session_id": session_id,
                            "replay_epoch": epoch,
                            "last_sequence": latest.saturating_sub(INTERRUPT_EVENT_WINDOW),
                        }),
                        None,
                    )
                    .await?;
                generation = latest_generation(&tail);
            }
            let Some(generation) = generation else {
                return Ok(false);
            };
            connection
                .call(
                    "session.interrupt",
                    json!({"session_id": session_id, "execution_generation": generation}),
                    None,
                )
                .await
                .map(|_| true)
        }
        .await;
        connection.close().await;
        outcome
    };
    tokio::time::timeout(INTERRUPT_TIMEOUT, session)
        .await
        .map_err(|_| "The Hermes gateway did not answer in time.".to_string())?
}

/// Interrupts `session_id`'s running turn for `profile`. Never starts a gateway.
pub(crate) async fn interrupt_session(profile: &str, session_id: &str) -> Result<bool, String> {
    require_profile_name(profile)?;
    if !valid_session_id(session_id) {
        return Err("That session ID is not valid.".into());
    }
    let binary = hermes_path().ok_or("Hermes is not installed on this machine.")?;
    let attach = attach_ready(&binary, profile).await?;
    interrupt_with(attach, session_id).await
}

async fn call(profile: &str, method: &'static str, params: Value) -> Result<Value, String> {
    call_redacting(profile, method, params, None).await
}

async fn call_redacting(
    profile: &str,
    method: &'static str,
    params: Value,
    redact: Option<&str>,
) -> Result<Value, String> {
    require_profile_name(profile)?;
    let binary = hermes_path().ok_or("Hermes is not installed on this machine.")?;
    let attach = attach_ready(&binary, profile).await?;
    rpc_once(attach, method, params, redact).await
}

/// Copies only `keys` from `object`, keeping scalars (text bounded) and, for
/// keys listed in `maps`, flat maps of numbers. Nested data is dropped.
pub(crate) fn pick(object: &Value, keys: &[&str], text_limit: usize) -> Map<String, Value> {
    let mut out = Map::new();
    for key in keys {
        let value = match object.get(*key) {
            Some(Value::String(s)) => Value::String(bounded(s, text_limit)),
            Some(v @ (Value::Number(_) | Value::Bool(_))) => v.clone(),
            Some(Value::Object(map)) if map.len() <= 32 && map.values().all(|v| v.is_number()) => {
                Value::Object(
                    map.iter()
                        .filter(|(k, _)| k.len() <= 64)
                        .map(|(k, v)| (bounded(k, 64), v.clone()))
                        .collect(),
                )
            }
            _ => continue,
        };
        out.insert((*key).to_owned(), value);
    }
    out
}

pub(crate) fn rows(value: Option<&Value>) -> impl Iterator<Item = &Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(ROW_LIMIT)
}

// ---- Gateway lifecycle ----

/// Reports whether this profile's gateway is attachable. Read-only: never
/// starts a gateway. The minted ticket is discarded.
#[tauri::command]
pub async fn hermes_gateway_status(profile: String) -> Result<GatewayStatus, String> {
    let binary = hermes_path().ok_or("Hermes is not installed on this machine.")?;
    Ok(attach(&binary, &profile, false).await?.0)
}

/// Starts this profile's gateway on the user's request, as Hermes's own
/// clients do (`attach --start`). Its environment is the cleared allowlist.
#[tauri::command]
pub async fn start_hermes_gateway(profile: String) -> Result<GatewayStatus, String> {
    let binary = hermes_path().ok_or("Hermes is not installed on this machine.")?;
    Ok(attach(&binary, &profile, true).await?.0)
}

// ---- Providers and models ----

fn model_ids(models: Option<&Value>) -> Vec<String> {
    rows(models)
        .filter_map(|m| match m {
            Value::String(s) => Some(s.as_str()),
            Value::Object(o) => o
                .get("id")
                .or_else(|| o.get("model"))
                .or_else(|| o.get("name"))
                .and_then(Value::as_str),
            _ => None,
        })
        .filter(|id| !id.is_empty() && id.len() <= 200)
        .take(MODEL_LIST_LIMIT)
        .map(str::to_owned)
        .collect()
}

fn project_model_options(result: &Value) -> Value {
    let providers: Vec<Value> = rows(result.get("providers"))
        .map(|p| {
            let mut row = pick(
                p,
                &[
                    "slug",
                    "name",
                    "authenticated",
                    "auth_type",
                    "is_current",
                    "total_models",
                    "warning",
                ],
                FIELD_LIMIT,
            );
            row.insert("models".into(), json!(model_ids(p.get("models"))));
            // Subscription providers report how much of each limit window is used.
            let windows: Vec<Value> = rows(p.pointer("/usage/windows"))
                .take(8)
                .map(|w| {
                    Value::Object(pick(
                        w,
                        &["label", "used_percent", "resets_at", "scope"],
                        200,
                    ))
                })
                .collect();
            if !windows.is_empty() {
                row.insert("usage".into(), Value::Array(windows));
            }
            Value::Object(row)
        })
        .collect();
    let mut out = pick(result, &["model", "provider"], FIELD_LIMIT);
    out.insert("providers".into(), Value::Array(providers));
    Value::Object(out)
}

/// Lists Hermes's providers and models for a profile, with sign-in state and,
/// for subscription providers, how much of each usage window is spent. With
/// `all`, providers that are not set up yet are included.
#[tauri::command]
pub async fn hermes_model_options(profile: String, all: bool) -> Result<Value, String> {
    let params = if all {
        json!({"include_unconfigured": true})
    } else {
        json!({})
    };
    let result = call(&profile, "model.options", params).await?;
    Ok(project_model_options(&result))
}

fn valid_slug(text: &str, limit: usize) -> bool {
    !text.is_empty()
        && text.len() <= limit
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/' | b':'))
}

/// Sets a profile's default provider and model through Hermes's own validated
/// assignment (`profiles.configure`). Hermes may ask to confirm an expensive
/// model; the webview then repeats the call with `confirm` set.
#[tauri::command]
pub async fn set_hermes_model(
    profile: String,
    provider: String,
    model: String,
    confirm: bool,
) -> Result<Value, String> {
    if !valid_slug(&provider, 100) || !valid_slug(&model, 200) {
        return Err("Choose a provider and model from the list.".into());
    }
    let mut params = json!({"name": profile, "provider": provider, "model": model});
    if confirm {
        params["confirm_expensive_model"] = json!(true);
    }
    let result = call(&profile, "profiles.configure", params).await?;
    Ok(Value::Object(pick(
        &result,
        &["ok", "confirm_required", "confirm_message"],
        FIELD_LIMIT,
    )))
}

/// Gives an API key to Hermes for one provider (`model.save_key`). Hermes
/// stores it; ShellGuardian never logs, stores, or returns it, and strips it
/// from any error text.
#[tauri::command]
pub async fn save_hermes_key(profile: String, provider: String, key: String) -> Result<(), String> {
    let key = key.trim().to_owned();
    if !valid_slug(&provider, 100) {
        return Err("Choose a provider from the list.".into());
    }
    if key.is_empty() || key.len() > API_KEY_LIMIT || key.chars().any(char::is_control) {
        return Err("Paste the API key as a single line.".into());
    }
    call_redacting(
        &profile,
        "model.save_key",
        json!({"slug": provider, "api_key": key}),
        Some(&key),
    )
    .await
    .map(|_| ())
}

// ---- Transcripts and schedules ----

/// Reads the latest messages of one stored session. Read-only: it does not
/// attach to or resume the session. Text may contain sensitive tool output;
/// it is displayed, never logged or persisted.
#[tauri::command]
pub async fn hermes_transcript(profile: String, session_id: String) -> Result<Vec<Value>, String> {
    if !valid_session_id(&session_id) {
        return Err("That session ID is not valid.".into());
    }
    let result = call(
        &profile,
        "session.transcript",
        json!({"session_id": session_id, "limit": 200, "order": "latest"}),
    )
    .await?;
    Ok(rows(result.get("rows"))
        .map(|r| {
            Value::Object(pick(
                r,
                &["role", "text", "timestamp", "row_kind", "name"],
                BODY_LIMIT,
            ))
        })
        .collect())
}

/// Lists a profile's scheduled (cron) jobs. Read-only.
#[tauri::command]
pub async fn hermes_schedules(profile: String) -> Result<Vec<Value>, String> {
    let result = call(
        &profile,
        "cron.manage",
        json!({"action": "list", "include_disabled": true}),
    )
    .await?;
    Ok(rows(result.get("jobs"))
        .map(|j| {
            Value::Object(pick(
                j,
                &[
                    "job_id",
                    "name",
                    "schedule",
                    "enabled",
                    "paused",
                    "next_run_at",
                    "last_run_at",
                    "last_status",
                    "last_error",
                    "model",
                    "provider",
                ],
                FIELD_LIMIT,
            ))
        })
        .collect())
}

// ---- Supervisor preparation ----

/// The ShellGuardian-owned playbook skill installed into the supervisor profile.
const SUPERVISOR_SKILL: &str = include_str!("../resources/shellguardian-supervisor.SKILL.md");
const SUPERVISOR_SKILL_DIR: &str = "shellguardian-supervisor";
const SKILL_MARKER: &str = "managed-by: shellguardian";

/// Toolset names currently enabled for a profile, from `profiles.describe`.
fn enabled_toolsets(describe: &Value) -> Vec<String> {
    rows(describe.get("toolsets"))
        .filter(|t| t.get("enabled").and_then(Value::as_bool) == Some(true))
        .filter_map(|t| t.get("name").and_then(Value::as_str))
        .filter(|name| valid_slug(name, 64))
        .map(str::to_owned)
        .collect()
}

/// Reads the profile directory from `hermes profile show`. Accepts only an
/// absolute directory inside the user's home.
async fn profile_dir(binary: &Path, profile: &str) -> Result<std::path::PathBuf, String> {
    require_profile_name(profile)?;
    let child = hermes_command(binary)
        .args(["profile", "show", profile])
        .output();
    let output = tokio::time::timeout(ATTACH_TIMEOUT, child)
        .await
        .map_err(|_| "The Hermes CLI did not respond in time.".to_string())?
        .map_err(|_| "Could not run the installed Hermes CLI.".to_string())?;
    let text = sanitize_text(&output.stdout, 8192);
    let path = text
        .lines()
        .find_map(|line| line.trim().strip_prefix("Path:"))
        .map(|p| std::path::PathBuf::from(p.trim()))
        .ok_or("Hermes did not report where this agent's profile lives.")?;
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let inside_home = home.is_some_and(|home| path.starts_with(home));
    if !path.is_absolute() || !inside_home || !path.is_dir() {
        return Err("Hermes reported an unexpected profile location.".into());
    }
    Ok(path)
}

/// Writes the playbook skill. Refuses to replace a file ShellGuardian does not
/// own, and never touches `SOUL.md` or other skills.
fn install_supervisor_skill(profile_dir: &Path) -> Result<bool, String> {
    let dir = profile_dir.join("skills").join(SUPERVISOR_SKILL_DIR);
    let file = dir.join("SKILL.md");
    if let Ok(existing) = std::fs::read_to_string(&file) {
        if !existing.contains(SKILL_MARKER) {
            return Err(
                "A different skill named shellguardian-supervisor already exists; it was left alone."
                    .into(),
            );
        }
        if existing == SUPERVISOR_SKILL {
            return Ok(false);
        }
    } else if file.exists() {
        return Err("The existing supervisor skill could not be read; it was left alone.".into());
    }
    std::fs::create_dir_all(&dir)
        .and_then(|()| std::fs::write(&file, SUPERVISOR_SKILL))
        .map_err(|_| "Could not install the supervisor skill.".to_string())?;
    Ok(true)
}

/// What `prepare_hermes_supervisor` changed.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorPreparation {
    kanban_enabled: bool,
    skill_installed: bool,
}

/// Prepares a profile to supervise, on the user's request: enables the
/// `kanban` toolset (keeping every toolset already enabled) and installs the
/// ShellGuardian playbook skill. Nothing else in the profile is changed.
#[tauri::command]
pub async fn prepare_hermes_supervisor(profile: String) -> Result<SupervisorPreparation, String> {
    let binary = hermes_path().ok_or("Hermes is not installed on this machine.")?;
    let describe = call(&profile, "profiles.describe", json!({"name": profile})).await?;
    let mut toolsets = enabled_toolsets(&describe);
    let kanban_enabled = if toolsets.iter().any(|t| t == "kanban") {
        false
    } else {
        if toolsets.is_empty() {
            return Err("Hermes reported no enabled toolsets, so nothing was changed.".into());
        }
        toolsets.push("kanban".into());
        let result = call(
            &profile,
            "profiles.configure",
            json!({"name": profile, "enabled_toolsets": toolsets}),
        )
        .await?;
        if result.pointer("/applied/toolsets").and_then(Value::as_bool) != Some(true) {
            return Err("Hermes did not apply the kanban toolset.".into());
        }
        true
    };
    let dir = profile_dir(&binary, &profile).await?;
    let skill_installed = install_supervisor_skill(&dir)?;
    Ok(SupervisorPreparation {
        kanban_enabled,
        skill_installed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

    #[test]
    fn gateway_urls_must_be_loopback_api_ws() {
        for good in [
            "ws://127.0.0.1:8765/api/ws",
            "ws://[::1]:1/api/ws",
            "ws://localhost:65535/api/ws",
        ] {
            assert!(valid_gateway_url(good), "{good}");
        }
        for bad in [
            "wss://127.0.0.1:8765/api/ws",
            "ws://127.0.0.1.evil.com:80/api/ws",
            "ws://10.0.0.1:8765/api/ws",
            "ws://127.0.0.1:8765/other",
            "ws://127.0.0.1:0/api/ws",
            "ws://127.0.0.1:99999/api/ws",
            "ws://127.0.0.1:/api/ws",
            "ws://user@127.0.0.1:80/api/ws",
        ] {
            assert!(!valid_gateway_url(bad), "{bad}");
        }
    }

    #[test]
    fn attach_parsing_keeps_ticket_private_and_validated() {
        let ticket = "abcDEF0123456789_-xyz";
        let line = format!(
            r#"{{"state":"ready","url":"ws://127.0.0.1:9/api/ws","ticket":"{ticket}","protocols":["hermes-gateway-v1","hermes-gateway-ticket.{ticket}"]}}"#
        );
        let (status, attach) = parse_attach(&line).unwrap();
        assert_eq!(
            status,
            GatewayStatus {
                state: "ready".into(),
                message: None
            }
        );
        let attach = attach.unwrap();
        assert_eq!(attach.ticket, ticket);
        // The serialized status never contains the ticket.
        assert!(!serde_json::to_string(&status).unwrap().contains(ticket));

        let absent = r#"{"state":"absent","message":"gateway absent: not ready","endpoint":null}"#;
        let (status, attach) = parse_attach(absent).unwrap();
        assert_eq!(status.state, "absent");
        assert!(attach.is_none());

        let bad_url = r#"{"state":"ready","url":"ws://evil.example:80/api/ws","ticket":"abcdefghijklmnopqrstu"}"#;
        assert!(parse_attach(bad_url).unwrap().1.is_none());
        let bad_ticket =
            r#"{"state":"ready","url":"ws://127.0.0.1:9/api/ws","ticket":"short\r\nX: y"}"#;
        assert!(parse_attach(bad_ticket).unwrap().1.is_none());
        assert!(parse_attach("not json").is_err());
        assert!(parse_attach(r#"{"state":"weird state!"}"#).is_err());
    }

    #[test]
    fn frames_are_classified_by_shape() {
        assert_eq!(
            classify(
                &json!({"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready","payload":{}}})
            ),
            Frame::Ready
        );
        assert_eq!(
            classify(&json!({"jsonrpc":"2.0","id":"srq-1a","method":"sudo","params":{}})),
            Frame::ServerRequest("srq-1a".into())
        );
        assert_eq!(
            classify(&json!({"jsonrpc":"2.0","id":1,"result":{}})),
            Frame::Response(1)
        );
        assert_eq!(
            classify(&json!({"jsonrpc":"2.0","id":2,"error":{}})),
            Frame::Response(2)
        );
        assert_eq!(
            classify(&json!({"jsonrpc":"2.0","id":"x","result":{}})),
            Frame::Other
        );
        assert_eq!(
            classify(&json!({"jsonrpc":"2.0","method":"event","params":{"type":"message.delta"}})),
            Frame::Other
        );
    }

    #[test]
    fn projections_drop_unlisted_and_nested_fields() {
        let row = json!({
            "slug": "openai-codex", "name": "OpenAI Codex", "authenticated": true,
            "key_env": "OPENAI_API_KEY", "api_url": "https://x", "pricing": {"in": 1},
            "models": ["gpt-a", {"id": "gpt-b"}, {"name": "gpt-c"}, 7],
        });
        let out =
            project_model_options(&json!({"providers": [row], "model": "gpt-a", "secret": "s"}));
        let provider = &out["providers"][0];
        assert_eq!(provider["slug"], "openai-codex");
        assert_eq!(provider["models"], json!(["gpt-a", "gpt-b", "gpt-c"]));
        assert!(provider.get("key_env").is_none());
        assert!(provider.get("api_url").is_none());
        assert!(provider.get("pricing").is_none());
        assert!(out.get("secret").is_none());
        let counts = pick(
            &json!({"counts": {"todo": 2, "done": 1}, "nested": {"a": "b"}}),
            &["counts", "nested"],
            10,
        );
        assert_eq!(counts["counts"], json!({"todo": 2, "done": 1}));
        assert!(!counts.contains_key("nested"));
        let long = pick(&json!({"t": "x".repeat(50)}), &["t"], 10);
        assert_eq!(long["t"].as_str().unwrap().len(), 10);
    }

    #[test]
    fn slugs_are_plain_tokens() {
        assert!(valid_slug("openai-codex", 100));
        assert!(valid_slug("anthropic/claude-fable-5.2", 100));
        assert!(!valid_slug("x --provider y", 100));
        assert!(!valid_slug("", 100));
        assert!(!valid_slug(&"a".repeat(101), 100));
    }

    #[test]
    fn toolsets_round_trip_keeps_only_enabled_valid_names() {
        let describe = json!({"toolsets": [
            {"name": "terminal", "enabled": true},
            {"name": "web", "enabled": false},
            {"name": "bad name", "enabled": true},
            {"name": "memory", "enabled": true},
        ]});
        assert_eq!(enabled_toolsets(&describe), vec!["terminal", "memory"]);
        assert!(enabled_toolsets(&json!({})).is_empty());
    }

    #[test]
    fn supervisor_skill_never_replaces_a_foreign_skill() {
        let home = tempfile::tempdir().unwrap();
        assert!(SUPERVISOR_SKILL.contains(SKILL_MARKER));
        assert!(SUPERVISOR_SKILL.starts_with("---\nname: shellguardian-supervisor\n"));
        assert_eq!(install_supervisor_skill(home.path()), Ok(true));
        let file = home.path().join("skills/shellguardian-supervisor/SKILL.md");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), SUPERVISOR_SKILL);
        // Unchanged: nothing to do. Older managed copy: updated.
        assert_eq!(install_supervisor_skill(home.path()), Ok(false));
        std::fs::write(&file, "old <!-- managed-by: shellguardian -->").unwrap();
        assert_eq!(install_supervisor_skill(home.path()), Ok(true));
        // A user's own skill of the same name is left alone.
        std::fs::write(&file, "my own skill").unwrap();
        assert!(install_supervisor_skill(home.path()).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "my own skill");
        assert!(!home.path().join("SOUL.md").exists());
    }

    #[allow(clippy::result_large_err)]
    /// A fake gateway on loopback: checks the subprotocol carries the ticket,
    /// speaks first, interleaves an event and a server request, then answers.
    async fn fake_gateway(
        answer: Value,
    ) -> (String, tokio::task::JoinHandle<(String, Vec<Value>)>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/api/ws", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut offered = String::new();
            let mut socket =
                tokio_tungstenite::accept_hdr_async(stream, |req: &Request, mut res: Response| {
                    offered = req
                        .headers()
                        .get("Sec-WebSocket-Protocol")
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .to_owned();
                    assert!(req.headers().get("Origin").is_none());
                    res.headers_mut().insert(
                        "Sec-WebSocket-Protocol",
                        HeaderValue::from_static(WIRE_PROTOCOL),
                    );
                    Ok(res)
                })
                .await
                .unwrap();
            socket.send(Message::text(json!({"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready","payload":{}}}).to_string())).await.unwrap();
            let mut seen = Vec::new();
            let request: Value = loop {
                if let Some(Ok(Message::Text(t))) = socket.next().await {
                    break serde_json::from_str(t.as_str()).unwrap();
                }
            };
            seen.push(request.clone());
            socket
                .send(Message::text(
                    json!({"jsonrpc":"2.0","method":"event","params":{"type":"sessions.changed"}})
                        .to_string(),
                ))
                .await
                .unwrap();
            socket
                .send(Message::text(
                    json!({"jsonrpc":"2.0","id":"srq-9","method":"secret","params":{}}).to_string(),
                ))
                .await
                .unwrap();
            let decline: Value = loop {
                if let Some(Ok(Message::Text(t))) = socket.next().await {
                    break serde_json::from_str(t.as_str()).unwrap();
                }
            };
            seen.push(decline);
            let mut reply = answer;
            reply["jsonrpc"] = json!("2.0");
            reply["id"] = request["id"].clone();
            socket.send(Message::text(reply.to_string())).await.unwrap();
            let _ = socket.next().await;
            (offered, seen)
        });
        (url, handle)
    }

    #[tokio::test]
    async fn rpc_round_trip_uses_ticket_subprotocol_and_declines_server_requests() {
        let (url, server) =
            fake_gateway(json!({"result": {"sessions": [{"session_id": "s1"}]}})).await;
        let attach = Attach {
            url,
            ticket: "TICKET0123456789abcd".into(),
        };
        let result = rpc_once(attach, "session.list", json!({"limit": 1}), None)
            .await
            .unwrap();
        assert_eq!(result["sessions"][0]["session_id"], "s1");
        let (offered, seen) = server.await.unwrap();
        assert_eq!(
            offered,
            "hermes-gateway-v1, hermes-gateway-ticket.TICKET0123456789abcd"
        );
        assert_eq!(seen[0]["method"], "session.list");
        assert_eq!(seen[0]["id"], 1);
        assert_eq!(seen[0]["params"], json!({"limit": 1}));
        assert_eq!(seen[1]["id"], "srq-9");
        assert_eq!(seen[1]["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn rpc_errors_are_bounded_and_keys_are_scrubbed() {
        let key = "sk-test-ABCDEFGHIJKLMNOP";
        // The key straddles the truncation point; no fragment may survive.
        let message = format!("{} {key} tail", "z".repeat(290));
        let (url, server) =
            fake_gateway(json!({"error": {"code": 4002, "message": message}})).await;
        let attach = Attach {
            url,
            ticket: "TICKET0123456789abcd".into(),
        };
        let error = rpc_once(attach, "model.save_key", json!({}), Some(key))
            .await
            .unwrap_err();
        assert!(error.starts_with("Hermes refused the request: zzz"));
        assert!(!error.contains("sk-test"));
        assert!(error.len() < 400);
        server.await.unwrap();
    }

    /// A fake gateway that answers a fixed list of requests in order and
    /// returns the requests it received.
    async fn scripted_gateway(
        replies: Vec<Value>,
    ) -> (String, tokio::task::JoinHandle<Vec<Value>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/api/ws", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            #[allow(clippy::result_large_err)]
            let mut socket =
                tokio_tungstenite::accept_hdr_async(stream, |_: &Request, mut res: Response| {
                    res.headers_mut().insert(
                        "Sec-WebSocket-Protocol",
                        HeaderValue::from_static(WIRE_PROTOCOL),
                    );
                    Ok(res)
                })
                .await
                .unwrap();
            let ready = json!({"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready","payload":{}}});
            socket.send(Message::text(ready.to_string())).await.unwrap();
            let mut seen = Vec::new();
            for mut reply in replies {
                let request: Value = loop {
                    match socket.next().await {
                        Some(Ok(Message::Text(text))) => {
                            break serde_json::from_str(text.as_str()).unwrap()
                        }
                        Some(Ok(_)) => continue,
                        _ => return seen,
                    }
                };
                reply["jsonrpc"] = json!("2.0");
                reply["id"] = request["id"].clone();
                seen.push(request);
                // An unrelated event between request and reply must be ignored.
                let noise =
                    json!({"jsonrpc":"2.0","method":"event","params":{"type":"sessions.changed"}});
                socket.send(Message::text(noise.to_string())).await.unwrap();
                socket.send(Message::text(reply.to_string())).await.unwrap();
            }
            let _ = socket.next().await;
            seen
        });
        (url, handle)
    }

    fn ticket(url: String) -> Attach {
        Attach {
            url,
            ticket: "TICKET0123456789abcd".into(),
        }
    }

    #[tokio::test]
    async fn interrupt_reads_the_running_generation_then_stops_that_turn() {
        // The first read has no epoch, so the gateway returns only the stream's
        // position; the second reads the newest events.
        let (url, server) = scripted_gateway(vec![
            json!({"result": {"events": [], "replay_epoch": "e1", "latest_seq": 40, "snapshot_required": true}}),
            json!({"result": {"events": [
                {"seq": 39, "type": "message.delta", "execution_generation": 6},
                {"seq": 40, "type": "tool.start", "execution_generation": 7},
            ]}}),
            json!({"result": {"execution_state": "idle", "execution_generation": 7}}),
        ])
        .await;
        assert_eq!(interrupt_with(ticket(url), "local-abc").await, Ok(true));
        let seen = server.await.unwrap();
        assert_eq!(seen.len(), 3);
        assert_eq!(seen[0]["method"], "session.events.since");
        assert_eq!(
            seen[0]["params"],
            json!({"session_id": "local-abc", "last_sequence": 0})
        );
        assert_eq!(
            seen[1]["params"],
            json!({"session_id": "local-abc", "replay_epoch": "e1", "last_sequence": 28})
        );
        assert_eq!(seen[2]["method"], "session.interrupt");
        assert_eq!(
            seen[2]["params"],
            json!({"session_id": "local-abc", "execution_generation": 7})
        );
        assert_eq!(
            [&seen[0]["id"], &seen[1]["id"], &seen[2]["id"]],
            [&json!(1), &json!(2), &json!(3)]
        );
    }

    #[tokio::test]
    async fn interrupt_is_not_confirmed_without_a_generation_or_when_refused() {
        // Nothing says which turn is running: no interrupt is sent, and it is not confirmed.
        let (url, server) = scripted_gateway(vec![
            json!({"result": {"events": [], "replay_epoch": "e1", "latest_seq": 0}}),
            json!({"result": {"events": []}}),
        ])
        .await;
        assert_eq!(interrupt_with(ticket(url), "local-abc").await, Ok(false));
        let seen = server.await.unwrap();
        assert!(seen.iter().all(|r| r["method"] == "session.events.since"));

        // The first read can already carry events; the gateway may still refuse.
        let (url, server) = scripted_gateway(vec![
            json!({"result": {"events": [{"seq": 2, "execution_generation": 3}]}}),
            json!({"error": {"code": 4001, "message": "stale_generation"}}),
        ])
        .await;
        let refused = interrupt_with(ticket(url), "local-abc").await;
        assert_eq!(
            refused,
            Err("Hermes refused the request: stale_generation".to_string())
        );
        let seen = server.await.unwrap();
        assert_eq!(seen[1]["params"]["execution_generation"], 3);
    }

    /// Short description of a projected value for live-test output: keys with
    /// types and truncated scalars. `redact` prints lengths instead of text.
    fn shape(value: &Value, redact: bool) -> String {
        match value {
            Value::Object(map) => {
                let fields: Vec<String> = map
                    .iter()
                    .map(|(k, v)| format!("{k}: {}", shape(v, redact)))
                    .collect();
                format!("{{{}}}", fields.join(", "))
            }
            Value::Array(items) => match items.first() {
                Some(first) => format!("[{} x {}]", items.len(), shape(first, redact)),
                None => "[]".into(),
            },
            Value::String(s) if redact => format!("<text {}>", s.len()),
            Value::String(s) => format!("{:?}", s.chars().take(60).collect::<String>()),
            other => other.to_string(),
        }
    }

    /// Read-only pass over a real, already-running gateway. Never starts a
    /// gateway, changes configuration, or runs inference. Run with:
    /// `SHELLGUARDIAN_TEST_HERMES_GATEWAY=<profile> cargo test -p shellguardian
    /// live_gateway -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "requires SHELLGUARDIAN_TEST_HERMES_GATEWAY and a running gateway"]
    async fn live_gateway_read_only_surface() {
        let profile = std::env::var("SHELLGUARDIAN_TEST_HERMES_GATEWAY")
            .expect("set SHELLGUARDIAN_TEST_HERMES_GATEWAY to a profile name");
        let status = hermes_gateway_status(profile.clone()).await.unwrap();
        println!("status: {status:?}");
        assert_eq!(status.state, "ready", "start the gateway first");

        for all in [false, true] {
            let options = hermes_model_options(profile.clone(), all).await.unwrap();
            let providers = options["providers"].as_array().cloned().unwrap_or_default();
            println!(
                "model.options(all={all}): model={} provider={} providers={}",
                options["model"],
                options["provider"],
                providers.len()
            );
            for provider in providers
                .iter()
                .filter(|p| !all || p["authenticated"] == true)
            {
                let mut row = provider.clone();
                let models = row["models"].as_array().cloned().unwrap_or_default();
                row["models"] = json!(format!(
                    "{} models, first {:?}",
                    models.len(),
                    models.first()
                ));
                println!("  {}", shape(&row, false));
            }
            if all {
                let kinds: std::collections::BTreeSet<String> = providers
                    .iter()
                    .filter(|p| p["authenticated"] != true)
                    .map(|p| p["auth_type"].as_str().unwrap_or("none").to_owned())
                    .collect();
                println!("  not set up: auth types {kinds:?}");
            }
            assert!(!providers.is_empty());
        }

        let describe = call(&profile, "profiles.describe", json!({"name": profile}))
            .await
            .unwrap();
        println!("enabled toolsets: {:?}", enabled_toolsets(&describe));

        let sessions = crate::hermes_sessions::hermes_sessions(profile.clone())
            .await
            .unwrap();
        println!("sessions list: {} sessions", sessions.len());
        for session in sessions.iter().take(6) {
            println!("  {}", serde_json::to_string(session).unwrap());
        }
        if let Some(first) = sessions.first() {
            let id = serde_json::to_value(first).unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            let rows = hermes_transcript(profile.clone(), id.clone())
                .await
                .unwrap();
            println!("session.transcript({id}): {} rows", rows.len());
            for row in rows.iter().take(6) {
                println!("  {}", shape(row, true));
            }
        }

        let schedules = hermes_schedules(profile.clone()).await.unwrap();
        println!("cron.manage list: {} jobs", schedules.len());
        for job in schedules.iter().take(3) {
            println!("  {}", shape(job, false));
        }

        // Optional: `SHELLGUARDIAN_TEST_WORKER_SESSION=<profile>/<session id>`
        // checks that a kanban worker's transcript is readable.
        if let Ok(target) = std::env::var("SHELLGUARDIAN_TEST_WORKER_SESSION") {
            let (assignee, session) = target.split_once('/').expect("use <profile>/<session>");
            let rows = hermes_transcript(assignee.to_owned(), session.to_owned())
                .await
                .unwrap();
            println!(
                "worker transcript: {:?}",
                rows.iter().map(|row| shape(row, true)).collect::<Vec<_>>()
            );
            assert!(!rows.is_empty());
        }
    }
}
