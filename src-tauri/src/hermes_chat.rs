//! One supervisor chat turn through `hermes chat --format stream-json`, with
//! live progress the webview can poll and a graceful stop.
//!
//! Hermes writes one JSON event per line: `system` (init), `text` deltas,
//! `tool_use`, `tool_result`, and a final `result`. Only a fixed projection
//! reaches the webview: reply text, tool names with one allowlisted argument
//! for a few known tools, timings, and token counts. Tool inputs and outputs
//! otherwise stay in native code and are never logged or persisted.
//!
//! Dangerous commands fail closed: `HERMES_INTERACTIVE=1` with no stdin makes
//! Hermes's approval prompt read end-of-file and deny.

use crate::hermes::{
    hermes_command, hermes_path, require_profile_name, sanitize_text, valid_session_id,
};
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, BufReader};

/// One supervisor turn may run tools; bound it generously.
const CHAT_TIMEOUT: Duration = Duration::from_secs(600);
/// After a stop request Hermes gets this long to wind down before it is killed.
const STOP_GRACE: Duration = Duration::from_secs(8);
/// Upper bound on one supervisor message, in bytes.
pub(crate) const MESSAGE_LIMIT: usize = 16 * 1024;
/// Upper bound on one supervisor reply returned to the webview, in characters.
const REPLY_LIMIT: usize = 128 * 1024;
/// Upper bound on one JSON event line. Hermes caps tool output at 5,000
/// characters, so real events are far smaller; longer lines are skipped.
const LINE_LIMIT: usize = 1024 * 1024;
const STDERR_LIMIT: usize = 64 * 1024;
const NOTICE_LIMIT: usize = 4096;
/// Tool steps kept per turn for display.
const STEP_LIMIT: usize = 200;

/// One tool call the supervisor made during a turn.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatStep {
    /// Tool name, e.g. `kanban_create`.
    name: String,
    /// One allowlisted argument for a few known tools (a task title or ID).
    detail: Option<String>,
    done: bool,
    failed: bool,
    duration_ms: Option<u64>,
    #[serde(skip)]
    call_id: Option<String>,
}

/// Token counts Hermes reports for a finished turn.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatTokens {
    input: u64,
    output: u64,
    total: u64,
    cache_read: u64,
}

/// One finished supervisor turn.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HermesReply {
    reply: String,
    session_id: Option<String>,
    model: Option<String>,
    tokens: Option<ChatTokens>,
    duration_ms: Option<u64>,
    steps: Vec<ChatStep>,
    /// True when the user stopped the turn; `reply` is whatever had arrived.
    stopped: bool,
}

/// Live state of the running turn, for the webview to poll.
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatProgress {
    active: bool,
    profile: Option<String>,
    /// Reply text received so far.
    text: String,
    steps: Vec<ChatStep>,
    elapsed_ms: u64,
    stopping: bool,
}

struct Turn {
    profile: String,
    text: String,
    steps: Vec<ChatStep>,
    started: Instant,
    stopping: bool,
    /// Process group of the running Hermes child, for stop and app exit.
    group: Option<i32>,
}

/// Owner of the single running chat turn. Managed by Tauri; tests build their own.
pub struct ChatTurns {
    lock: tokio::sync::Mutex<()>,
    turn: Mutex<Option<Turn>>,
    stop: tokio::sync::watch::Sender<u64>,
}

impl Default for ChatTurns {
    fn default() -> Self {
        Self {
            lock: tokio::sync::Mutex::new(()),
            turn: Mutex::new(None),
            stop: tokio::sync::watch::channel(0).0,
        }
    }
}

/// Clears the published turn when the turn ends for any reason, and makes
/// sure no Hermes process group outlives it.
struct TurnGuard<'a> {
    turns: &'a ChatTurns,
}

impl Drop for TurnGuard<'_> {
    fn drop(&mut self) {
        let finished = self.turns.turn.lock().ok().and_then(|mut turn| turn.take());
        if let Some(group) = finished.and_then(|turn| turn.group) {
            signal_group(group, Signal::Kill);
        }
    }
}

enum Signal {
    Interrupt,
    Kill,
}

/// Signals the chat child's whole process group. The group ID is only kept
/// while the child is unreaped, so it cannot have been reused.
#[cfg(unix)]
fn signal_group(group: i32, signal: Signal) {
    let number = match signal {
        Signal::Interrupt => libc::SIGINT,
        Signal::Kill => libc::SIGKILL,
    };
    if group > 1 {
        // SAFETY: `killpg` only sends a signal; `group` is our own child's group.
        unsafe {
            libc::killpg(group, number);
        }
    }
}

#[cfg(not(unix))]
fn signal_group(_group: i32, _signal: Signal) {}

