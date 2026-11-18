//! Local Hermes supervisor: discovery, opt-in profile onboarding, and chat.
//!
//! Runs only the installed `hermes` executable (and, for interactive setup,
//! the desktop's `x-terminal-emulator`) with fixed argument arrays. Never runs a
//! host shell, installs software, accepts programs or paths from the webview,
//! or reads Hermes credentials. Hermes children get a cleared environment so
//! provider keys exported in the user's desktop session are never picked up
//! and sent to whichever provider a profile defaults to.
use serde::Serialize;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;
use tauri_plugin_opener::OpenerExt;
use tokio::process::Command;

/// Official Hermes installation guide, opened in the user's browser.
const INSTALL_GUIDE: &str =
    "https://hermes-agent.nousresearch.com/docs/getting-started/installation/";
/// Upper bound on profile-list text returned to the webview.
const PROFILE_LIST_LIMIT: usize = 8192;
/// Upper bound on profiles parsed from the list.
const PROFILE_COUNT_LIMIT: usize = 64;
/// Non-interactive Hermes management calls must finish within this time.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
/// A supervisor turn may use tools; bound it generously but finitely.
const CHAT_TIMEOUT: Duration = Duration::from_secs(600);
/// Upper bound on one supervisor message, in bytes.
const MESSAGE_LIMIT: usize = 16 * 1024;
/// Upper bound on one supervisor reply returned to the webview, in characters.
const REPLY_LIMIT: usize = 128 * 1024;
/// Session tag so ShellGuardian conversations can be filtered in Hermes.
const SESSION_SOURCE: &str = "shellguardian";

/// Environment variables Hermes children may inherit. Everything else,
/// including provider API keys, is removed.
const HERMES_ENV_ALLOWLIST: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "HERMES_HOME",
];
/// Additional variables the setup terminal needs to open a window.
const TERMINAL_ENV_ALLOWLIST: &[&str] = &[
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_SESSION_TYPE",
    "XDG_CURRENT_DESKTOP",
];

/// One Hermes profile as reported by `hermes profile list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesProfile {
    name: String,
    /// Configured model, or `None` when Hermes shows none.
    model: Option<String>,
    /// Messaging gateway state as Hermes reports it, e.g. `running`/`stopped`.
    gateway: Option<String>,
    /// Hermes's sticky active profile.
    active: bool,
}

/// Read-only summary of the local Hermes installation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesDiscovery {
    installed: bool,
    installation: Option<String>,
    profiles: Vec<HermesProfile>,
    /// Sanitized raw list, for display when parsing finds nothing.
    profile_text: String,
}

/// One supervisor reply.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HermesReply {
    reply: String,
    session_id: Option<String>,
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

/// Finds Hermes in the per-user installer location, then in absolute `PATH`
/// entries. Relative or empty `PATH` entries are ignored so the current
/// directory can never supply the executable.
fn resolve_hermes(home: Option<&OsStr>, path: Option<&OsStr>) -> Option<PathBuf> {
    let user_install = home
        .map(PathBuf::from)
        .filter(|home| home.is_absolute())
        .map(|home| home.join(".local/bin/hermes"));
    let path_entries = path
        .map(|path| std::env::split_paths(path).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join("hermes"));
    user_install
        .into_iter()
        .chain(path_entries)
        .find(|candidate| is_executable_file(candidate))
}

fn hermes_path() -> Option<PathBuf> {
    resolve_hermes(
        std::env::var_os("HOME").as_deref(),
        std::env::var_os("PATH").as_deref(),
    )
}

/// Hermes's own profile identifier rule: `^[a-z0-9][a-z0-9_-]{0,63}$`.
fn valid_profile_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-'))
}

fn require_profile_name(name: &str) -> Result<(), String> {
    if valid_profile_name(name) {
        Ok(())
    } else {
        Err("Use 1 to 64 lowercase letters, digits, hyphens, or underscores, starting with a letter or digit.".into())
    }
}

/// Session IDs Hermes prints look like `20261118_060100_7999ca`.
fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

/// Removes terminal control characters from CLI text and bounds its length.
/// Newlines and tabs are preserved for readability.
fn sanitize_text(raw: &[u8], limit: usize) -> String {
    String::from_utf8_lossy(raw)
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .take(limit)
        .collect()
}

fn none_if_dash(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty() && *v != "—" && *v != "-")
        .map(str::to_owned)
}

