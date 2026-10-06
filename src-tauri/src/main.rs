#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use openshell_bridge::{model::*, process::ProcessRunner, Bridge, Error};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

fn bridge() -> Bridge<ProcessRunner> {
    Bridge::new(ProcessRunner::default())
}

#[tauri::command]
async fn get_snapshot(selection: Selection) -> Result<Snapshot, Error> {
    bridge().snapshot(selection).await
}

#[tauri::command]
async fn get_agent_detail(scope: Scope, name: String) -> Result<AgentDetail, Error> {
    bridge().detail(&scope, &name).await
}

#[tauri::command]
async fn get_agent_logs(scope: Scope, name: String) -> Result<String, Error> {
    bridge().logs(&scope, &name).await
}

#[tauri::command]
async fn change_agent_state(
    scope: Scope,
    name: String,
    action: LifecycleAction,
) -> Result<String, Error> {
    bridge().lifecycle(&scope, &name, action).await
}

#[tauri::command]
async fn change_provider_access(
    scope: Scope,
    name: String,
    provider: String,
    action: ProviderAction,
) -> Result<String, Error> {
    bridge()
        .provider_change(&scope, &name, &provider, action)
        .await
}

#[tauri::command]
async fn apply_agent_policy(edit: PolicyEdit) -> Result<String, Error> {
    bridge().apply_policy(edit).await
}

#[tauri::command]
async fn check_openshell_updates() -> Result<UpdateInfo, Error> {
    let installed = bridge().installed_version().await.ok();
    Ok(openshell_bridge::check_updates(installed).await)
}

#[tauri::command]
fn open_openshell_releases(app: tauri::AppHandle) -> Result<(), Error> {
    // A fixed upstream URL, never an arbitrary frontend-provided URL or program.
    app.opener()
        .open_url("https://github.com/NVIDIA/OpenShell/releases", None::<&str>)
        .map_err(|_| Error::new("Could not open the official releases page."))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            get_agent_detail,
            get_agent_logs,
            change_agent_state,
            change_provider_access,
            apply_agent_policy,
            check_openshell_updates,
            open_openshell_releases
        ])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("configured main window");
            window.set_title("ShellGuardian")?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("could not run ShellGuardian");
}
