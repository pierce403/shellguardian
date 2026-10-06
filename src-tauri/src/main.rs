#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use openshell_bridge::{model::*, process::ProcessRunner, Bridge, Error};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
mod app_updates;
mod preferences;
use app_updates::AppUpdates;

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
    updates: tauri::State<'_, AppUpdates>,
    scope: Scope,
    name: String,
    action: LifecycleAction,
) -> Result<String, Error> {
    let _guard = updates.mutation().map_err(Error::new)?;
    bridge().lifecycle(&scope, &name, action).await
}

#[tauri::command]
async fn change_provider_access(
    updates: tauri::State<'_, AppUpdates>,
    scope: Scope,
    name: String,
    provider: String,
    action: ProviderAction,
) -> Result<String, Error> {
    let _guard = updates.mutation().map_err(Error::new)?;
    bridge()
        .provider_change(&scope, &name, &provider, action)
        .await
}

#[tauri::command]
async fn apply_agent_policy(
    updates: tauri::State<'_, AppUpdates>,
    edit: PolicyEdit,
) -> Result<String, Error> {
    let _guard = updates.mutation().map_err(Error::new)?;
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_window_event(app_updates::on_window_event)
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            get_agent_detail,
            get_agent_logs,
            change_agent_state,
            change_provider_access,
            apply_agent_policy,
            check_openshell_updates,
            open_openshell_releases,
            app_updates::get_shellguardian_update,
            app_updates::set_auto_update,
            app_updates::check_shellguardian_update,
            app_updates::download_shellguardian_update,
            app_updates::restart_for_update
        ])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .expect("configured main window");
            window.set_title("ShellGuardian")?;
            let path = app.path().app_config_dir()?.join("preferences.json");
            let supported = !cfg!(debug_assertions)
                && (!cfg!(target_os = "linux") || app.env().appimage.is_some());
            app.manage(AppUpdates::new(
                app.package_info().version.to_string(),
                path,
                supported,
            ));
            app_updates::start(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("could not run ShellGuardian");
}
