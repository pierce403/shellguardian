//! Local Hermes supervisor: installation, discovery, profiles, setup, and chat.
//!
//! Runs only the installed `hermes` executable with fixed argument arrays, plus
//! one user-confirmed exception: Hermes's official installer script, downloaded
//! from a fixed HTTPS URL, shown to the user with its SHA-256, and run with
//! `/bin/bash` in an in-app terminal only for that exact hash. The webview never
//! supplies a program, path, URL, or environment, and ShellGuardian never reads
//! Hermes credentials. Hermes children get a cleared environment so provider
//! keys exported in the user's desktop session are never picked up and sent to
//! whichever provider a profile defaults to.
use crate::terminal_sessions::{dimensions, TerminalSession, TerminalSessions};
use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri_plugin_opener::OpenerExt;
use tokio::process::Command;

/// Hermes's official POSIX installer. Unversioned and unsigned upstream, so
/// every run is bound to the SHA-256 the user was shown.
const INSTALL_SCRIPT_URL: &str = "https://hermes-agent.nousresearch.com/install.sh";
/// Upper bound on the downloaded installer, in bytes.
const INSTALL_SCRIPT_LIMIT: usize = 512 * 1024;
/// Official Hermes installation guide, opened in the user's browser.
const INSTALL_GUIDE: &str =
    "https://hermes-agent.nousresearch.com/docs/getting-started/installation/";
/// Upper bound on profile-list text returned to the webview.
const PROFILE_LIST_LIMIT: usize = 8192;
/// Upper bound on profiles parsed from the list.
const PROFILE_COUNT_LIMIT: usize = 64;
/// Non-interactive Hermes management calls must finish within this time.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
/// Environment variables Hermes children may inherit. Everything else,
/// including provider API keys, is removed.
pub(crate) const HERMES_ENV_ALLOWLIST: &[&str] = &[
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
    /// Inference provider from `hermes profile show`, e.g. `openai-codex`.
    /// `auto` means none was chosen and Hermes falls back to its placeholder
    /// OpenRouter default. `None` when unknown.
    provider: Option<String>,
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

pub(crate) fn hermes_path() -> Option<PathBuf> {
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

pub(crate) fn require_profile_name(name: &str) -> Result<(), String> {
    if valid_profile_name(name) {
        Ok(())
    } else {
        Err("Use 1 to 64 lowercase letters, digits, hyphens, or underscores, starting with a letter or digit.".into())
    }
}

/// Session IDs Hermes prints look like `20261118_060100_7999ca`.
pub(crate) fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

/// Removes terminal control characters from CLI text and bounds its length.
/// Newlines and tabs are preserved for readability.
pub(crate) fn sanitize_text(raw: &[u8], limit: usize) -> String {
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
            provider: None,
        });
        if profiles.len() == PROFILE_COUNT_LIMIT {
            break;
        }
    }
    profiles
}