/// Parses `hermes profile list`'s table. Columns are separated by runs of two
/// or more spaces; the active profile is prefixed with `◆`. Rows whose name is
/// not a valid profile identifier are skipped rather than guessed.
fn parse_profile_list(text: &str) -> Vec<HermesProfile> {
    let mut profiles = Vec::new();
    let mut in_rows = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('─') {
            in_rows = true;
            continue;
        }
        if !in_rows || trimmed.is_empty() {
            continue;
        }
        let columns: Vec<&str> = trimmed
            .split("  ")
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .collect();
        let Some(first) = columns.first() else {
            continue;
        };
        let active = first.starts_with('◆');
        let name = first.trim_start_matches('◆').trim();
        if !valid_profile_name(name) {
            continue;
        }
        profiles.push(HermesProfile {
            name: name.to_owned(),
            model: none_if_dash(columns.get(1).copied()),
            gateway: none_if_dash(columns.get(2).copied()),
            active,
        });
        if profiles.len() == PROFILE_COUNT_LIMIT {
            break;
        }
    }
    profiles
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

/// Picks a short, user-facing error from Hermes stderr: its `Error:` line if
/// present, bounded. Never returns whole stderr, which may include logs.
fn hermes_error(stderr: &str) -> String {
    stderr
        .lines()
        .find_map(|line| line.trim().strip_prefix("Error:"))
        .map(|detail| {
            let detail: String = detail.trim().chars().take(400).collect();
            format!("Hermes reported an error: {detail}")
        })
        .unwrap_or_else(|| "Hermes did not return a reply.".into())
}

/// Applies the cleared environment to a command.
fn scrub_env(command: &mut Command, allow: &[&[&str]]) {
    command.env_clear();
    for name in allow.iter().flat_map(|list| list.iter()) {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
}

fn hermes_command(binary: &Path) -> Command {
    let mut command = Command::new(binary);
    scrub_env(&mut command, &[HERMES_ENV_ALLOWLIST]);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

/// Arguments for one non-interactive supervisor turn. The message uses the
/// `--query=` form so text beginning with `-` is never parsed as a flag.
fn chat_args(profile: &str, message: &str, session_id: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "-p".to_owned(),
        profile.to_owned(),
        "chat".to_owned(),
        "-Q".to_owned(),
        format!("--source={SESSION_SOURCE}"),
        format!("--query={message}"),
    ];
    if let Some(id) = session_id {
        args.push(format!("--resume={id}"));
    }
    args
}

/// Arguments for launching interactive setup in a separate terminal window.
fn terminal_setup_args(binary: &Path, profile: &str) -> Vec<OsString> {
    vec![
        "-e".into(),
        binary.as_os_str().to_owned(),
        "-p".into(),
        profile.into(),
        "setup".into(),
    ]
}

async fn run_hermes(binary: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let child = hermes_command(binary).args(args).output();
    tokio::time::timeout(COMMAND_TIMEOUT, child)
        .await
        .map_err(|_| "The Hermes CLI did not respond in time.".to_string())?
        .map_err(|_| "Could not run the installed Hermes CLI.".to_string())
}

async fn list_profiles(binary: &Path) -> Result<(Vec<HermesProfile>, String), String> {
    let output = run_hermes(binary, &["profile", "list"]).await?;
    if !output.status.success() {
        return Err("Hermes could not list its profiles.".into());
    }
    let text = sanitize_text(&output.stdout, PROFILE_LIST_LIMIT);
    Ok((parse_profile_list(&text), text))
}

/// Reports whether Hermes is installed and lists its profiles. Read-only.
#[tauri::command]
pub async fn discover_hermes() -> Result<HermesDiscovery, String> {
    discover_with(hermes_path()).await
}

async fn discover_with(binary: Option<PathBuf>) -> Result<HermesDiscovery, String> {
    let Some(binary) = binary else {
        return Ok(HermesDiscovery {
            installed: false,
            installation: None,
            profiles: Vec::new(),
            profile_text: String::new(),
        });
    };
    let (profiles, profile_text) = list_profiles(&binary).await?;
    Ok(HermesDiscovery {
        installed: true,
        installation: Some(binary.to_string_lossy().into_owned()),
        profiles,
        profile_text,
    })
}

/// Creates a new, empty Hermes profile, refusing if it already exists. Never
/// clones another profile's configuration or credentials, and creates no
/// alias wrapper.
#[tauri::command]
pub async fn create_hermes_profile(name: String) -> Result<(), String> {
    require_profile_name(&name)?;
    let binary = hermes_path().ok_or("Hermes is not installed on this machine.")?;
    create_with(&binary, &name).await
}

async fn create_with(binary: &Path, name: &str) -> Result<(), String> {
    if run_hermes(binary, &["profile", "show", name])
        .await?
        .status
        .success()
    {
        return Err(format!(
            "A Hermes profile named {name} already exists. Refresh instead."
        ));
    }
    let output = run_hermes(binary, &["profile", "create", name, "--no-alias"]).await?;
    if !output.status.success() {
        return Err(format!(
            "Hermes could not create {name}. No existing profile was replaced."
        ));
    }
    Ok(())
}

/// Opens Hermes's interactive setup for a profile in the user's own terminal
/// so provider credentials never pass through the webview.
#[tauri::command]
pub async fn start_hermes_setup(profile: String) -> Result<(), String> {
    require_profile_name(&profile)?;
    let binary = hermes_path().ok_or("Install Hermes before starting setup.")?;
    #[cfg(target_os = "linux")]
    {
        let mut command = Command::new("x-terminal-emulator");
        scrub_env(
            &mut command,
            &[HERMES_ENV_ALLOWLIST, TERMINAL_ENV_ALLOWLIST],
        );
        let mut child = command
            .args(terminal_setup_args(&binary, &profile))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "Could not launch a terminal for Hermes setup.".to_string())?;
        // Reap the terminal when the user closes it; it outlives this call.
        tokio::spawn(async move {
            let _ = child.wait().await;
        });
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (binary, terminal_setup_args);
        Err("Interactive setup is currently supported on Linux only.".into())
    }
}

