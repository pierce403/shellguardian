//! Local Hermes discovery and opt-in profile onboarding.
//! Never runs a host shell, installs software, or reads Hermes credentials.
use serde::Serialize;
use std::path::PathBuf;
use tokio::process::Command;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesDiscovery {
    installed: bool,
    profile_exists: bool,
    profiles: String,
    installation: Option<String>,
}

fn hermes_path() -> Option<PathBuf> {
    // The normal per-user Hermes installer puts its launcher here.
    if let Some(home) = std::env::var_os("HOME") {
        let path = PathBuf::from(home).join(".local/bin/hermes");
        if path.is_file() {
            return Some(path);
        }
    }
    // PATH resolution remains owned by the OS, not the webview.
    std::env::var_os("PATH")?.to_string_lossy().split(':')
        .filter(|part| !part.is_empty())
        .map(|part| PathBuf::from(part).join("hermes"))
        .find(|path| path.is_file())
}

async fn run_hermes(args: &[&str]) -> Result<std::process::Output, String> {
    let binary = hermes_path().ok_or("Hermes is not installed on this machine.")?;
    Command::new(binary).args(args).kill_on_drop(true).output().await
        .map_err(|_| "Could not run the installed Hermes CLI.".to_string())
}

#[tauri::command]
pub async fn discover_hermes() -> Result<HermesDiscovery, String> {
    let Some(binary) = hermes_path() else {
        return Ok(HermesDiscovery { installed: false, profile_exists: false,
            profiles: String::new(), installation: None });
    };
    let version = Command::new(&binary).arg("--version").kill_on_drop(true).output().await
        .map_err(|_| "Could not inspect the Hermes installation.")?;
    if !version.status.success() {
        return Err("The Hermes executable did not respond successfully.".into());
    }
    let profiles = run_hermes(&["profile", "list"]).await?;
    if !profiles.status.success() {
        return Err("Hermes could not list its profiles.".into());
    }
    let guanyu = run_hermes(&["profile", "show", "guanyu"]).await?;
    let output = String::from_utf8_lossy(&profiles.stdout);
    Ok(HermesDiscovery {
        installed: true,
        profile_exists: guanyu.status.success(),
        profiles: output.chars().take(8192).collect(),
        installation: Some(binary.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
pub async fn create_guanyu_profile() -> Result<(), String> {
    if run_hermes(&["profile", "show", "guanyu"]).await?.status.success() {
        return Err("The GuanYu profile already exists. Refresh instead.".into());
    }
    let output = run_hermes(&["profile", "create", "guanyu", "--no-alias"]).await?;
    if !output.status.success() {
        return Err("Hermes could not create GuanYu. No existing profile was replaced.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn start_guanyu_onboarding() -> Result<(), String> {
    let binary = hermes_path().ok_or("Install Hermes before starting setup.")?;
    // Interactive OAuth/provider setup stays in the user's own terminal, not
    // the webview. Never pipe user-supplied commands through a shell.
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("x-terminal-emulator")
            .arg("-e").arg(binary).args(["-p", "guanyu", "setup"])
            .spawn().map_err(|_| "Could not launch a terminal for Hermes setup.".to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = binary;
        Err("Interactive setup is currently supported on Linux only.".into())
    }
}