enum Line {
    Text(Vec<u8>),
    TooLong,
}

/// Reads one newline-terminated line of at most `limit` bytes. A longer line
/// is consumed and reported as `TooLong`, so one oversized event cannot
/// exhaust memory. `None` at end of stream.
async fn read_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    limit: usize,
) -> std::io::Result<Option<Line>> {
    let mut line = Vec::new();
    let mut overflow = false;
    let mut any = false;
    loop {
        let (used, finished) = {
            let available = reader.fill_buf().await?;
            if available.is_empty() {
                return Ok(match (any, overflow) {
                    (false, _) => None,
                    (true, true) => Some(Line::TooLong),
                    (true, false) => Some(Line::Text(line)),
                });
            }
            any = true;
            let newline = available.iter().position(|byte| *byte == b'\n');
            let chunk = &available[..newline.unwrap_or(available.len())];
            if !overflow {
                if line.len() + chunk.len() > limit {
                    overflow = true;
                    line = Vec::new();
                } else {
                    line.extend_from_slice(chunk);
                }
            }
            (
                newline.map_or(available.len(), |at| at + 1),
                newline.is_some(),
            )
        };
        reader.consume(used);
        if finished {
            return Ok(Some(if overflow {
                Line::TooLong
            } else {
                Line::Text(line)
            }));
        }
    }
}

/// Arguments for one non-interactive supervisor turn. The message uses the
/// `--query=` form so text beginning with `-` is never parsed as a flag.
fn chat_args(profile: &str, message: &str, session_id: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "-p".to_owned(),
        profile.to_owned(),
        "chat".to_owned(),
        "-Q".to_owned(),
        "--format=stream-json".to_owned(),
        format!("--query={message}"),
    ];
    if let Some(id) = session_id {
        args.push(format!("--resume={id}"));
    }
    args
}

/// Extracts the final `session_id: <id>` line Hermes writes to stderr.
fn parse_session_id(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .rev()
        .find_map(|line| line.trim().strip_prefix("session_id:"))
        .map(str::trim)
        .filter(|id| valid_session_id(id))
        .map(str::to_owned)
}

fn one_line(text: &str, limit: usize) -> String {
    sanitize_text(text.as_bytes(), limit * 4)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(limit)
        .collect()
}

/// Picks a short, user-facing error: Hermes's `Error:` line from stderr if
/// present, else its own notice from stdout, bounded. Never whole stderr,
/// which may include logs.
fn hermes_error(stderr: &str, notice: &str) -> String {
    if let Some(detail) = stderr
        .lines()
        .find_map(|line| line.trim().strip_prefix("Error:"))
    {
        return format!("Hermes reported an error: {}", one_line(detail, 400));
    }
    let notice = one_line(notice, 400);
    if notice.is_empty() {
        "Hermes did not return a reply.".into()
    } else {
        format!("Hermes reported: {notice}")
    }
}

/// A tool name is shown as written by Hermes if it is a plain identifier.
fn tool_name(event: &Value) -> String {
    let name = event.get("name").and_then(Value::as_str).unwrap_or("");
    let plain = !name.is_empty()
        && name.len() <= 80
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':'));
    if plain {
        name.to_owned()
    } else {
        "tool".to_owned()
    }
}

/// The one argument worth showing for a few known tools. Everything else in a
/// tool's input (commands, file contents, prompts) stays out of the webview.
fn step_detail(name: &str, input: Option<&Value>) -> Option<String> {
    let key = match name {
        "kanban_create" => "title",
        "skill_view" => "name",
        name if name.starts_with("kanban_") => "task_id",
        _ => return None,
    };
    let text = one_line(input?.get(key)?.as_str()?, 120);
    (!text.is_empty()).then_some(text)
}