fn chat_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Sends one message to a Hermes profile and returns its reply. One turn runs
/// at a time. Dangerous commands fail closed: `HERMES_INTERACTIVE=1` with no
/// stdin makes Hermes's approval prompt read end-of-file and deny, instead of
/// its non-interactive default of auto-approving.
#[tauri::command]
pub async fn hermes_chat(
    profile: String,
    message: String,
    session_id: Option<String>,
) -> Result<HermesReply, String> {
    let binary = hermes_path().ok_or("Hermes is not installed on this machine.")?;
    chat_with(&binary, &profile, &message, session_id.as_deref()).await
}

async fn chat_with(
    binary: &Path,
    profile: &str,
    message: &str,
    session_id: Option<&str>,
) -> Result<HermesReply, String> {
    require_profile_name(profile)?;
    let message = message.trim();
    if message.is_empty() {
        return Err("Enter a message for the supervisor.".into());
    }
    if message.len() > MESSAGE_LIMIT || message.contains('\0') {
        return Err("That message is too long to send. Shorten it and try again.".into());
    }
    if let Some(id) = session_id {
        if !valid_session_id(id) {
            return Err("The conversation ID is not valid. Start a new conversation.".into());
        }
    }
    let Ok(_turn) = chat_lock().try_lock() else {
        return Err("The supervisor is still answering the previous message.".into());
    };
    let child = hermes_command(binary)
        .env("HERMES_INTERACTIVE", "1")
        .args(chat_args(profile, message, session_id))
        .output();
    let output = tokio::time::timeout(CHAT_TIMEOUT, child)
        .await
        .map_err(|_| {
            "The supervisor did not finish within 10 minutes and was stopped.".to_string()
        })?
        .map_err(|_| "Could not run the installed Hermes CLI.".to_string())?;
    let stderr = sanitize_text(&output.stderr, 64 * 1024);
    let session_id = parse_session_id(&stderr);
    let reply = sanitize_text(&output.stdout, REPLY_LIMIT).trim().to_owned();
    if !output.status.success() || reply.is_empty() {
        return Err(hermes_error(&stderr));
    }
    Ok(HermesReply { reply, session_id })
}

