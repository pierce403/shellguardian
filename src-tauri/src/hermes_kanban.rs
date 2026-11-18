//! Hermes's kanban board through its CLI. Works without a gateway.
//!
//! Every command is `hermes kanban [--board=<slug>] <fixed arguments>`. Free
//! text is passed in `--opt=value` form or after `--`, and IDs must start with
//! an alphanumeric, so nothing the webview supplies can become a flag. Results
//! are projected to whitelisted scalar fields.
//!
//! Each CLI call costs most of a second of CPU, so the board is not polled
//! through it. `hermes_kanban_revision` instead reports a token derived from
//! the board database's file metadata (never its contents); the webview asks
//! for that cheaply and refetches only when it changes.

use crate::hermes::{hermes_command, hermes_path, require_profile_name, sanitize_text};
use crate::hermes_gateway::{bounded, pick, rows, BODY_LIMIT, FIELD_LIMIT};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, UNIX_EPOCH};

const KANBAN_TIMEOUT: Duration = Duration::from_secs(30);
const KANBAN_TITLE_LIMIT: usize = 300;
const KANBAN_BODY_LIMIT: usize = 16 * 1024;
const LOG_TAIL_BYTES: usize = 16 * 1024;

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
    let output = tokio::time::timeout(KANBAN_TIMEOUT, child)
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
    "created_by",
    "session_id",
    "model_override",
    "provider_override",
];

// ---- Change signal ----

/// Board slug to its database path, as Hermes reported it in `boards list`.
static BOARD_DATABASES: LazyLock<Mutex<HashMap<String, PathBuf>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Accepts a database path Hermes reported only if it is an absolute `.db`
/// file inside the user's home with no parent-directory components.
fn trusted_database(path: &str, home: &Path) -> Option<PathBuf> {
    let path = PathBuf::from(path);
    let plain = path
        .components()
        .all(|part| matches!(part, Component::RootDir | Component::Normal(_)));
    let is_db = path.extension().is_some_and(|ext| ext == "db");
    (path.is_absolute() && plain && is_db && home.is_absolute() && path.starts_with(home))
        .then_some(path)
}

fn remember_boards(boards: &Value) {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return;
    };
    let Ok(mut known) = BOARD_DATABASES.lock() else {
        return;
    };
    known.clear();
    for board in rows(Some(boards)) {
        let slug = board.get("slug").and_then(Value::as_str);
        let path = board.get("db_path").and_then(Value::as_str);
        if let (Some(slug), Some(path)) = (slug, path) {
            if let (true, Some(path)) = (valid_board(slug), trusted_database(path, &home)) {
                known.insert(slug.to_owned(), path);
            }
        }
    }
}

/// A token that changes whenever the board database is written. Only file
/// metadata is read. Readers create and remove an empty write-ahead log, so
/// the log counts only while it holds pending writes.
fn revision_of(database: &Path) -> Option<String> {
    let stamp = |meta: &std::fs::Metadata| {
        meta.modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |since| since.as_nanos())
    };
    let main = std::fs::metadata(database).ok()?;
    let mut log = database.as_os_str().to_owned();
    log.push("-wal");
    let pending = std::fs::metadata(PathBuf::from(log))
        .ok()
        .filter(|meta| meta.len() > 0);
    Some(format!(
        "{}.{}.{}.{}",
        stamp(&main),
        main.len(),
        pending.as_ref().map_or(0, std::fs::Metadata::len),
        pending.as_ref().map_or(0, stamp),
    ))
}

/// Reports the board's change token. Costs no Hermes process once the board
/// list has been read; the webview refetches tasks only when it changes.
#[tauri::command]
pub async fn hermes_kanban_revision(board: String) -> Result<String, String> {
    if !valid_board(&board) {
        return Err("That board name is not valid.".into());
    }
    let known = |board: &str| {
        BOARD_DATABASES
            .lock()
            .ok()
            .and_then(|known| known.get(board).cloned())
    };
    let database = match known(&board) {
        Some(path) => path,
        None => {
            hermes_kanban_boards().await?;
            known(&board).ok_or("That board's change signal is unavailable.")?
        }
    };
    revision_of(&database).ok_or_else(|| "That board's change signal is unavailable.".into())
}

// ---- Reads ----