fn count(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

/// What the event stream has produced so far.
#[derive(Default)]
struct Stream {
    model: Option<String>,
    session_id: Option<String>,
    result: Option<Value>,
    /// Non-JSON stdout, which is how Hermes reports some startup failures.
    notice: String,
}

impl ChatTurns {
    fn with_turn(&self, change: impl FnOnce(&mut Turn)) {
        if let Ok(mut turn) = self.turn.lock() {
            if let Some(turn) = turn.as_mut() {
                change(turn);
            }
        }
    }

    /// Applies one stdout line to the live turn.
    fn apply(&self, line: Line, stream: &mut Stream) {
        let Line::Text(bytes) = line else { return };
        let Ok(event) = serde_json::from_slice::<Value>(&bytes) else {
            if stream.notice.len() < NOTICE_LIMIT {
                stream
                    .notice
                    .push_str(&sanitize_text(&bytes, NOTICE_LIMIT - stream.notice.len()));
                stream.notice.push('\n');
            }
            return;
        };
        let session = |event: &Value| {
            event
                .get("session_id")
                .and_then(Value::as_str)
                .filter(|id| valid_session_id(id))
                .map(str::to_owned)
        };
        match event.get("type").and_then(Value::as_str) {
            Some("system") => {
                stream.model = event
                    .get("model")
                    .and_then(Value::as_str)
                    .map(|model| one_line(model, 200))
                    .filter(|model| !model.is_empty());
                stream.session_id = session(&event).or(stream.session_id.take());
            }
            Some("text") => {
                if let Some(delta) = event.get("text").and_then(Value::as_str) {
                    let delta = sanitize_text(delta.as_bytes(), REPLY_LIMIT);
                    self.with_turn(|turn| {
                        let room = REPLY_LIMIT.saturating_sub(turn.text.chars().count());
                        turn.text.extend(delta.chars().take(room));
                    });
                }
            }
            Some("tool_use") => {
                let name = tool_name(&event);
                let step = ChatStep {
                    detail: step_detail(&name, event.get("input")),
                    name,
                    done: false,
                    failed: false,
                    duration_ms: None,
                    call_id: event
                        .get("tool_call_id")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                };
                self.with_turn(|turn| {
                    if turn.steps.len() < STEP_LIMIT {
                        turn.steps.push(step);
                    }
                });
            }
            Some("tool_result") => {
                let name = tool_name(&event);
                let call_id = event.get("tool_call_id").and_then(Value::as_str);
                let failed = event.get("is_error").and_then(Value::as_bool) == Some(true);
                let duration = event.get("duration_ms").and_then(Value::as_u64);
                self.with_turn(|turn| {
                    let open = turn.steps.iter_mut().rev().find(|step| {
                        !step.done
                            && match (call_id, step.call_id.as_deref()) {
                                (Some(wanted), Some(have)) => wanted == have,
                                _ => step.name == name,
                            }
                    });
                    if let Some(step) = open {
                        step.done = true;
                        step.failed = failed;
                        step.duration_ms = duration;
                    }
                });
            }
            Some("result") => {
                stream.session_id = session(&event).or(stream.session_id.take());
                stream.result = Some(event);
            }
            _ => {}
        }
    }

    /// A snapshot of the running turn, or an idle default.
    pub fn progress(&self) -> ChatProgress {
        let turn = self.turn.lock();
        match turn.as_ref().ok().and_then(|turn| turn.as_ref()) {
            Some(turn) => ChatProgress {
                active: true,
                profile: Some(turn.profile.clone()),
                text: turn.text.clone(),
                steps: turn.steps.clone(),
                elapsed_ms: u64::try_from(turn.started.elapsed().as_millis()).unwrap_or(u64::MAX),
                stopping: turn.stopping,
            },
            None => ChatProgress::default(),
        }
    }

    /// Asks the running turn to stop. Returns whether a turn was running.
    pub fn request_stop(&self) -> bool {
        // Marked under the lock, so a second request while stopping is a no-op.
        let accepted = self.turn.lock().is_ok_and(|mut turn| match turn.as_mut() {
            Some(turn) if !turn.stopping => {
                turn.stopping = true;
                true
            }
            _ => false,
        });
        if accepted {
            self.stop.send_modify(|requests| *requests += 1);
        }
        accepted
    }

    /// Kills any running turn's process group. Called at app exit; the turn
    /// itself continues inside the Hermes gateway if one is serving it.
    pub fn shutdown(&self) {
        let group = self
            .turn
            .lock()
            .ok()
            .and_then(|turn| turn.as_ref().and_then(|turn| turn.group));
        if let Some(group) = group {
            signal_group(group, Signal::Kill);
        }
    }

    /// Runs one turn to completion, publishing progress as it goes.
    async fn run(
        &self,
        binary: &Path,
        profile: &str,
        message: &str,
        session_id: Option<&str>,
        timeout: Duration,
    ) -> Result<HermesReply, String> {
        require_profile_name(profile)?;
        let message = message.trim();
        if message.is_empty() {
            return Err("Enter a message for the supervisor.".into());
        }
        if message.len() > MESSAGE_LIMIT || message.contains('\0') {
            return Err("That message is too long to send. Shorten it and try again.".into());
        }
        if session_id.is_some_and(|id| !valid_session_id(id)) {
            return Err("The conversation ID is not valid. Start a new conversation.".into());
        }
        let Ok(_one_at_a_time) = self.lock.try_lock() else {
            return Err("The supervisor is still answering the previous message.".into());
        };
        let mut stop = self.stop.subscribe();
        stop.borrow_and_update();

        let mut command = hermes_command(binary);
        command
            .env("HERMES_INTERACTIVE", "1")
            .args(chat_args(profile, message, session_id))
            .stderr(Stdio::piped());
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command
            .spawn()
            .map_err(|_| "Could not run the installed Hermes CLI.".to_string())?;
        let group = child.id().and_then(|id| i32::try_from(id).ok());
        if let Ok(mut turn) = self.turn.lock() {
            *turn = Some(Turn {
                profile: profile.to_owned(),
                text: String::new(),
                steps: Vec::new(),
                started: Instant::now(),
                stopping: false,
                group,
            });
        }
        let _guard = TurnGuard { turns: self };

        let stdout = child.stdout.take().ok_or("Could not read Hermes output.")?;
        let stderr = child.stderr.take().ok_or("Could not read Hermes output.")?;
        // A reader task keeps line assembly out of the cancellable select below.
        let (lines, mut next_line) = tokio::sync::mpsc::channel::<Line>(64);
        let reader = tokio::spawn(async move {
            let mut stdout = BufReader::new(stdout);
            while let Ok(Some(line)) = read_line(&mut stdout, LINE_LIMIT).await {
                if lines.send(line).await.is_err() {
                    break;
                }
            }
        });
        let errors = tokio::spawn(async move {
            let mut stderr = stderr;
            let mut kept = Vec::new();
            let mut chunk = [0u8; 4096];
            while let Ok(read) = stderr.read(&mut chunk).await {
                if read == 0 {
                    break;
                }
                let room = STDERR_LIMIT.saturating_sub(kept.len());
                kept.extend_from_slice(&chunk[..read.min(room)]);
            }
            kept
        });

        let deadline = tokio::time::Instant::now() + timeout;
        let mut stop_deadline: Option<tokio::time::Instant> = None;
        // Once Hermes exits, lines still in the pipe get a moment to arrive. A
        // process it started may hold the pipe open, so end-of-file is not awaited.
        let mut drain_deadline: Option<tokio::time::Instant> = None;
        let mut stream = Stream::default();
        let mut timed_out = false;
        let mut force_kill = false;
        loop {
            let wake = drain_deadline.or(stop_deadline).unwrap_or(deadline);
            tokio::select! {
                line = next_line.recv() => match line {
                    Some(line) => {
                        self.apply(line, &mut stream);
                        // `result` is the terminal event.
                        if stream.result.is_some() {
                            break;
                        }
                    }
                    None => break,
                },
                _ = child.wait(), if drain_deadline.is_none() => {
                    drain_deadline =
                        Some(tokio::time::Instant::now() + Duration::from_millis(500));
                }
                changed = stop.changed(), if stop_deadline.is_none() => {
                    if changed.is_ok() {
                        if let Some(group) = group {
                            signal_group(group, Signal::Interrupt);
                        }
                        stop_deadline = Some(tokio::time::Instant::now() + STOP_GRACE);
                    }
                }
                () = tokio::time::sleep_until(wake) => {
                    if drain_deadline.is_none() {
                        // Still running past the stop grace or the turn limit.
                        timed_out = stop_deadline.is_none();
                        force_kill = true;
                    }
                    break;
                }
            }
        }
        if force_kill {
            if let Some(group) = group {
                signal_group(group, Signal::Kill);
            }
            let _ = child.start_kill();
        }
        if tokio::time::timeout(Duration::from_secs(3), child.wait())
            .await
            .is_err()
        {
            if let Some(group) = group {
                signal_group(group, Signal::Kill);
            }
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        // The child is reaped: its group ID must not be signalled again.
        self.with_turn(|turn| turn.group = None);
        reader.abort();
        let stderr = tokio::time::timeout(Duration::from_secs(2), errors)
            .await
            .ok()
            .and_then(Result::ok)
            .map(|bytes| sanitize_text(&bytes, STDERR_LIMIT))
            .unwrap_or_default();

        let (text, steps, started) = self
            .turn
            .lock()
            .ok()
            .and_then(|turn| {
                turn.as_ref()
                    .map(|turn| (turn.text.clone(), turn.steps.clone(), turn.started))
            })
            .unwrap_or_else(|| (String::new(), Vec::new(), Instant::now()));
        if timed_out {
            return Err(format!(
                "The supervisor did not finish within {} minutes and was stopped.",
                timeout.as_secs().div_ceil(60)
            ));
        }
        let stopped = stop_deadline.is_some();
        let result = stream.result.as_ref();
        let final_text = result
            .and_then(|result| result.get("text"))
            .and_then(Value::as_str)
            .map(|text| sanitize_text(text.as_bytes(), REPLY_LIMIT))
            .filter(|text| !text.trim().is_empty())
            .unwrap_or(text);
        let failure = result.and_then(|result| {
            let code = result.get("exit_code").and_then(Value::as_i64).unwrap_or(0);
            let error = result.get("error").and_then(Value::as_str);
            (code != 0 || error.is_some()).then(|| error.unwrap_or(&final_text).to_owned())
        });
        if !stopped {
            if let Some(failure) = failure {
                let detail = one_line(&failure, 400);
                return Err(if detail.is_empty() {
                    "Hermes did not return a reply.".into()
                } else {
                    format!("Hermes reported an error: {detail}")
                });
            }
            if result.is_none() || final_text.trim().is_empty() {
                return Err(hermes_error(&stderr, &stream.notice));
            }
        }
        let tokens = result
            .and_then(|result| result.get("tokens"))
            .map(|tokens| ChatTokens {
                input: count(tokens.get("input")),
                output: count(tokens.get("output")),
                total: count(tokens.get("total")),
                cache_read: count(tokens.get("cache_read")),
            });
        Ok(HermesReply {
            reply: final_text.trim().to_owned(),
            session_id: stream.session_id.or_else(|| parse_session_id(&stderr)),
            model: stream.model,
            tokens,
            duration_ms: Some(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)),
            steps,
            stopped,
        })
    }
}

/// Sends one message to a Hermes profile and returns its reply. One turn runs
/// at a time; poll `hermes_chat_progress` while it runs.
#[tauri::command]
pub async fn hermes_chat(
    turns: tauri::State<'_, ChatTurns>,
    profile: String,
    message: String,
    session_id: Option<String>,
) -> Result<HermesReply, String> {
    let binary = hermes_path().ok_or("Hermes is not installed on this machine.")?;
    turns
        .run(
            &binary,
            &profile,
            &message,
            session_id.as_deref(),
            CHAT_TIMEOUT,
        )
        .await
}

/// Live progress of the running turn: reply text so far and tool steps.
#[tauri::command]
pub fn hermes_chat_progress(turns: tauri::State<'_, ChatTurns>) -> ChatProgress {
    turns.progress()
}

/// Stops the running turn: interrupts Hermes, then kills it after a grace period.
#[tauri::command]
pub fn stop_hermes_chat(turns: tauri::State<'_, ChatTurns>) -> bool {
    turns.request_stop()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hermes::HERMES_ENV_ALLOWLIST;
    use std::fs;

    #[cfg(unix)]
    fn stub(dir: &Path, name: &str, body: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        crate::test_support::write_script(&path, &format!("#!/bin/sh\n{body}"));
        path
    }

    const MINUTE: Duration = Duration::from_secs(60);

    #[test]
    fn chat_args_never_let_message_become_a_flag() {
        let args = chat_args("guanyu", "--yolo -h", Some("20261118_060100_7999ca"));
        assert_eq!(
            args,
            vec![
                "-p",
                "guanyu",
                "chat",
                "-Q",
                "--format=stream-json",
                "--query=--yolo -h",
                "--resume=20261118_060100_7999ca",
            ]
        );
        assert!(!args.iter().any(|a| a == "--yolo"));
        assert_eq!(chat_args("p", "hi", None).len(), 6);
        // A leading dash is harmless: it is always passed as `--resume=<id>`.
        assert!(chat_args("p", "m", Some("--yolo")).contains(&"--resume=--yolo".to_owned()));
    }

    #[test]
    fn session_id_comes_from_the_last_valid_stderr_line() {
        assert_eq!(
            parse_session_id("log\nsession_id: a_1\nmore\n  session_id:   local-9f \n"),
            Some("local-9f".into())
        );
        assert_eq!(parse_session_id("session_id: bad id\n"), None);
        assert_eq!(parse_session_id("nothing\n"), None);
    }

    #[test]
    fn errors_expose_only_a_bounded_line() {
        let stderr = format!(
            "  ⚠ some log line with /home/path\nError: Error code: 401 {}\n\nsession_id: x\n",
            "z".repeat(1000)
        );
        let message = hermes_error(&stderr, "ignored when stderr has an error");
        assert!(message.starts_with("Hermes reported an error: Error code: 401"));
        assert!(!message.contains("/home/path"));
        assert!(message.len() < 500);
        assert_eq!(
            hermes_error("log only\n", ""),
            "Hermes did not return a reply."
        );
        assert_eq!(
            hermes_error(
                "",
                "Hermes couldn't start the model connection: invalid_params. Your message\nwas not sent."
            ),
            "Hermes reported: Hermes couldn't start the model connection: invalid_params. Your message was not sent."
        );
        assert!(hermes_error("", &"y".repeat(5000)).len() < 450);
    }

    #[test]
    fn only_allowlisted_tool_arguments_are_shown() {
        let input = serde_json::json!({
            "title": "Check   the\nlogs", "task_id": "t_1", "name": "kanban",
            "command": "curl -H 'Authorization: secret'", "body": "private"
        });
        assert_eq!(
            step_detail("kanban_create", Some(&input)),
            Some("Check the logs".into())
        );
        assert_eq!(step_detail("kanban_show", Some(&input)), Some("t_1".into()));
        assert_eq!(
            step_detail("skill_view", Some(&input)),
            Some("kanban".into())
        );
        assert_eq!(step_detail("terminal", Some(&input)), None);
        assert_eq!(step_detail("kanban_create", None), None);
        assert_eq!(
            tool_name(&serde_json::json!({"name": "bad name; rm"})),
            "tool"
        );
        assert_eq!(
            tool_name(&serde_json::json!({"name": "mcp-x:run.v2"})),
            "mcp-x:run.v2"
        );
    }

    #[tokio::test]
    async fn lines_are_bounded_without_losing_the_stream() {
        let data = format!("short\n{}\nafter\nlast", "x".repeat(50));
        let mut reader = BufReader::with_capacity(8, data.as_bytes());
        let mut seen = Vec::new();
        while let Some(line) = read_line(&mut reader, 20).await.unwrap() {
            seen.push(match line {
                Line::Text(bytes) => String::from_utf8(bytes).unwrap(),
                Line::TooLong => "<too long>".into(),
            });
        }
        assert_eq!(seen, vec!["short", "<too long>", "after", "last"]);
        let mut empty = BufReader::new(&b""[..]);
        assert!(read_line(&mut empty, 20).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn chat_rejects_invalid_input_before_running_anything() {
        let turns = ChatTurns::default();
        let missing = Path::new("/nonexistent/hermes");
        for (profile, message, session) in [
            ("Bad", "hi", None),
            ("ok", "   ", None),
            ("ok", "a\0b", None),
            ("ok", "hi", Some("bad id")),
        ] {
            assert!(turns
                .run(missing, profile, message, session, MINUTE)
                .await
                .is_err());
        }
        let long = "a".repeat(MESSAGE_LIMIT + 1);
        let error = turns
            .run(missing, "ok", &long, None, MINUTE)
            .await
            .unwrap_err();
        assert!(error.contains("too long"));
        assert_eq!(turns.progress(), ChatProgress::default());
    }

    /// A stub Hermes records its argv and environment, proving the chat call
    /// passes only allowlisted variables (so no provider key from the test
    /// runner's environment), fails closed on approvals, and reads the stream.
    #[cfg(unix)]
    #[tokio::test]
    async fn chat_scrubs_environment_and_parses_the_event_stream() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("record");
        let script = format!(
            r#"printf '%s\n' "$@" > '{rec}.args'
env > '{rec}.env'
echo '{{"type":"system","subtype":"init","model":"gpt-test","session_id":""}}'
echo '{{"type":"tool_use","name":"kanban_create","tool_call_id":"call-xyz","input":{{"title":"Check logs","body":"private body"}}}}'
echo '{{"type":"tool_result","name":"kanban_create","tool_call_id":"call-xyz","output":"secret output","duration_ms":42,"is_error":false}}'
echo '{{"type":"tool_use","name":"terminal","input":{{"command":"cat /etc/passwd"}}}}'
echo '{{"type":"tool_result","name":"terminal","output":"x","duration_ms":7,"is_error":true}}'
echo '{{"type":"text","text":"Hello "}}'
echo '{{"type":"text","text":"from \u001b[1mHermes"}}'
echo '{{"type":"result","session_id":"local-abc123","exit_code":0,"text":"Hello from Hermes","tokens":{{"input":1200,"output":34,"total":5000,"cache_read":3766,"cache_write":0}},"duration_ms":900}}'
printf '\nsession_id: local-abc123\n' >&2
"#,
            rec = record.display()
        );
        let hermes = stub(dir.path(), "hermes", &script);
        let turns = ChatTurns::default();
        let reply = turns
            .run(&hermes, "guanyu", "status?", None, MINUTE)
            .await
            .unwrap();
        assert_eq!(reply.reply, "Hello from Hermes");
        assert_eq!(reply.session_id.as_deref(), Some("local-abc123"));
        assert_eq!(reply.model.as_deref(), Some("gpt-test"));
        assert!(!reply.stopped);
        assert_eq!(
            reply.tokens,
            Some(ChatTokens {
                input: 1200,
                output: 34,
                total: 5000,
                cache_read: 3766
            })
        );
        assert_eq!(reply.steps.len(), 2);
        assert_eq!(reply.steps[0].name, "kanban_create");
        assert_eq!(reply.steps[0].detail.as_deref(), Some("Check logs"));
        assert!(reply.steps[0].done && !reply.steps[0].failed);
        assert_eq!(reply.steps[0].duration_ms, Some(42));
        assert_eq!(reply.steps[1].name, "terminal");
        assert_eq!(reply.steps[1].detail, None);
        assert!(reply.steps[1].done && reply.steps[1].failed);
        // Nothing from tool inputs or outputs is serialized.
        let wire = serde_json::to_string(&reply).unwrap();
        for hidden in ["private body", "secret output", "/etc/passwd", "call-xyz"] {
            assert!(!wire.contains(hidden), "{hidden}");
        }
        assert_eq!(turns.progress(), ChatProgress::default());

        let env = fs::read_to_string(format!("{}.env", record.display())).unwrap();
        assert!(env.lines().any(|l| l == "HERMES_INTERACTIVE=1"));
        for line in env.lines() {
            let name = line.split('=').next().unwrap();
            assert!(
                HERMES_ENV_ALLOWLIST.contains(&name)
                    || ["HERMES_INTERACTIVE", "PWD", "OLDPWD", "SHLVL", "_"].contains(&name),
                "unexpected variable {name}"
            );
        }
        let args = fs::read_to_string(format!("{}.args", record.display())).unwrap();
        assert_eq!(
            args,
            "-p\nguanyu\nchat\n-Q\n--format=stream-json\n--query=status?\n"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn chat_failures_report_hermes_own_words() {
        let dir = tempfile::tempdir().unwrap();
        let turns = ChatTurns::default();
        let failing = stub(
            dir.path(),
            "failing",
            "echo '{\"type\":\"system\",\"subtype\":\"init\",\"model\":\"m\",\"session_id\":\"\"}'\necho '{\"type\":\"result\",\"session_id\":\"s1\",\"exit_code\":1,\"text\":\"\",\"error\":\"Invalid API key\",\"tokens\":{}}'\nexit 1\n",
        );
        assert_eq!(
            turns
                .run(&failing, "guanyu", "hi", None, MINUTE)
                .await
                .unwrap_err(),
            "Hermes reported an error: Invalid API key"
        );
        let legacy = stub(
            dir.path(),
            "legacy",
            "echo 'noise' >&2\necho 'Error: Invalid API key' >&2\nexit 1\n",
        );
        assert_eq!(
            turns
                .run(&legacy, "guanyu", "hi", None, MINUTE)
                .await
                .unwrap_err(),
            "Hermes reported an error: Invalid API key"
        );
        let notice = stub(
            dir.path(),
            "notice",
            "echo \"Hermes couldn't start the model connection: invalid_params.\"\nexit 1\n",
        );
        assert_eq!(
            turns
                .run(&notice, "guanyu", "hi", None, MINUTE)
                .await
                .unwrap_err(),
            "Hermes reported: Hermes couldn't start the model connection: invalid_params."
        );
        let silent = stub(dir.path(), "silent", "exit 0\n");
        assert_eq!(
            turns
                .run(&silent, "guanyu", "hi", None, MINUTE)
                .await
                .unwrap_err(),
            "Hermes did not return a reply."
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn progress_is_live_and_concurrent_turns_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let slow = stub(
            dir.path(),
            "slow",
            "echo '{\"type\":\"tool_use\",\"name\":\"kanban_show\",\"input\":{\"task_id\":\"t_9\"}}'\necho '{\"type\":\"text\",\"text\":\"Working\"}'\nsleep 1\necho '{\"type\":\"result\",\"session_id\":\"s2\",\"exit_code\":0,\"text\":\"Working done\",\"tokens\":{}}'\n",
        );
        let turns = ChatTurns::default();
        let first = turns.run(&slow, "guanyu", "one", None, MINUTE);
        let watcher = async {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let seen = turns.progress();
            let refused = turns.run(&slow, "guanyu", "two", None, MINUTE).await;
            (seen, refused)
        };
        let (first, (seen, refused)) = tokio::join!(first, watcher);
        assert!(seen.active);
        assert_eq!(seen.profile.as_deref(), Some("guanyu"));
        assert_eq!(seen.text, "Working");
        assert_eq!(seen.steps.len(), 1);
        assert_eq!(seen.steps[0].detail.as_deref(), Some("t_9"));
        assert!(!seen.steps[0].done);
        assert!(refused.unwrap_err().contains("still answering"));
        assert_eq!(first.unwrap().reply, "Working done");
        assert!(!turns.progress().active);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stop_interrupts_hermes_and_returns_what_arrived() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("interrupted");
        // Hermes handles SIGINT by ending the turn with a final `result`. The
        // stub leaves nothing running behind it.
        let polite = stub(
            dir.path(),
            "polite",
            &format!(
                "trap 'touch {m}; echo \"{{\\\"type\\\":\\\"result\\\",\\\"session_id\\\":\\\"s3\\\",\\\"exit_code\\\":130,\\\"text\\\":\\\"\\\",\\\"tokens\\\":{{}}}}\"; exit 130' INT\necho '{{\"type\":\"text\",\"text\":\"Partial answer\"}}'\nwhile :; do sleep 0.1; done\n",
                m = marker.display()
            ),
        );
        let turns = ChatTurns::default();
        assert!(!turns.request_stop(), "nothing is running yet");
        let run = turns.run(&polite, "guanyu", "long task", None, MINUTE);
        let stopper = async {
            tokio::time::sleep(Duration::from_millis(400)).await;
            let first = turns.request_stop();
            let second = turns.request_stop();
            (first, second)
        };
        let started = Instant::now();
        let (reply, (first, second)) = tokio::join!(run, stopper);
        let reply = reply.unwrap();
        assert!(first, "the running turn accepts a stop");
        assert!(!second, "a second stop while stopping is a no-op");
        assert!(reply.stopped);
        assert_eq!(reply.reply, "Partial answer");
        assert_eq!(reply.session_id.as_deref(), Some("s3"));
        assert!(marker.exists(), "Hermes received the interrupt");
        assert!(started.elapsed() < Duration::from_secs(6));
        assert!(!turns.progress().active);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_turn_that_ignores_stop_or_runs_too_long_is_killed() {
        let dir = tempfile::tempdir().unwrap();
        let stubborn = stub(
            dir.path(),
            "stubborn",
            "trap '' INT\necho '{\"type\":\"text\",\"text\":\"still going\"}'\nsleep 60\n",
        );
        let turns = ChatTurns::default();
        let started = Instant::now();
        let error = turns
            .run(&stubborn, "guanyu", "hi", None, Duration::from_millis(700))
            .await
            .unwrap_err();
        assert!(error.contains("did not finish"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(8));
        assert!(!turns.progress().active);
        // The lock is free again for the next turn.
        let quick = stub(
            dir.path(),
            "quick",
            "echo '{\"type\":\"result\",\"session_id\":\"s4\",\"exit_code\":0,\"text\":\"ok\",\"tokens\":{}}'\n",
        );
        assert_eq!(
            turns
                .run(&quick, "guanyu", "hi", None, MINUTE)
                .await
                .unwrap()
                .reply,
            "ok"
        );
    }

    /// One real, tiny chat turn through the installed Hermes, to check the
    /// event stream against the real CLI. Spends a little inference on the
    /// profile's provider. Run with `SHELLGUARDIAN_TEST_HERMES_CHAT=<profile>
    /// cargo test -p shellguardian live_chat -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "requires SHELLGUARDIAN_TEST_HERMES_CHAT; spends real inference"]
    async fn live_chat_turn_streams_and_resumes() {
        let profile = std::env::var("SHELLGUARDIAN_TEST_HERMES_CHAT")
            .expect("set SHELLGUARDIAN_TEST_HERMES_CHAT to a profile name");
        let binary = hermes_path().expect("Hermes is installed");
        let turns = ChatTurns::default();
        let run = turns.run(
            &binary,
            &profile,
            "Reply with just the word pong. Do not use any tools.",
            None,
            Duration::from_secs(300),
        );
        let watch = async {
            let mut most = ChatProgress::default();
            for _ in 0..600 {
                tokio::time::sleep(Duration::from_millis(250)).await;
                let seen = turns.progress();
                if !seen.active && most.active {
                    break;
                }
                if seen.active {
                    most = seen;
                }
            }
            most
        };
        let (reply, seen) = tokio::join!(run, watch);
        let reply = reply.unwrap();
        println!(
            "reply {:?}, model {:?}, tokens {:?}, {} ms, steps {:?}, session {:?}",
            reply.reply,
            reply.model,
            reply.tokens,
            reply.duration_ms.unwrap_or(0),
            reply.steps.iter().map(|s| &s.name).collect::<Vec<_>>(),
            reply
                .session_id
                .as_deref()
                .map(|id| &id[..id.len().min(12)])
        );
        println!(
            "progress while running: active {}, {} chars, {} steps",
            seen.active,
            seen.text.len(),
            seen.steps.len()
        );
        assert!(reply.reply.to_lowercase().contains("pong"));
        assert!(seen.active, "progress was visible while the turn ran");
        let session = reply.session_id.expect("Hermes reported a session ID");
        let again = turns
            .run(
                &binary,
                &profile,
                "What single word did you just reply with? Answer with that word only.",
                Some(&session),
                Duration::from_secs(300),
            )
            .await
            .unwrap();
        println!("resumed reply {:?}, tokens {:?}", again.reply, again.tokens);
        assert!(again.reply.to_lowercase().contains("pong"));
    }
}