/// Extracts the provider from `hermes profile show`'s `Model: <model> (<provider>)`
/// line. Only a short, plain token is accepted.
fn parse_provider(show: &str) -> Option<String> {
    let line = show
        .lines()
        .find_map(|line| line.trim().strip_prefix("Model:"))?
        .trim();
    let provider = line.strip_suffix(')')?.rsplit_once('(')?.1.trim();
    (!provider.is_empty()
        && provider.len() <= 64
        && provider
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/')))
    .then(|| provider.to_owned())
}

/// Profiles whose provider is looked up per discovery; the rest stay unknown.
const PROVIDER_LOOKUP_LIMIT: usize = 16;

/// Fills each profile's provider by running `hermes profile show` concurrently.
/// A failed lookup leaves the provider unknown rather than failing discovery.
async fn fill_providers(binary: &Path, profiles: &mut [HermesProfile]) {
    let mut lookups = tokio::task::JoinSet::new();
    for (index, profile) in profiles.iter().enumerate().take(PROVIDER_LOOKUP_LIMIT) {
        let binary = binary.to_owned();
        let name = profile.name.clone();
        lookups.spawn(async move {
            let output = run_hermes(&binary, &["profile", "show", &name])
                .await
                .ok()?;
            output
                .status
                .success()
                .then(|| parse_provider(&sanitize_text(&output.stdout, PROFILE_LIST_LIMIT)))
                .flatten()
                .map(|provider| (index, provider))
        });
    }
    while let Some(result) = lookups.join_next().await {
        if let Ok(Some((index, provider))) = result {
            profiles[index].provider = Some(provider);
        }
    }
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

/// A Hermes CLI command with the cleared environment, no stdin, and the
/// user's home as its working directory. Hermes records the working directory
/// as a session's workspace and runs an agent's tools there, so it must not be
/// wherever the desktop app happened to be launched.
pub(crate) fn hermes_command(binary: &Path) -> Command {
    let mut command = Command::new(binary);
    scrub_env(&mut command, &[HERMES_ENV_ALLOWLIST]);
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        if home.is_absolute() && home.is_dir() {
            command.current_dir(home);
        }
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
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
    let (mut profiles, profile_text) = list_profiles(&binary).await?;
    fill_providers(&binary, &mut profiles).await;
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

/// Builds a PTY command with the same cleared environment as other Hermes
/// children, plus a terminal type for the in-app emulator.
fn pty_command(program: &Path, args: &[&OsStr]) -> CommandBuilder {
    let mut command = CommandBuilder::new(program);
    command.args(args);
    command.env_clear();
    for name in HERMES_ENV_ALLOWLIST {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command.env("TERM", "xterm-256color");
    if let Some(home) = std::env::var_os("HOME").filter(|h| Path::new(h).is_absolute()) {
        command.cwd(home);
    }
    command
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Accepts only a bounded, UTF-8, `#!`-prefixed script without NUL bytes.
fn validate_installer(bytes: &[u8]) -> Result<&str, String> {
    if bytes.is_empty() || bytes.len() > INSTALL_SCRIPT_LIMIT {
        return Err("The Hermes installer download had an unexpected size.".into());
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "The Hermes installer download was not a text script.".to_string())?;
    if !text.starts_with("#!") || text.contains('\0') {
        return Err("The Hermes installer download was not a shell script.".into());
    }
    Ok(text)
}

struct StagedInstaller {
    /// Owner-only directory; dropping it removes the script.
    _dir: tempfile::TempDir,
    path: PathBuf,
    sha256: String,
}

/// Holds at most one downloaded installer, in memory and a private temp dir.
#[derive(Default)]
pub struct HermesInstaller {
    staged: tokio::sync::Mutex<Option<StagedInstaller>>,
}

/// What the user reviews before choosing to run the installer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallerPreview {
    url: &'static str,
    sha256: String,
    size: usize,
    script: String,
}

async fn download_installer() -> Result<Vec<u8>, String> {
    let failed = || "Could not download the Hermes installer. Check your connection and try again.";
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .user_agent("ShellGuardian")
        .build()
        .map_err(|_| failed().to_string())?;
    let mut response = client
        .get(INSTALL_SCRIPT_URL)
        .send()
        .await
        .map_err(|_| failed().to_string())?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!(
            "The Hermes installer URL returned HTTP {}. Nothing was run.",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|len| len > INSTALL_SCRIPT_LIMIT as u64)
    {
        return Err("The Hermes installer download had an unexpected size.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| failed().to_string())? {
        if bytes.len() + chunk.len() > INSTALL_SCRIPT_LIMIT {
            return Err("The Hermes installer download had an unexpected size.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn stage_installer(bytes: &[u8]) -> Result<StagedInstaller, String> {
    validate_installer(bytes)?;
    let failed = |_| "Could not save the Hermes installer privately.".to_string();
    let mut builder = tempfile::Builder::new();
    builder.prefix("shellguardian-hermes-");
    // Owner-only at creation, independent of the process umask.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    let dir = builder.tempdir().map_err(failed)?;
    let path = dir.path().join("install.sh");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    options
        .open(&path)
        .and_then(|mut file| file.write_all(bytes).and_then(|_| file.sync_all()))
        .map_err(failed)?;
    Ok(StagedInstaller {
        _dir: dir,
        path,
        sha256: sha256_hex(bytes),
    })
}

/// Downloads Hermes's official installer for review. Nothing runs until the
/// user starts it for this exact SHA-256.
#[tauri::command]
pub async fn prepare_hermes_installer(
    installer: tauri::State<'_, HermesInstaller>,
) -> Result<InstallerPreview, String> {
    if hermes_path().is_some() {
        return Err("Hermes is already installed. Refresh instead.".into());
    }
    let bytes = download_installer().await?;
    let staged = stage_installer(&bytes)?;
    let preview = InstallerPreview {
        url: INSTALL_SCRIPT_URL,
        sha256: staged.sha256.clone(),
        size: bytes.len(),
        script: String::from_utf8_lossy(&bytes).into_owned(),
    };
    *installer.staged.lock().await = Some(staged);
    Ok(preview)
}

/// A fixed Hermes action for the in-app terminal.
#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum HermesTerminalAction {
    /// Run the staged official installer, only if its hash still matches.
    Install { sha256: String },
    /// Run `hermes -p <profile> setup`.
    Setup { profile: String },
    /// Run `hermes -p <profile> setup model` to choose only the provider and model.
    Model { profile: String },
}

/// Re-reads the staged script and builds its command only if it is byte for
/// byte the script the user reviewed.
fn installer_command(staged: &StagedInstaller, confirmed: &str) -> Result<CommandBuilder, String> {
    if staged.sha256 != confirmed {
        return Err("The installer changed since you reviewed it. Download it again.".into());
    }
    let bytes = std::fs::read(&staged.path).map_err(|_| {
        "The reviewed installer is no longer available. Download it again.".to_string()
    })?;
    if sha256_hex(&bytes) != confirmed {
        return Err("The installer changed since you reviewed it. Download it again.".into());
    }
    // Setup runs afterwards, per profile, in this same in-app terminal.
    Ok(pty_command(
        Path::new("/bin/bash"),
        &[staged.path.as_os_str(), OsStr::new("--skip-setup")],
    ))
}

fn setup_command(binary: &Path, profile: &str) -> Result<CommandBuilder, String> {
    require_profile_name(profile)?;
    Ok(pty_command(
        binary,
        &[OsStr::new("-p"), OsStr::new(profile), OsStr::new("setup")],
    ))
}

fn model_command(binary: &Path, profile: &str) -> Result<CommandBuilder, String> {
    require_profile_name(profile)?;
    Ok(pty_command(
        binary,
        &[
            OsStr::new("-p"),
            OsStr::new(profile),
            OsStr::new("setup"),
            OsStr::new("model"),
        ],
    ))
}

/// Opens an in-app terminal for a fixed Hermes action. Interactive output may
/// include sensitive setup details; like sandbox terminals it is shown but
/// never logged or persisted, and ShellGuardian never reads stored keys.
#[tauri::command]
pub async fn open_hermes_terminal(
    window: tauri::WebviewWindow,
    terminals: tauri::State<'_, TerminalSessions>,
    installer: tauri::State<'_, HermesInstaller>,
    action: HermesTerminalAction,
    cols: u16,
    rows: u16,
) -> openshell_bridge::Result<TerminalSession> {
    use openshell_bridge::Error;
    let size = dimensions(cols, rows)?;
    let (command, start_error) = match action {
        HermesTerminalAction::Install { sha256 } => {
            if hermes_path().is_some() {
                return Err(Error::new("Hermes is already installed. Refresh instead."));
            }
            let staged = installer.staged.lock().await;
            let staged = staged
                .as_ref()
                .ok_or_else(|| Error::new("Download the Hermes installer before running it."))?;
            (
                installer_command(staged, &sha256).map_err(Error::new)?,
                "Could not start the Hermes installer with /bin/bash.",
            )
        }
        HermesTerminalAction::Setup { profile } => {
            let binary = hermes_path()
                .ok_or_else(|| Error::new("Hermes is not installed on this machine."))?;
            (
                setup_command(&binary, &profile).map_err(Error::new)?,
                "Could not start Hermes setup.",
            )
        }
        HermesTerminalAction::Model { profile } => {
            let binary = hermes_path()
                .ok_or_else(|| Error::new("Hermes is not installed on this machine."))?;
            (
                model_command(&binary, &profile).map_err(Error::new)?,
                "Could not start Hermes provider setup.",
            )
        }
    };
    terminals
        .open_local(window.label(), command, size, start_error)
        .await
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
    use std::ffi::OsString;
    use std::fs;

    const SAMPLE_LIST: &str = "\n Profile          Model                        Gateway      Alias        Distribution\n ───────────────  ───────────────────────────  ───────────  ───────────  ───────────\n ◆default         —                            stopped      —            —\n  guanyu          anthropic/claude-sonnet-4    running      —            —\n\n";

    fn write_file(path: &Path, mode: u32, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        // Executables are written by a child process; see `write_script`.
        #[cfg(unix)]
        if mode & 0o111 != 0 {
            crate::test_support::write_script(path, body);
        } else {
            use std::os::unix::fs::PermissionsExt;
            fs::write(path, body).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
        }
        #[cfg(not(unix))]
        {
            let _ = mode;
            fs::write(path, body).unwrap();
        }
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
                    provider: None,
                },
                HermesProfile {
                    name: "guanyu".into(),
                    model: Some("anthropic/claude-sonnet-4".into()),
                    gateway: Some("running".into()),
                    active: false,
                    provider: None,
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
    fn install_guide_is_fixed_https_url() {
        assert!(INSTALL_GUIDE.starts_with("https://hermes-agent.nousresearch.com/"));
    }

    #[test]
    fn installer_validation_rejects_non_scripts() {
        assert!(validate_installer(b"#!/bin/sh\necho hi\n").is_ok());
        assert!(validate_installer(b"").is_err());
        assert!(validate_installer(b"<html>not a script</html>").is_err());
        assert!(validate_installer(b"#!/bin/sh\n\0").is_err());
        assert!(validate_installer(&[b'#', b'!', 0xff, 0xfe]).is_err());
        let mut big = b"#!/bin/sh\n".to_vec();
        big.resize(INSTALL_SCRIPT_LIMIT + 1, b'#');
        assert!(validate_installer(&big).is_err());
        assert!(INSTALL_SCRIPT_URL.starts_with("https://hermes-agent.nousresearch.com/"));
    }

    #[cfg(unix)]
    #[test]
    fn staged_installer_is_private_and_bound_to_its_hash() {
        use std::os::unix::fs::PermissionsExt;
        let script = b"#!/bin/sh\necho install\n";
        let staged = stage_installer(script).unwrap();
        assert_eq!(staged.sha256, sha256_hex(script));
        assert_eq!(
            fs::metadata(&staged.path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(staged.path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert!(installer_command(&staged, "0".repeat(64).as_str()).is_err());
        let command = installer_command(&staged, &staged.sha256).unwrap();
        let argv: Vec<_> = command
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            argv,
            vec![
                "/bin/bash".to_owned(),
                staged.path.to_string_lossy().into_owned(),
                "--skip-setup".to_owned()
            ]
        );
        // Tampering after review is refused even with the reviewed hash.
        fs::write(&staged.path, b"#!/bin/sh\necho evil\n").unwrap();
        assert!(installer_command(&staged, &staged.sha256).is_err());
        let dir = staged.path.parent().unwrap().to_owned();
        drop(staged);
        assert!(!dir.exists());
    }

    #[test]
    fn setup_command_is_fixed_and_env_is_scrubbed() {
        assert!(setup_command(Path::new("/usr/bin/hermes"), "Bad Name").is_err());
        let command = setup_command(Path::new("/opt/hermes bin/hermes"), "scout").unwrap();
        let argv: Vec<_> = command
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(argv, vec!["/opt/hermes bin/hermes", "-p", "scout", "setup"]);
        assert_eq!(
            command.get_env("TERM").map(|v| v.to_owned()),
            Some("xterm-256color".into())
        );
        assert_eq!(command.get_env("OPENAI_API_KEY"), None);
        assert_eq!(command.get_env("SHELLGUARDIAN_UNLISTED_TEST_VAR"), None);
    }

    #[test]
    fn model_command_is_fixed() {
        assert!(model_command(Path::new("/usr/bin/hermes"), "../x").is_err());
        let command = model_command(Path::new("/usr/bin/hermes"), "scout").unwrap();
        let argv: Vec<_> = command
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            argv,
            vec!["/usr/bin/hermes", "-p", "scout", "setup", "model"]
        );
        assert_eq!(command.get_env("OPENAI_API_KEY"), None);
        let action: HermesTerminalAction =
            serde_json::from_str(r#"{"action":"model","profile":"scout"}"#).unwrap();
        assert!(matches!(action, HermesTerminalAction::Model { profile } if profile == "scout"));
    }

    #[test]
    fn parses_provider_from_profile_show() {
        let show = "\nProfile: guanyu\nPath:    /home/x/.hermes/profiles/guanyu\nModel:   anthropic/claude-opus-4.6 (auto)\nGateway: stopped\n";
        assert_eq!(parse_provider(show), Some("auto".into()));
        assert_eq!(
            parse_provider("Model: gpt-5.5 (openai-codex)\n"),
            Some("openai-codex".into())
        );
        assert_eq!(parse_provider("Model: —\n"), None);
        assert_eq!(parse_provider("Model: x (two words)\n"), None);
        assert_eq!(parse_provider("Gateway: stopped\n"), None);
    }

    #[test]
    fn terminal_actions_deserialize_strictly() {
        let install: HermesTerminalAction =
            serde_json::from_str(r#"{"action":"install","sha256":"ab"}"#).unwrap();
        assert!(matches!(install, HermesTerminalAction::Install { sha256 } if sha256 == "ab"));
        let setup: HermesTerminalAction =
            serde_json::from_str(r#"{"action":"setup","profile":"scout"}"#).unwrap();
        assert!(matches!(setup, HermesTerminalAction::Setup { profile } if profile == "scout"));
        assert!(serde_json::from_str::<HermesTerminalAction>(
            r#"{"action":"run","program":"/bin/sh"}"#
        )
        .is_err());
    }

    #[test]
    fn env_allowlist_excludes_credentials() {
        for name in HERMES_ENV_ALLOWLIST {
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

    /// Downloads the real official installer and stages it, never running it.
    /// Run with `cargo test -p shellguardian live_installer -- --ignored`.
    #[tokio::test]
    #[ignore = "network: downloads the official Hermes installer"]
    async fn live_installer_download_is_valid_and_staged() {
        let bytes = download_installer().await.unwrap();
        let text = validate_installer(&bytes).unwrap();
        assert!(
            text.contains("--skip-setup"),
            "installer no longer supports --skip-setup"
        );
        let staged = stage_installer(&bytes).unwrap();
        assert_eq!(staged.sha256.len(), 64);
        assert!(installer_command(&staged, &staged.sha256).is_ok());
        println!("installer {} bytes sha256 {}", bytes.len(), staged.sha256);
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
