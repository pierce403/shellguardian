//! Lists a profile's Hermes sessions through `hermes sessions list`.
//!
//! The gateway's own session list is a "picker" that deliberately hides
//! one-shot chats and kanban worker runs, which is most of what ShellGuardian
//! creates. The CLI lists them all, as a fixed-width text table whose columns
//! depend on the data, so rows are sliced by the header's column offsets.

use crate::hermes::{hermes_command, hermes_path, require_profile_name, valid_session_id};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

const SESSIONS_TIMEOUT: Duration = Duration::from_secs(30);
/// Sessions requested per listing.
const SESSION_LIMIT: usize = 80;
const TABLE_LIMIT: usize = 256 * 1024;
const COLUMNS: [&str; 6] = ["Title", "Preview", "Workspace", "Last Active", "Src", "ID"];

/// One session as shown in the Sessions tab.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    id: String,
    title: Option<String>,
    /// Start of the first user message, when Hermes shows one.
    preview: Option<String>,
    /// Folder or kanban task the session ran in, as Hermes labels it.
    workspace: Option<String>,
    /// Hermes's own relative time, for example `6m ago`.
    last_active: Option<String>,
    /// `task` (kanban worker run), `chat` (one-shot run), or `conversation`.
    kind: String,
    /// Hermes's source label when known, for example `telegram`.
    source: Option<String>,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct Parsed {
    id: String,
    title: Option<String>,
    preview: Option<String>,
    workspace: Option<String>,
    last_active: Option<String>,
    source: Option<String>,
}

/// One table cell. Control characters are removed here, after the row has
/// been sliced, so they cannot shift the columns.
fn cell(chars: &[char], start: usize, end: usize) -> Option<String> {
    let end = end.min(chars.len());
    if start >= end {
        return None;
    }
    let text: String = chars[start..end]
        .iter()
        .map(|c| if c.is_control() { ' ' } else { *c })
        .collect();
    let text = text.trim();
    (!text.is_empty() && text != "—" && text != "-" && text != "?").then(|| text.to_owned())
}

/// Parses the table `hermes sessions list` prints. The header names the
/// columns; each row is sliced at the header's character offsets, except the
/// ID, which is always the last token on the line.
fn parse_session_table(text: &str) -> Vec<Parsed> {
    let lines: Vec<&str> = text.lines().collect();
    let Some(rule) = lines.iter().position(|line| line.starts_with('─')) else {
        return Vec::new();
    };
    let Some(header) = rule.checked_sub(1).map(|at| lines[at]) else {
        return Vec::new();
    };
    // The header is plain ASCII, so byte offsets are character offsets.
    let mut columns: Vec<(&str, usize)> = COLUMNS
        .iter()
        .filter_map(|name| header.rfind(name).map(|at| (*name, at)))
        .filter(|(name, at)| {
            // A match must start a column: at the line start or after spaces.
            *at == 0 || header.as_bytes()[*at - 1] == b' ' || *name == "ID"
        })
        .collect();
    columns.sort_by_key(|(_, at)| *at);
    if columns.last().map(|(name, _)| *name) != Some("ID") {
        return Vec::new();
    }
    let mut sessions = Vec::new();
    for line in &lines[rule + 1..] {
        let line = line.trim_end();
        let chars: Vec<char> = line.chars().collect();
        let Some(id) = line.split_whitespace().last() else {
            continue;
        };
        let id_start = chars.len().saturating_sub(id.chars().count());
        let enough = columns.len() < 2 || id_start >= columns[columns.len() - 2].1;
        if id.len() < 6 || !valid_session_id(id) || !enough {
            continue;
        }
        let mut row = Parsed {
            id: id.to_owned(),
            ..Parsed::default()
        };
        for (index, (name, start)) in columns.iter().enumerate() {
            let end = match columns.get(index + 1) {
                Some(("ID", _)) => id_start,
                Some((_, next)) => *next,
                None => continue,
            };
            let mut value = cell(&chars, *start, end);
            // Hermes cuts titles and previews to three characters short of the
            // column; a value that fills it was cut, so say so.
            if matches!(*name, "Title" | "Preview") {
                let full = end.saturating_sub(*start + 3);
                if let Some(text) = value.as_mut().filter(|t| t.chars().count() >= full) {
                    text.push('…');
                }
            }
            match *name {
                "Title" => row.title = value,
                "Preview" => row.preview = value,
                "Workspace" => row.workspace = value,
                "Last Active" => row.last_active = value,
                "Src" => row.source = value,
                _ => {}
            }
        }
        sessions.push(row);
    }
    sessions
}

