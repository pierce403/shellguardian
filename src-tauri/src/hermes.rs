//! Local Hermes discovery and opt-in GuanYu profile onboarding.
//!
//! Runs only the installed `hermes` executable (and, for interactive setup,
//! the desktop's `x-terminal-emulator`) with fixed argument arrays. Never runs a
//! host shell, installs software, accepts programs or paths from the webview,
//! or reads Hermes credentials.
use serde::Serialize;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri_plugin_opener::OpenerExt;
use tokio::process::Command;

/// Official Hermes installation guide, opened in the user's browser.
const INSTALL_GUIDE: &str =
    "https://hermes-agent.nousresearch.com/docs/getting-started/installation/";
/// Profile created and configured by the onboarding flow.
const PROFILE: &str = "guanyu";
/// Upper bound on profile-list text returned to the webview.
const PROFILE_LIST_LIMIT: usize = 8192;
/// Non-interactive Hermes calls must finish within this time.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);

/// Read-only summary of the local Hermes installation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesDiscovery {
    installed: bool,
    profile_exists: bool,
    profiles: String,
    installation: Option<String>,
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

/// Removes terminal control characters from CLI text before display and bounds
/// its length. Newlines and tabs are preserved for readability.
fn sanitize_profile_list(raw: &[u8]) -> String {
    String::from_utf8_lossy(raw)
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .take(PROFILE_LIST_LIMIT)
        .collect()
}

/// Arguments for launching interactive setup in a separate terminal window.
fn terminal_setup_args(binary: &Path) -> Vec<OsString> {
    vec![
        "-e".into(),
        binary.as_os_str().to_owned(),
        "-p".into(),
        PROFILE.into(),
        "setup".into(),
    ]
}

async fn run_hermes(binary: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let child = Command::new(binary)
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    tokio::time::timeout(COMMAND_TIMEOUT, child)
        .await
        .map_err(|_| "The Hermes CLI did not respond in time.".to_string())?
        .map_err(|_| "Could not run the installed Hermes CLI.".to_string())
}

async fn profile_exists(binary: &Path) -> Result<bool, String> {
    Ok(run_hermes(binary, &["profile", "show", PROFILE])
        .await?
        .status
        .success())
}

/// Reports whether Hermes is installed, its profile list, and whether GuanYu
/// already exists. Read-only.
#[tauri::command]
pub async fn discover_hermes() -> Result<HermesDiscovery, String> {
    discover_with(hermes_path()).await
}

async fn discover_with(binary: Option<PathBuf>) -> Result<HermesDiscovery, String> {
    let Some(binary) = binary else {
        return Ok(HermesDiscovery {
            installed: false,
            profile_exists: false,
            profiles: String::new(),
            installation: None,
        });
    };
    if !run_hermes(&binary, &["--version"]).await?.status.success() {
        return Err("The Hermes executable did not respond successfully.".into());
    }
    let profiles = run_hermes(&binary, &["profile", "list"]).await?;
    if !profiles.status.success() {
        return Err("Hermes could not list its profiles.".into());
    }
    Ok(HermesDiscovery {
        installed: true,
        profile_exists: profile_exists(&binary).await?,
        profiles: sanitize_profile_list(&profiles.stdout),
        installation: Some(binary.to_string_lossy().into_owned()),
    })
}

/// Creates the GuanYu profile, refusing if it already exists.
#[tauri::command]
pub async fn create_guanyu_profile() -> Result<(), String> {
    let binary = hermes_path().ok_or("Hermes is not installed on this machine.")?;
    create_with(&binary).await
}

async fn create_with(binary: &Path) -> Result<(), String> {
    if profile_exists(binary).await? {
        return Err("The GuanYu profile already exists. Refresh instead.".into());
    }
    let output = run_hermes(binary, &["profile", "create", PROFILE, "--no-alias"]).await?;
    if !output.status.success() {
        return Err("Hermes could not create GuanYu. No existing profile was replaced.".into());
    }
    Ok(())
}

