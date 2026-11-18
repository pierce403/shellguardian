//! Client for the local Hermes gateway's JSON-RPC WebSocket, plus Hermes's
//! kanban CLI.
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
const FIELD_LIMIT: usize = 2_000;
const BODY_LIMIT: usize = 64 * 1024;
const MODEL_LIST_LIMIT: usize = 400;
const ROW_LIMIT: usize = 500;
const KANBAN_TITLE_LIMIT: usize = 300;
const KANBAN_BODY_LIMIT: usize = 16 * 1024;
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

fn bounded(text: &str, limit: usize) -> String {
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

/// Opens one connection, waits for `gateway.ready`, sends `method`, and
/// returns its `result`. Server-to-client requests are declined, events are
/// ignored, and frames arrive in any order.
async fn rpc_once(
    attach: Attach,
    method: &'static str,
    params: Value,
    redact: Option<&str>,
) -> Result<Value, String> {
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
    let session = async {
        let (mut socket, response) =
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
        let mut ready = false;
        let mut sent = false;
        loop {
            if ready && !sent {
                let frame = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
                socket
                    .send(Message::text(frame.to_string()))
                    .await
                    .map_err(|_| "The Hermes gateway connection closed.".to_string())?;
                sent = true;
            }
            let Some(message) = socket.next().await else {
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
            match classify(&frame) {
                Frame::Ready => ready = true,
                Frame::ServerRequest(id) => {
                    let decline = json!({"jsonrpc": "2.0", "id": id,
                        "error": {"code": -32601, "message": "unsupported"}});
                    let _ = socket.send(Message::text(decline.to_string())).await;
                }
                Frame::Response if sent => {
                    let _ = socket.close(None).await;
                    if let Some(error) = frame.get("error") {
                        return Err(rpc_error(error, redact));
                    }
                    return Ok(frame.get("result").cloned().unwrap_or(Value::Null));
                }
                _ => {}
            }
        }
    };
    tokio::time::timeout(RPC_TIMEOUT, session)
        .await
        .map_err(|_| "The Hermes gateway did not answer in time.".to_string())?
}

#[derive(Debug, PartialEq)]
enum Frame {
    Ready,
    ServerRequest(String),
    /// The reply to our single request (id 1).
    Response,
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
        Some(Value::Number(n)) if n.as_u64() == Some(1) && frame.get("method").is_none() => {
            Frame::Response
        }
        _ => Frame::Other,
    }
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
fn pick(object: &Value, keys: &[&str], text_limit: usize) -> Map<String, Value> {
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

fn rows(value: Option<&Value>) -> impl Iterator<Item = &Value> {
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
            Value::Object(row)
        })
        .collect();
    let mut out = pick(result, &["model", "provider"], FIELD_LIMIT);
    out.insert("providers".into(), Value::Array(providers));
    Value::Object(out)
}

/// Lists Hermes's providers and models for a profile, with sign-in state.
#[tauri::command]
pub async fn hermes_model_options(profile: String) -> Result<Value, String> {
    let result = call(&profile, "model.options", json!({})).await?;
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

// ---- Sessions and schedules ----

const SESSION_KEYS: &[&str] = &[
    "session_id",
    "title",
    "source",
    "started_at",
    "last_active_at",
    "message_count",
    "running",
    "model",
    "preview",
];

/// Lists a profile's stored Hermes sessions, newest first.
#[tauri::command]
pub async fn hermes_sessions(profile: String) -> Result<Vec<Value>, String> {
    let result = call(
        &profile,
        "session.list",
        json!({"limit": 100, "scope": "stored"}),
    )
    .await?;
    Ok(rows(result.get("sessions"))
        .map(|s| Value::Object(pick(s, SESSION_KEYS, FIELD_LIMIT)))
        .collect())
}

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

// ---- Kanban (CLI; works without a gateway) ----

fn valid_board(slug: &str) -> bool {
    slug.bytes()
        .next()
        .is_some_and(|b| b.is_ascii_alphanumeric())
        && slug.len() <= 64
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_'))
}

/// A leading alphanumeric keeps an ID from ever reading as a flag.
fn valid_task_id(id: &str) -> bool {
    id.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// `hermes kanban [--board <slug>] <args...>` with the shared command rules.
fn kanban_args(board: Option<&str>, args: &[&str]) -> Result<Vec<String>, String> {
    let mut out = vec!["kanban".to_owned()];
    if let Some(board) = board {
        if !valid_board(board) {
            return Err("That board name is not valid.".into());
        }
        out.push(format!("--board={board}"));
    }
    out.extend(args.iter().map(|a| (*a).to_owned()));
    Ok(out)
}

async fn kanban(board: Option<&str>, args: &[&str]) -> Result<String, String> {
    let binary = hermes_path().ok_or("Hermes is not installed on this machine.")?;
    let args = kanban_args(board, args)?;
    let child = hermes_command(&binary).args(&args).output();
    let output = tokio::time::timeout(Duration::from_secs(30), child)
        .await
        .map_err(|_| "The Hermes kanban did not respond in time.".to_string())?
        .map_err(|_| "Could not run the installed Hermes CLI.".to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.status.success() {
        let stderr = sanitize_text(&output.stderr, 8192);
        let detail = stderr
            .lines()
            .rev()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("the command failed");
        return Err(format!("Hermes kanban: {}", bounded(detail, 300)));
    }
    Ok(stdout)
}

fn parse_json(stdout: &str) -> Result<Value, String> {
    let start = stdout
        .find(['[', '{'])
        .ok_or("Hermes kanban gave no data.")?;
    serde_json::from_str(&stdout[start..]).map_err(|_| "Hermes kanban gave unexpected data.".into())
}

const TASK_KEYS: &[&str] = &[
    "id",
    "title",
    "assignee",
    "status",
    "priority",
    "tenant",
    "created_at",
    "started_at",
    "completed_at",
];

/// Lists kanban boards with task counts.
#[tauri::command]
pub async fn hermes_kanban_boards() -> Result<Vec<Value>, String> {
    let value = parse_json(&kanban(None, &["boards", "list", "--json"]).await?)?;
    Ok(rows(Some(&value))
        .map(|b| {
            Value::Object(pick(
                b,
                &[
                    "slug",
                    "name",
                    "description",
                    "is_current",
                    "archived",
                    "counts",
                    "total",
                ],
                FIELD_LIMIT,
            ))
        })
        .collect())
}

/// Lists a board's tasks.
#[tauri::command]
pub async fn hermes_kanban_tasks(board: String) -> Result<Vec<Value>, String> {
    let value = parse_json(&kanban(Some(&board), &["list", "--json"]).await?)?;
    Ok(rows(Some(&value))
        .map(|t| Value::Object(pick(t, TASK_KEYS, FIELD_LIMIT)))
        .collect())
}

/// One task with its body, result, and comments.
#[tauri::command]
pub async fn hermes_kanban_task(board: String, id: String) -> Result<Value, String> {
    if !valid_task_id(&id) {
        return Err("That task ID is not valid.".into());
    }
    let value = parse_json(&kanban(Some(&board), &["show", &id, "--json"]).await?)?;
    let task = value.get("task").unwrap_or(&value);
    let mut out = pick(task, TASK_KEYS, FIELD_LIMIT);
    out.extend(pick(task, &["body", "result"], BODY_LIMIT));
    out.extend(pick(&value, &["latest_summary"], BODY_LIMIT));
    out.insert(
        "comments".into(),
        Value::Array(
            rows(value.get("comments"))
                .map(|c| Value::Object(pick(c, &["author", "body", "created_at"], BODY_LIMIT)))
                .collect(),
        ),
    );
    Ok(Value::Object(out))
}

fn require_text(text: &str, limit: usize, what: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err(format!("Enter a {what}."));
    }
    if text.len() > limit || text.contains('\0') {
        return Err(format!("That {what} is too long."));
    }
    Ok(())
}

/// Creates a task. Text goes in `--opt=value` form or after `--`, so it can
/// never be parsed as a flag. An assigned task runs when the gateway runs.
#[tauri::command]
pub async fn create_hermes_kanban_task(
    board: String,
    title: String,
    body: String,
    assignee: Option<String>,
) -> Result<Value, String> {
    let title = title.trim();
    require_text(title, KANBAN_TITLE_LIMIT, "task title")?;
    if title.contains('\n') {
        return Err("Keep the task title on one line.".into());
    }
    if body.len() > KANBAN_BODY_LIMIT || body.contains('\0') {
        return Err("That description is too long.".into());
    }
    let mut args = vec![
        "create".to_owned(),
        "--json".to_owned(),
        "--created-by=shellguardian".to_owned(),
    ];
    if !body.trim().is_empty() {
        args.push(format!("--body={}", body.trim()));
    }
    if let Some(assignee) = assignee.filter(|a| !a.is_empty()) {
        require_profile_name(&assignee)?;
        args.push(format!("--assignee={assignee}"));
    }
    args.push("--".to_owned());
    args.push(title.to_owned());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let value = parse_json(&kanban(Some(&board), &refs).await?)?;
    let task = value.get("task").unwrap_or(&value);
    Ok(Value::Object(pick(task, TASK_KEYS, FIELD_LIMIT)))
}

/// Adds a comment to a task as `you`.
#[tauri::command]
pub async fn comment_hermes_kanban_task(
    board: String,
    id: String,
    text: String,
) -> Result<(), String> {
    if !valid_task_id(&id) {
        return Err("That task ID is not valid.".into());
    }
    let text = text.trim();
    require_text(text, KANBAN_BODY_LIMIT, "comment")?;
    kanban(Some(&board), &["comment", "--author=you", "--", &id, text])
        .await
        .map(|_| ())
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
            Frame::Response
        );
        assert_eq!(
            classify(&json!({"jsonrpc":"2.0","id":2,"result":{}})),
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
    fn kanban_arguments_never_become_flags() {
        assert_eq!(
            kanban_args(Some("default"), &["list", "--json"]).unwrap(),
            vec!["kanban", "--board=default", "list", "--json"]
        );
        assert!(kanban_args(Some("--evil"), &[]).is_err());
        assert!(kanban_args(Some("Bad Board"), &[]).is_err());
        assert!(valid_task_id("t_12ab"));
        assert!(!valid_task_id("--json"));
        assert!(!valid_task_id("a/b"));
        assert!(valid_slug("openai-codex", 100));
        assert!(!valid_slug("x --provider y", 100));
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
}