/// Lists kanban boards with task counts.
#[tauri::command]
pub async fn hermes_kanban_boards() -> Result<Vec<Value>, String> {
    let value = parse_json(&kanban(None, &["boards", "list", "--json"]).await?)?;
    remember_boards(&value);
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

/// Lists a board's tasks, optionally including archived ones.
#[tauri::command]
pub async fn hermes_kanban_tasks(board: String, archived: bool) -> Result<Vec<Value>, String> {
    let mut args = vec!["list", "--json"];
    if archived {
        args.push("--archived");
    }
    let value = parse_json(&kanban(Some(&board), &args).await?)?;
    Ok(rows(Some(&value))
        .map(|t| Value::Object(pick(t, TASK_KEYS, FIELD_LIMIT)))
        .collect())
}

/// One task with its body, result, comments, timeline, and runs.
#[tauri::command]
pub async fn hermes_kanban_task(board: String, id: String) -> Result<Value, String> {
    if !valid_task_id(&id) {
        return Err("That task ID is not valid.".into());
    }
    let value = parse_json(&kanban(Some(&board), &["show", &id, "--json"]).await?)?;
    Ok(project_task_detail(&value))
}

/// Event payload fields worth showing. Payloads are Hermes-internal JSON; only
/// these scalars are copied, so paths, PIDs, and anything else stay native.
const EVENT_PAYLOAD_KEYS: &[&str] = &[
    "session_id",
    "note",
    "outcome",
    "reason",
    "summary",
    "status",
    "profile",
    "error",
    "kind",
];

fn project_event(event: &Value) -> Value {
    let mut out = pick(event, &["kind", "created_at", "run_id"], FIELD_LIMIT);
    // `payload` is a JSON string in `show --json` and an object elsewhere.
    let parsed = match event.get("payload") {
        Some(Value::String(text)) => serde_json::from_str::<Value>(text).ok(),
        Some(object @ Value::Object(_)) => Some(object.clone()),
        _ => None,
    };
    if let Some(payload) = parsed {
        let detail = pick(&payload, EVENT_PAYLOAD_KEYS, 500);
        if !detail.is_empty() {
            out.insert("detail".into(), Value::Object(detail));
        }
    }
    Value::Object(out)
}

/// Projects `kanban show --json`: the task, comments, event timeline, and runs.
fn project_task_detail(value: &Value) -> Value {
    let task = value.get("task").unwrap_or(value);
    let mut out = pick(task, TASK_KEYS, FIELD_LIMIT);
    out.extend(pick(
        task,
        &["body", "result", "last_failure_error"],
        BODY_LIMIT,
    ));
    out.extend(pick(value, &["latest_summary"], BODY_LIMIT));
    out.insert(
        "comments".into(),
        Value::Array(
            rows(value.get("comments"))
                .map(|c| Value::Object(pick(c, &["author", "body", "created_at"], BODY_LIMIT)))
                .collect(),
        ),
    );
    out.insert(
        "events".into(),
        Value::Array(rows(value.get("events")).map(project_event).collect()),
    );
    out.insert(
        "runs".into(),
        Value::Array(
            rows(value.get("runs"))
                .map(|r| {
                    Value::Object(pick(
                        r,
                        &[
                            "id",
                            "profile",
                            "status",
                            "outcome",
                            "summary",
                            "error",
                            "started_at",
                            "ended_at",
                        ],
                        FIELD_LIMIT,
                    ))
                })
                .collect(),
        ),
    );
    Value::Object(out)
}

/// The tail of a task's worker log. Like terminal output it may contain
/// sensitive text: it is shown, never logged or persisted.
#[tauri::command]
pub async fn hermes_kanban_log(board: String, id: String) -> Result<String, String> {
    if !valid_task_id(&id) {
        return Err("That task ID is not valid.".into());
    }
    let tail = format!("--tail={LOG_TAIL_BYTES}");
    let text = kanban(Some(&board), &["log", &tail, "--", &id]).await?;
    Ok(sanitize_text(text.as_bytes(), LOG_TAIL_BYTES))
}

/// Board totals by status and assignee.
#[tauri::command]
pub async fn hermes_kanban_stats(board: String) -> Result<Value, String> {
    let value = parse_json(&kanban(Some(&board), &["stats", "--json"]).await?)?;
    Ok(Value::Object(pick(
        &value,
        &[
            "by_status",
            "by_assignee",
            "oldest_ready_age_seconds",
            "now",
        ],
        FIELD_LIMIT,
    )))
}

// ---- Writes ----

fn require_text(text: &str, limit: usize, what: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err(format!("Enter a {what}."));
    }
    if text.len() > limit || text.contains('\0') {
        return Err(format!("That {what} is too long."));
    }
    Ok(())
}