/// Opens Hermes's interactive GuanYu setup in the user's own terminal so
/// provider credentials never pass through the webview.
#[tauri::command]
pub async fn start_guanyu_onboarding() -> Result<(), String> {
    let binary = hermes_path().ok_or("Install Hermes before starting setup.")?;
    #[cfg(target_os = "linux")]
    {
        let mut child = Command::new("x-terminal-emulator")
            .args(terminal_setup_args(&binary))
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

    fn write_file(path: &Path, mode: u32) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "#!/bin/sh\n").unwrap();
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
        write_file(&home.join(".local/bin/hermes"), 0o755);
        write_file(&bin.join("hermes"), 0o755);
        let found = resolve_hermes(Some(home.as_os_str()), Some(bin.as_os_str()));
        assert_eq!(found, Some(home.join(".local/bin/hermes")));
    }

    #[test]
    fn falls_back_to_first_absolute_path_entry() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        write_file(&second.join("hermes"), 0o755);
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
        write_file(&plain.join("hermes"), 0o644);
        fs::create_dir_all(nested.join("hermes")).unwrap();
        let path = std::env::join_paths([&plain, &nested]).unwrap();
        assert_eq!(resolve_hermes(None, Some(&path)), None);
    }

    #[test]
    fn missing_environment_finds_nothing() {
        assert_eq!(resolve_hermes(None, None), None);
    }

    #[test]
    fn profile_list_strips_control_sequences() {
        let raw = b"default\n\x1b[31mguanyu\x1b[0m\tactive\r\n\x07";
        assert_eq!(
            sanitize_profile_list(raw),
            "default\n[31mguanyu[0m\tactive\n"
        );
    }

    #[test]
    fn profile_list_is_bounded_and_tolerates_invalid_utf8() {
        let mut raw = vec![0xff, 0xfe];
        raw.extend(std::iter::repeat_n(b'a', PROFILE_LIST_LIMIT * 2));
        let text = sanitize_profile_list(&raw);
        assert_eq!(text.chars().count(), PROFILE_LIST_LIMIT);
        assert!(text.starts_with('\u{fffd}'));
    }

    #[test]
    fn install_guide_is_fixed_https_url() {
        assert!(INSTALL_GUIDE.starts_with("https://hermes-agent.nousresearch.com/"));
    }

    #[test]
    fn terminal_args_run_only_fixed_setup_command() {
        let args = terminal_setup_args(Path::new("/opt/hermes bin/hermes"));
        let expected: Vec<OsString> = ["-e", "/opt/hermes bin/hermes", "-p", "guanyu", "setup"]
            .into_iter()
            .map(OsString::from)
            .collect();
        assert_eq!(args, expected);
    }

    /// Exercises discovery and creation against a real Hermes CLI named by
    /// `SHELLGUARDIAN_TEST_HERMES`, isolated in a temporary `HOME` and
    /// `HERMES_HOME`. Run with `cargo test -p shellguardian -- --ignored`.
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
        fs::create_dir_all(wrapper.parent().unwrap()).unwrap();
        fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\nHOME='{}' HERMES_HOME='{}' exec '{}' \"$@\"\n",
                home.display(),
                hermes_home.display(),
                real
            ),
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
        }

        let before = discover_with(Some(wrapper.clone())).await.unwrap();
        assert!(before.installed);
        assert!(!before.profile_exists, "fresh home already had guanyu");
        assert!(!before.profiles.contains('\u{1b}'));

        create_with(&wrapper).await.unwrap();
        let after = discover_with(Some(wrapper.clone())).await.unwrap();
        assert!(after.profile_exists);
        assert!(after.profiles.contains("guanyu"));
        assert!(hermes_home.join("profiles/guanyu").is_dir());
        assert!(!hermes_home.join("profiles/guanyu/.env").exists());
        assert!(
            !home.join(".local/bin/guanyu").exists(),
            "--no-alias wrote a wrapper"
        );

        let again = create_with(&wrapper).await.unwrap_err();
        assert!(again.contains("already exists"));
    }

    #[tokio::test]
    async fn discovery_without_hermes_reports_not_installed() {
        let found = discover_with(None).await.unwrap();
        assert!(!found.installed && !found.profile_exists && found.installation.is_none());
    }
}