/// Opens the fixed official installation guide. Never accepts a URL from the
/// webview and never downloads or runs an installer.
#[tauri::command]
pub fn open_hermes_install_guide(app: tauri::AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(INSTALL_GUIDE, None::<&str>)
        .map_err(|_| "Could not open the Hermes installation guide.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// Serializes tests that take the process-wide one-turn chat lock.
    static TEST_CHAT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    const SAMPLE_LIST: &str = "\n Profile          Model                        Gateway      Alias        Distribution\n ───────────────  ───────────────────────────  ───────────  ───────────  ───────────\n ◆default         —                            stopped      —            —\n  guanyu          anthropic/claude-sonnet-4    running      —            —\n\n";

    fn write_file(path: &Path, mode: u32, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
        }
        #[cfg(not(unix))]
        let _ = mode;
    }

    #[test]
    fn prefers_per_user_install_over_path() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let bin = dir.path().join("bin");
        write_file(&home.join(".local/bin/hermes"), 0o755, "#!/bin/sh\n");
        write_file(&bin.join("hermes"), 0o755, "#!/bin/sh\n");
        let found = resolve_hermes(Some(home.as_os_str()), Some(bin.as_os_str()));
        assert_eq!(found, Some(home.join(".local/bin/hermes")));
    }

    #[test]
    fn falls_back_to_first_absolute_path_entry() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        write_file(&second.join("hermes"), 0o755, "#!/bin/sh\n");
        fs::create_dir_all(&first).unwrap();
        let path = std::env::join_paths([&first, &second]).unwrap();
        let found = resolve_hermes(Some(dir.path().join("nohome").as_os_str()), Some(&path));
        assert_eq!(found, Some(second.join("hermes")));
    }

    #[test]
    fn ignores_relative_and_empty_path_entries() {
        let path = OsString::from(":.:bin:relative/dir");
        assert_eq!(resolve_hermes(None, Some(&path)), None);
    }

    #[test]
    fn ignores_relative_home() {
        assert_eq!(
            resolve_hermes(Some(OsStr::new("relative-home")), None),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn ignores_non_executable_files_and_directories() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain");
        let nested = dir.path().join("nested");
        write_file(&plain.join("hermes"), 0o644, "#!/bin/sh\n");
        fs::create_dir_all(nested.join("hermes")).unwrap();
        let path = std::env::join_paths([&plain, &nested]).unwrap();
        assert_eq!(resolve_hermes(None, Some(&path)), None);
    }

    #[test]
    fn missing_environment_finds_nothing() {
        assert_eq!(resolve_hermes(None, None), None);
    }

    #[test]
    fn profile_names_follow_hermes_rule() {
        for ok in ["guanyu", "a", "0", "my-agent_2", &"a".repeat(64)] {
            assert!(valid_profile_name(ok), "{ok}");
        }
        for bad in [
            "",
            "-x",
            "_x",
            "Upper",
            "has space",
            "dot.name",
            "../x",
            "x/y",
            &"a".repeat(65),
            "--help",
            "é",
        ] {
            assert!(!valid_profile_name(bad), "{bad}");
        }
    }

    #[test]
    fn session_ids_are_restricted() {
        assert!(valid_session_id("20261118_060100_7999ca"));
        for bad in ["", "a b", "x;y", "../x", "a/b", &"a".repeat(129)] {
            assert!(!valid_session_id(bad), "{bad}");
        }
        // A leading dash is harmless: it is always passed as `--resume=<id>`.
        assert!(chat_args("p", "m", Some("--yolo")).contains(&"--resume=--yolo".to_owned()));
    }

    #[test]
    fn parses_profile_table() {
        let profiles = parse_profile_list(SAMPLE_LIST);
        assert_eq!(
            profiles,
            vec![
                HermesProfile {
                    name: "default".into(),
                    model: None,
                    gateway: Some("stopped".into()),
                    active: true,
                },
                HermesProfile {
                    name: "guanyu".into(),
                    model: Some("anthropic/claude-sonnet-4".into()),
                    gateway: Some("running".into()),
                    active: false,
                },
            ]
        );
    }

    #[test]
    fn profile_parser_skips_headers_and_invalid_rows() {
        let text = "Profile  Model\n────  ────\n Bad Name  x\n ../etc  y\n ok  z\n";
        let names: Vec<_> = parse_profile_list(text)
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, vec!["ok"]);
        assert!(parse_profile_list("no table here\n").is_empty());
    }

    #[test]
    fn profile_parser_is_bounded() {
        let mut text = String::from("──\n");
        for i in 0..200 {
            text.push_str(&format!(" p{i}  —  stopped\n"));
        }
        assert_eq!(parse_profile_list(&text).len(), PROFILE_COUNT_LIMIT);
    }

    #[test]
    fn text_strips_control_sequences() {
        let raw = b"default\n\x1b[31mguanyu\x1b[0m\tactive\r\n\x07";
        assert_eq!(
            sanitize_text(raw, PROFILE_LIST_LIMIT),
            "default\n[31mguanyu[0m\tactive\n"
        );
    }

    #[test]
    fn text_is_bounded_and_tolerates_invalid_utf8() {
        let mut raw = vec![0xff, 0xfe];
        raw.extend(std::iter::repeat_n(b'a', PROFILE_LIST_LIMIT * 2));
        let text = sanitize_text(&raw, PROFILE_LIST_LIMIT);
        assert_eq!(text.chars().count(), PROFILE_LIST_LIMIT);
        assert!(text.starts_with('\u{fffd}'));
    }

    #[test]
    fn session_id_comes_from_last_stderr_line() {
        let stderr = "warning\nsession_id: old_1\nmore\n\nsession_id: 20261118_060100_7999ca\n";
        assert_eq!(
            parse_session_id(stderr).as_deref(),
            Some("20261118_060100_7999ca")
        );
        assert_eq!(parse_session_id("session_id: bad id;rm\n"), None);
        assert_eq!(parse_session_id("nothing\n"), None);
    }

    #[test]
    fn errors_expose_only_the_bounded_error_line() {
        let stderr = format!(
            "  ⚠ some log line with /home/path\nError: Error code: 401 {}\n\nsession_id: x\n",
            "z".repeat(1000)
        );
        let message = hermes_error(&stderr);
        assert!(message.starts_with("Hermes reported an error: Error code: 401"));
        assert!(!message.contains("/home/path"));
        assert!(message.len() < 500);
        assert_eq!(hermes_error("log only\n"), "Hermes did not return a reply.");
    }

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
                "--source=shellguardian",
                "--query=--yolo -h",
                "--resume=20261118_060100_7999ca",
            ]
        );
        assert!(!args.iter().any(|a| a == "--yolo"));
        assert_eq!(chat_args("p", "hi", None).len(), 6);
    }

    #[test]
    fn install_guide_is_fixed_https_url() {
        assert!(INSTALL_GUIDE.starts_with("https://hermes-agent.nousresearch.com/"));
    }

    #[test]
    fn terminal_args_run_only_fixed_setup_command() {
        let args = terminal_setup_args(Path::new("/opt/hermes bin/hermes"), "scout");
        let expected: Vec<OsString> = ["-e", "/opt/hermes bin/hermes", "-p", "scout", "setup"]
            .into_iter()
            .map(OsString::from)
            .collect();
        assert_eq!(args, expected);
    }

    #[test]
    fn env_allowlist_excludes_credentials() {
        for name in HERMES_ENV_ALLOWLIST
            .iter()
            .chain(TERMINAL_ENV_ALLOWLIST.iter())
        {
            let upper = name.to_ascii_uppercase();
            assert!(
                !["KEY", "TOKEN", "SECRET", "PASSWORD"]
                    .iter()
                    .any(|w| upper.contains(w)),
                "{name}"
            );
        }
    }

    #[tokio::test]
    async fn discovery_without_hermes_reports_not_installed() {
        let found = discover_with(None).await.unwrap();
        assert!(!found.installed && found.profiles.is_empty() && found.installation.is_none());
    }

    #[tokio::test]
    async fn chat_rejects_invalid_input_before_running_anything() {
        let missing = Path::new("/nonexistent/hermes");
        for (profile, message, session) in [
            ("Bad", "hi", None),
            ("ok", "   ", None),
            ("ok", "a\0b", None),
            ("ok", "hi", Some("bad id")),
        ] {
            assert!(chat_with(missing, profile, message, session).await.is_err());
        }
        let long = "a".repeat(MESSAGE_LIMIT + 1);
        let error = chat_with(missing, "ok", &long, None).await.unwrap_err();
        assert!(error.contains("too long"));
    }

    /// A stub Hermes records its argv and environment, proving the chat call
    /// passes only allowlisted variables (so no provider key from the test
    /// runner's environment), fails closed on approvals, and parses the reply.
    #[cfg(unix)]
    #[tokio::test]
    async fn chat_scrubs_environment_and_fails_closed_on_approval() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("record");
        let stub = dir.path().join("hermes");
        write_file(
            &stub,
            0o700,
            &format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{rec}.args'\nenv > '{rec}.env'\nprintf 'Hello from \\033[1mHermes\\033[0m\\n'\nprintf 'log\\n\\nsession_id: 20261118_060100_7999ca\\n' >&2\n",
                rec = record.display()
            ),
        );
        let _serial = TEST_CHAT.lock().await;
        let reply = chat_with(&stub, "guanyu", "status?", None).await.unwrap();
        assert_eq!(
            reply,
            HermesReply {
                reply: "Hello from [1mHermes[0m".into(),
                session_id: Some("20261118_060100_7999ca".into()),
            }
        );
        let env = fs::read_to_string(format!("{}.env", record.display())).unwrap();
        assert!(env.lines().any(|l| l == "HERMES_INTERACTIVE=1"));
        for line in env.lines() {
            let name = line.split('=').next().unwrap();
            assert!(
                HERMES_ENV_ALLOWLIST.contains(&name)
                    || name == "HERMES_INTERACTIVE"
                    || name == "PWD"
                    || name == "SHLVL"
                    || name == "_",
                "unexpected variable {name}"
            );
        }
        let args = fs::read_to_string(format!("{}.args", record.display())).unwrap();
        assert_eq!(
            args,
            "-p\nguanyu\nchat\n-Q\n--source=shellguardian\n--query=status?\n"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn chat_failure_reports_error_line_and_concurrent_turns_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let failing = dir.path().join("failing");
        write_file(
            &failing,
            0o700,
            "#!/bin/sh\necho 'noise' >&2\necho 'Error: Invalid API key' >&2\necho 'session_id: s1' >&2\nexit 1\n",
        );
        let _serial = TEST_CHAT.lock().await;
        let error = chat_with(&failing, "guanyu", "hi", None).await.unwrap_err();
        assert_eq!(error, "Hermes reported an error: Invalid API key");

        let slow = dir.path().join("slow");
        write_file(&slow, 0o700, "#!/bin/sh\nsleep 1\necho done\n");
        let first = chat_with(&slow, "guanyu", "one", None);
        let second = async {
            tokio::time::sleep(Duration::from_millis(200)).await;
            chat_with(&slow, "guanyu", "two", None).await
        };
        let (first, second) = tokio::join!(first, second);
        assert_eq!(first.unwrap().reply, "done");
        assert!(second.unwrap_err().contains("still answering"));
    }

    /// Exercises discovery and creation against a real Hermes CLI named by
    /// `SHELLGUARDIAN_TEST_HERMES`, isolated in a temporary `HOME` and
    /// `HERMES_HOME`. Run with `cargo test -p shellguardian -- --ignored`.
    /// Performs no inference.
    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "requires SHELLGUARDIAN_TEST_HERMES"]
    async fn live_hermes_discovery_and_creation_are_isolated() {
        let real = std::env::var("SHELLGUARDIAN_TEST_HERMES")
            .expect("set SHELLGUARDIAN_TEST_HERMES to a Hermes executable");
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let hermes_home = dir.path().join("hermes-home");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&hermes_home).unwrap();
        let wrapper = dir.path().join("bin/hermes");
        write_file(
            &wrapper,
            0o700,
            &format!(
                "#!/bin/sh\nHOME='{}' HERMES_HOME='{}' exec '{}' \"$@\"\n",
                home.display(),
                hermes_home.display(),
                real
            ),
        );

        let before = discover_with(Some(wrapper.clone())).await.unwrap();
        assert!(before.installed);
        assert!(before.profiles.iter().any(|p| p.name == "default"));
        assert!(!before.profiles.iter().any(|p| p.name == "guanyu"));

        create_with(&wrapper, "guanyu").await.unwrap();
        let after = discover_with(Some(wrapper.clone())).await.unwrap();
        let guanyu = after.profiles.iter().find(|p| p.name == "guanyu").unwrap();
        assert_eq!(guanyu.model, None);
        assert_eq!(guanyu.gateway.as_deref(), Some("stopped"));
        assert!(hermes_home.join("profiles/guanyu").is_dir());
        assert!(!hermes_home.join("profiles/guanyu/.env").exists());
        assert!(
            !home.join(".local/bin/guanyu").exists(),
            "--no-alias wrote a wrapper"
        );

        let again = create_with(&wrapper, "guanyu").await.unwrap_err();
        assert!(again.contains("already exists"));
    }
}