/// Arguments for `kanban create`. Text goes in `--opt=value` form or after
/// `--`, so it can never be parsed as a flag.
fn create_args(title: &str, body: &str, assignee: Option<&str>) -> Result<Vec<String>, String> {
    let title = title.trim();
    require_text(title, KANBAN_TITLE_LIMIT, "task title")?;
    if title.contains(['\n', '\r']) {
        return Err("Keep the task title on one line.".into());
    }
    if body.len() > KANBAN_BODY_LIMIT || body.contains('\0') {
        return Err("That description is too long.".into());
    }
    let mut args = vec![
        "create".to_owned(),
        "--json".to_owned(),
        "--created-by=you".to_owned(),
    ];
    if !body.trim().is_empty() {
        args.push(format!("--body={}", body.trim()));
    }
    if let Some(assignee) = assignee.filter(|a| !a.is_empty()) {
        require_profile_name(assignee)?;
        args.push(format!("--assignee={assignee}"));
    }
    args.push("--".to_owned());
    args.push(title.to_owned());
    Ok(args)
}

/// Creates a task. An assigned task runs when that agent's gateway runs.
#[tauri::command]
pub async fn create_hermes_kanban_task(
    board: String,
    title: String,
    body: String,
    assignee: Option<String>,
) -> Result<Value, String> {
    let args = create_args(&title, &body, assignee.as_deref())?;
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
    use serde_json::json;

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
        assert!(!valid_task_id(""));
    }

    #[test]
    fn create_arguments_keep_free_text_after_the_separator() {
        let args = create_args("  --json rm -rf  ", "-x\nline two", Some("guanyu")).unwrap();
        assert_eq!(
            args,
            vec![
                "create",
                "--json",
                "--created-by=you",
                "--body=-x\nline two",
                "--assignee=guanyu",
                "--",
                "--json rm -rf",
            ]
        );
        let bare = create_args("Title", "   ", None).unwrap();
        assert_eq!(
            bare,
            vec!["create", "--json", "--created-by=you", "--", "Title"]
        );
        assert!(create_args("", "", None).is_err());
        assert!(create_args("two\nlines", "", None).is_err());
        assert!(create_args("t", "", Some("Bad Name")).is_err());
        assert!(create_args(&"t".repeat(KANBAN_TITLE_LIMIT + 1), "", None).is_err());
        assert!(create_args("t", &"b".repeat(KANBAN_BODY_LIMIT + 1), None).is_err());
    }

    #[test]
    fn task_detail_projects_timeline_and_runs() {
        let show = json!({
            "task": {"id": "t_1", "title": "T", "status": "running", "assignee": "guanyu",
                     "session_id": "local-abc", "workspace_path": "/home/x/secret", "body": "do it"},
            "comments": [{"author": "you", "body": "hi", "created_at": 5}],
            "events": [
                {"kind": "owner_admitted", "created_at": 10, "run_id": 3,
                 "payload": "{\"session_id\":\"s_9\",\"pid\":4242,\"db\":\"/home/x/state.db\"}"},
                {"kind": "heartbeat", "created_at": 11, "payload": {"note": "halfway"}},
                {"kind": "claimed", "created_at": 9, "payload": "not json"},
            ],
            "runs": [{"id": 3, "profile": "guanyu", "status": "running", "worker_pid": 4242,
                      "metadata": {"x": "y"}, "started_at": 9}],
        });
        let out = project_task_detail(&show);
        assert_eq!(out["session_id"], "local-abc");
        assert!(out.get("workspace_path").is_none());
        assert_eq!(out["events"][0]["detail"]["session_id"], "s_9");
        assert!(out["events"][0]["detail"].get("pid").is_none());
        assert!(out["events"][0]["detail"].get("db").is_none());
        assert_eq!(out["events"][1]["detail"]["note"], "halfway");
        assert!(out["events"][2].get("detail").is_none());
        assert_eq!(out["runs"][0]["profile"], "guanyu");
        assert!(out["runs"][0].get("worker_pid").is_none());
        assert!(out["runs"][0].get("metadata").is_none());
        assert_eq!(out["comments"][0]["body"], "hi");
    }

    #[test]
    fn only_database_files_inside_home_are_trusted() {
        let home = Path::new("/home/sample");
        assert_eq!(
            trusted_database("/home/sample/.hermes/kanban.db", home),
            Some(PathBuf::from("/home/sample/.hermes/kanban.db"))
        );
        for bad in [
            "/etc/passwd",
            "/home/sample/.hermes/../../etc/shadow.db",
            "/home/other/.hermes/kanban.db",
            "relative/kanban.db",
            "/home/sample/.hermes/kanban.sqlite",
            "",
        ] {
            assert_eq!(trusted_database(bad, home), None, "{bad}");
        }
        assert_eq!(
            trusted_database("/home/sample/a.db", Path::new("home")),
            None
        );
    }

    #[test]
    fn revision_changes_on_writes_but_not_on_an_empty_log() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("kanban.db");
        assert_eq!(revision_of(&database), None);
        std::fs::write(&database, b"one").unwrap();
        let first = revision_of(&database).unwrap();
        // A reader creating, touching, or removing an empty log is not a change.
        let log = dir.path().join("kanban.db-wal");
        std::fs::write(&log, b"").unwrap();
        assert_eq!(revision_of(&database).unwrap(), first);
        std::fs::remove_file(&log).unwrap();
        assert_eq!(revision_of(&database).unwrap(), first);
        // Pending writes in the log are a change, and so is a new database size.
        std::fs::write(&log, b"frames").unwrap();
        let pending = revision_of(&database).unwrap();
        assert_ne!(pending, first);
        std::fs::remove_file(&log).unwrap();
        std::fs::write(&database, b"one two").unwrap();
        let second = revision_of(&database).unwrap();
        assert_ne!(second, first);
        assert_ne!(second, pending);
    }

    /// Read-only pass over the real kanban boards. Needs no gateway and makes
    /// no changes. Run with `SHELLGUARDIAN_TEST_KANBAN=1 cargo test -p
    /// shellguardian live_kanban -- --ignored --nocapture`. Optional
    /// `SHELLGUARDIAN_TEST_KANBAN_TASK=<board>/<task id>` inspects one task.
    #[tokio::test]
    #[ignore = "requires SHELLGUARDIAN_TEST_KANBAN and an installed Hermes"]
    async fn live_kanban_read_only_surface() {
        std::env::var("SHELLGUARDIAN_TEST_KANBAN").expect("set SHELLGUARDIAN_TEST_KANBAN=1");
        let boards = hermes_kanban_boards().await.unwrap();
        assert!(!boards.is_empty());
        for board in &boards {
            let slug = board["slug"].as_str().unwrap().to_owned();
            let open = hermes_kanban_tasks(slug.clone(), false).await.unwrap();
            let all = hermes_kanban_tasks(slug.clone(), true).await.unwrap();
            let before = hermes_kanban_revision(slug.clone()).await.unwrap();
            // Reads must not move the change signal, or the UI would refetch forever.
            hermes_kanban_tasks(slug.clone(), false).await.unwrap();
            hermes_kanban_stats(slug.clone()).await.unwrap();
            let after = hermes_kanban_revision(slug.clone()).await.unwrap();
            println!(
                "board {slug}: {} open, {} with archived, revision {before}",
                open.len(),
                all.len()
            );
            assert_eq!(before, after, "a read changed the revision of {slug}");
            assert!(all.len() >= open.len());
        }
        if let Ok(target) = std::env::var("SHELLGUARDIAN_TEST_KANBAN_TASK") {
            let (board, id) = target.split_once('/').expect("use <board>/<task id>");
            let task = hermes_kanban_task(board.to_owned(), id.to_owned())
                .await
                .unwrap();
            println!(
                "task {}: status {}, {} events, {} runs",
                task["id"],
                task["status"],
                task["events"].as_array().map_or(0, Vec::len),
                task["runs"].as_array().map_or(0, Vec::len)
            );
            for event in task["events"].as_array().into_iter().flatten() {
                println!(
                    "  {} {}",
                    event["kind"],
                    event.get("detail").unwrap_or(&Value::Null)
                );
            }
            let log = hermes_kanban_log(board.to_owned(), id.to_owned())
                .await
                .unwrap();
            println!("log tail: {} bytes", log.len());
        }
    }
}