async fn list(binary: &Path, profile: &str, source: Option<&str>) -> Result<Vec<Parsed>, String> {
    let limit = format!("--limit={SESSION_LIMIT}");
    let mut command = hermes_command(binary);
    command.args(["-p", profile, "sessions", "list", &limit]);
    if let Some(source) = source {
        command.arg(format!("--source={source}"));
    }
    let output = tokio::time::timeout(SESSIONS_TIMEOUT, command.output())
        .await
        .map_err(|_| "Hermes did not list its sessions in time.".to_string())?
        .map_err(|_| "Could not run the installed Hermes CLI.".to_string())?;
    if !output.status.success() {
        return Err("Hermes could not list this agent's sessions.".into());
    }
    // Parse the raw table: removing control characters first would shift a
    // row's columns. Cells are cleaned as they are sliced.
    let raw = &output.stdout[..output.stdout.len().min(TABLE_LIMIT)];
    Ok(parse_session_table(&String::from_utf8_lossy(raw)))
}

/// Combines the full listing with the per-source listings that reveal which
/// rows are kanban worker runs and one-shot chats (and their previews).
fn merge(all: Vec<Parsed>, tasks: Vec<Parsed>, chats: Vec<Parsed>) -> Vec<SessionRow> {
    let mut extra: HashMap<String, (&'static str, Parsed)> = HashMap::new();
    for row in tasks {
        extra.insert(row.id.clone(), ("task", row));
    }
    for row in chats {
        extra.insert(row.id.clone(), ("chat", row));
    }
    all.into_iter()
        .map(|row| {
            let (kind, more) = match extra.remove(&row.id) {
                Some((kind, more)) => (kind, Some(more)),
                None => ("conversation", None),
            };
            let more = more.unwrap_or_default();
            SessionRow {
                title: row.title.or(more.title),
                preview: row.preview.or(more.preview),
                workspace: row.workspace.or(more.workspace),
                last_active: row.last_active.or(more.last_active),
                source: row.source.or(more.source),
                kind: kind.to_owned(),
                id: row.id,
            }
        })
        .collect()
}

/// Lists a profile's recent sessions of every kind, newest first.
#[tauri::command]
pub async fn hermes_sessions(profile: String) -> Result<Vec<SessionRow>, String> {
    require_profile_name(&profile)?;
    let binary = hermes_path().ok_or("Hermes is not installed on this machine.")?;
    let (all, tasks, chats) = tokio::join!(
        list(&binary, &profile, None),
        list(&binary, &profile, Some("kanban")),
        list(&binary, &profile, Some("oneshot")),
    );
    // The per-source listings only add labels; the full listing must succeed.
    Ok(merge(
        all?,
        tasks.unwrap_or_default(),
        chats.unwrap_or_default(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID_A: &str = "local-aa62b9044b2a218852ebf3d1cb4d1c9c13e672e093ec53e6181e68a9b1949b10";
    const ID_B: &str = "local-e5d4b44c486cb7e482aaf6468af84552a510be4612b7fd4cd1b482d6f8a97781";

    fn titled() -> String {
        format!(
            "{:<28} {:<18} {:<13} {}\n{}\n{:<28} {:<18} {:<13} {ID_A}\n{:<28} {:<18} {:<13} {ID_B}\n  … more not shown (use --limit 16 to see more)\n",
            "Title", "Workspace", "Last Active", "ID",
            "─".repeat(110),
            "sgacc-bf2216-fail read fil", "t_1930633b", "6m ago",
            "—", "shellguardian", "yesterday",
        )
    }

    #[test]
    fn parses_the_titled_layout_by_header_offsets() {
        let rows = parse_session_table(&titled());
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, ID_A);
        assert_eq!(
            rows[0].title.as_deref(),
            Some("sgacc-bf2216-fail read fil…"),
            "a title that fills its column was cut by Hermes"
        );
        assert_eq!(rows[0].workspace.as_deref(), Some("t_1930633b"));
        assert_eq!(rows[0].last_active.as_deref(), Some("6m ago"));
        assert_eq!(rows[0].source, None);
        assert_eq!(rows[1].title, None, "a dash is no title");
        assert_eq!(rows[1].last_active.as_deref(), Some("yesterday"));
    }

    #[test]
    fn parses_preview_layouts_with_wide_text_and_sources() {
        let table = format!(
            "{:<38} {:<18} {:<13} {:<16} {}\n{}\n{:<38} {:<18} {:<13} {:<16} {ID_B}\n",
            "Preview",
            "Workspace",
            "Last Active",
            "Src",
            "ID",
            "─".repeat(110),
            "Use the  kanban board «sg» ID Title",
            "src-tauri",
            "just now",
            "cli→oneshot",
        );
        let rows = parse_session_table(&table);
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].preview.as_deref(),
            Some("Use the  kanban board «sg» ID Title")
        );
        assert_eq!(rows[0].workspace.as_deref(), Some("src-tauri"));
        assert_eq!(rows[0].source.as_deref(), Some("cli→oneshot"));

        let no_workspace = format!(
            "{:<50} {:<13} {:<16} {}\n{}\n{:<50} {:<13} {:<16} {ID_A}\n",
            "Preview",
            "Last Active",
            "Src",
            "ID",
            "─".repeat(105),
            "hello friend",
            "2026-11-18",
            "telegram",
        );
        let rows = parse_session_table(&no_workspace);
        assert_eq!(rows[0].preview.as_deref(), Some("hello friend"));
        assert_eq!(rows[0].workspace, None);
        assert_eq!(rows[0].last_active.as_deref(), Some("2026-11-18"));
        assert_eq!(rows[0].source.as_deref(), Some("telegram"));
    }

    #[test]
    fn control_characters_do_not_shift_columns_and_short_titles_are_untouched() {
        let table = format!(
            "{:<38} {:<18} {:<13} {:<16} {}\n{}\n{:<38} {:<18} {:<13} {:<16} {ID_A}\n",
            "Preview",
            "Workspace",
            "Last Active",
            "Src",
            "ID",
            "─".repeat(110),
            "tab\there \u{1b}[1mbold",
            "home",
            "2h ago",
            "oneshot",
        );
        let rows = parse_session_table(&table);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].preview.as_deref(), Some("tab here  [1mbold"));
        assert_eq!(rows[0].workspace.as_deref(), Some("home"));
        assert_eq!(rows[0].last_active.as_deref(), Some("2h ago"));
        assert_eq!(rows[0].source.as_deref(), Some("oneshot"));
    }

    #[test]
    fn ignores_empty_listings_notices_and_malformed_rows() {
        assert!(parse_session_table("No sessions found.\n").is_empty());
        assert!(parse_session_table("").is_empty());
        assert!(parse_session_table("────\n").is_empty());
        let table = format!(
            "{:<28} {:<18} {:<13} {}\n{}\nshort row\n{:<28} {:<18} {:<13} bad id!\n\n",
            "Title",
            "Workspace",
            "Last Active",
            "ID",
            "─".repeat(110),
            "t",
            "w",
            "1m ago",
        );
        assert!(parse_session_table(&table).is_empty());
    }

    #[test]
    fn merge_labels_kinds_and_fills_previews() {
        let all = parse_session_table(&titled());
        let tasks = vec![Parsed {
            id: ID_A.into(),
            ..Parsed::default()
        }];
        let chats = vec![Parsed {
            id: ID_B.into(),
            preview: Some("What is 17 plus 25?".into()),
            source: Some("oneshot".into()),
            ..Parsed::default()
        }];
        let rows = merge(all, tasks, chats);
        assert_eq!(rows[0].kind, "task");
        assert_eq!(rows[1].kind, "chat");
        assert_eq!(rows[1].preview.as_deref(), Some("What is 17 plus 25?"));
        assert_eq!(rows[1].source.as_deref(), Some("oneshot"));
        let plain = merge(parse_session_table(&titled()), Vec::new(), Vec::new());
        assert!(plain.iter().all(|row| row.kind == "conversation"));
    }

    /// Read-only listing of a real profile's sessions. Needs no gateway. Run
    /// with `SHELLGUARDIAN_TEST_HERMES_SESSIONS=<profile> cargo test -p
    /// shellguardian live_sessions -- --ignored --nocapture`. Prints kinds and
    /// field presence only, never titles or previews.
    #[tokio::test]
    #[ignore = "requires SHELLGUARDIAN_TEST_HERMES_SESSIONS and an installed Hermes"]
    async fn live_sessions_listing_parses_real_output() {
        let profile = std::env::var("SHELLGUARDIAN_TEST_HERMES_SESSIONS")
            .expect("set SHELLGUARDIAN_TEST_HERMES_SESSIONS to a profile name");
        let rows = hermes_sessions(profile).await.unwrap();
        println!("{} sessions", rows.len());
        for row in &rows {
            println!(
                "  {:<12} id {}… title {} preview {} workspace {:?} last {:?} source {:?}",
                row.kind,
                &row.id[..row.id.len().min(14)],
                row.title.is_some(),
                row.preview.is_some(),
                row.workspace,
                row.last_active,
                row.source
            );
            assert!(valid_session_id(&row.id));
            assert!(row.title.is_some() || row.preview.is_some() || row.kind != "task");
        }
    }
}
