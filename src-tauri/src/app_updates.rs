//! Signed ShellGuardian releases, separate from read-only OpenShell release checks.
//! Verified update bytes stay in memory and are applied only on normal close/restart.
use crate::preferences::{self, Preferences};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub app_version: String,
    pub enabled: bool,
    pub supported: bool,
    pub phase: String,
    pub latest_version: Option<String>,
    pub error: Option<String>,
}

struct Inner {
    status: UpdateStatus,
    generation: u64,
    pending: Option<(Update, Vec<u8>)>,
    mutations: usize,
    installing: bool,
}

#[derive(Clone)]
pub struct AppUpdates {
    inner: Arc<Mutex<Inner>>,
    job: Arc<tokio::sync::Mutex<()>>,
    path: PathBuf,
}

impl AppUpdates {
    pub fn new(app_version: String, path: PathBuf, supported: bool) -> Self {
        let (enabled, error) = match preferences::load(&path) {
            Ok(value) => (value.auto_update, None),
            Err(error) => (false, Some(error.to_owned())),
        };
        Self {
            inner: Arc::new(Mutex::new(Inner {
                status: UpdateStatus {
                    app_version,
                    enabled,
                    supported,
                    phase: if supported { "idle" } else { "unsupported" }.into(),
                    latest_version: None,
                    error,
                },
                generation: 0,
                pending: None,
                mutations: 0,
                installing: false,
            })),
            job: Arc::new(tokio::sync::Mutex::new(())),
            path,
        }
    }

    pub fn status(&self) -> UpdateStatus {
        self.inner
            .lock()
            .expect("update status lock")
            .status
            .clone()
    }

    fn fail(&self, generation: u64, message: &str) {
        let mut inner = self.inner.lock().expect("update status lock");
        if inner.generation == generation {
            inner.status.phase = "unavailable".into();
            inner.status.error = Some(message.into());
        }
    }

    /// Refuse lifecycle/provider/policy writes while a self-update is installing.
    pub fn mutation(&self) -> Result<MutationGuard, String> {
        let mut inner = self.inner.lock().expect("update status lock");
        if inner.installing {
            return Err(
                "ShellGuardian is updating. Wait until it restarts before changing agents.".into(),
            );
        }
        inner.mutations += 1;
        Ok(MutationGuard(self.clone()))
    }

    fn auto_install_on_close(&self) -> bool {
        let inner = self.inner.lock().expect("update status lock");
        inner.status.enabled
            && inner.pending.is_some()
            && preferences::load(&self.path).is_ok_and(|preferences| preferences.auto_update)
    }

    fn take_pending(&self) -> Result<(Update, Vec<u8>), String> {
        let mut inner = self.inner.lock().expect("update status lock");
        if inner.mutations > 0 {
            inner.status.error = Some(
                "An OpenShell change is still running. Wait before closing or restarting.".into(),
            );
            return Err(inner.status.error.clone().unwrap());
        }
        if inner.installing {
            return Err("An update is already installing.".into());
        }
        let pending = inner.pending.take().ok_or("No verified update is ready.")?;
        inner.installing = true;
        inner.status.phase = "installing".into();
        Ok(pending)
    }
}

pub struct MutationGuard(AppUpdates);
impl Drop for MutationGuard {
    fn drop(&mut self) {
        self.0.inner.lock().expect("update status lock").mutations -= 1;
    }
}

pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let status = app.state::<AppUpdates>().status();
            if status.enabled && status.supported {
                let _ = check(app.clone(), false, false).await;
            }
            tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
        }
    });
}

#[tauri::command]
pub fn get_shellguardian_update(state: tauri::State<'_, AppUpdates>) -> UpdateStatus {
    state.status()
}

#[tauri::command]
pub fn set_auto_update(app: AppHandle, enabled: bool) -> Result<UpdateStatus, String> {
    let state = app.state::<AppUpdates>();
    {
        let mut inner = state.inner.lock().expect("update status lock");
        if inner.installing {
            return Err("Wait for installation to finish.".into());
        }
        // Save first: a failed write must not claim the user's opt-out was persisted.
        preferences::save(
            &state.path,
            &Preferences {
                auto_update: enabled,
            },
        )?;
        inner.generation += 1;
        inner.status.enabled = enabled;
        inner.status.error = None;
        inner.pending = None;
        inner.status.phase = if inner.status.supported {
            "idle"
        } else {
            "unsupported"
        }
        .into();
    }
    let status = state.status();
    if enabled && status.supported {
        tauri::async_runtime::spawn(check(app, false, false));
    }
    Ok(status)
}

#[tauri::command]
pub async fn check_shellguardian_update(app: AppHandle) -> Result<UpdateStatus, String> {
    check(app, true, false).await
}

#[tauri::command]
pub async fn download_shellguardian_update(app: AppHandle) -> Result<UpdateStatus, String> {
    check(app, true, true).await
}

async fn check(app: AppHandle, manual: bool, force_download: bool) -> Result<UpdateStatus, String> {
    let state = app.state::<AppUpdates>().inner().clone();
    let _job = state.job.lock().await;
    let generation = {
        let mut inner = state.inner.lock().expect("update status lock");
        if !inner.status.supported
            || inner.installing
            || inner.pending.is_some()
            || (!manual && !inner.status.enabled)
        {
            return Ok(inner.status.clone());
        }
        inner.status.phase = "checking".into();
        inner.status.error = None;
        inner.generation
    };
    let result = async {
        let updater = app.updater_builder().timeout(Duration::from_secs(20)).build()
            .map_err(|_| "Could not initialize the signed updater.")?;
        let Some(mut update) = updater.check().await
            .map_err(|_| "Could not check ShellGuardian releases. Try again when online.")? else {
            let mut inner = state.inner.lock().expect("update status lock");
            if inner.generation == generation { inner.status.phase = "current".into(); }
            return Ok(());
        };
        // No frontend-controlled URL, downgrade channel, proxy, or trust key.
        if update.download_url.scheme() != "https"
            || update.download_url.host_str() != Some("github.com")
            || !update.download_url.path().starts_with("/pierce403/shellguardian/releases/download/v")
            || update.version.contains('-') {
            return Err("The release points outside ShellGuardian's stable signed channel.");
        }
        {
            let mut inner = state.inner.lock().expect("update status lock");
            if inner.generation != generation { return Ok(()); }
            inner.status.latest_version = Some(update.version.clone());
            if !inner.status.enabled && !force_download {
                inner.status.phase = "available".into();
                return Ok(());
            }
            inner.status.phase = "downloading".into();
        }
        update.timeout = Some(Duration::from_secs(180));
        // Cancellation drops the request; both the artifact and its signed version are verified.
        let download = update.download(|_, _| {}, || {});
        tokio::pin!(download);
        let bytes = loop {
            tokio::select! {
                result = &mut download => break result.map_err(|_| "Update download or signature verification failed. Nothing was installed.")?,
                _ = tokio::time::sleep(Duration::from_millis(250)) => {
                    if state.inner.lock().expect("update status lock").generation != generation { return Ok(()); }
                }
            }
        };
        let mut inner = state.inner.lock().expect("update status lock");
        if inner.generation == generation {
            inner.pending = Some((update.clone(), bytes));
            inner.status.phase = "ready".into();
        }
        Ok(())
    }.await;
    if let Err(message) = result {
        state.fail(generation, message);
    }
    Ok(state.status())
}

async fn install(app: AppHandle, restart: bool) -> Result<(), String> {
    let state = app.state::<AppUpdates>().inner().clone();
    let (update, bytes) = state.take_pending()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        update.restart_after_install(restart).install(bytes)
    })
    .await;
    if !matches!(result, Ok(Ok(()))) {
        let mut inner = state.inner.lock().expect("update status lock");
        inner.installing = false;
        inner.status.phase = "unavailable".into();
        inner.status.error = Some("Installation failed. Your current session is still open. Retry the download or close without updating.".into());
        return Err(inner.status.error.clone().unwrap());
    }
    if restart {
        app.request_restart();
    } else {
        app.exit(0);
    }
    Ok(())
}

#[tauri::command]
pub async fn restart_for_update(app: AppHandle) -> Result<(), String> {
    install(app, true).await
}

pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let state = window.state::<AppUpdates>();
        let mut inner = state.inner.lock().expect("update status lock");
        if inner.installing || inner.mutations > 0 {
            if inner.mutations > 0 {
                inner.status.error = Some(
                    "An OpenShell change is still running. Wait before closing or restarting."
                        .into(),
                );
            }
            api.prevent_close();
            return;
        }
        drop(inner);
        if state.auto_install_on_close() {
            api.prevent_close();
            let app = window.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = install(app, false).await;
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> (tempfile::TempDir, AppUpdates) {
        let dir = tempfile::tempdir().unwrap();
        let state = AppUpdates::new("0.2.0".into(), dir.path().join("preferences.json"), true);
        (dir, state)
    }
    #[test]
    fn defaults_on_but_never_installs_without_verified_bytes() {
        let (_dir, state) = state();
        assert!(state.status().enabled);
        assert!(!state.auto_install_on_close());
        assert!(state.take_pending().is_err());
    }
    #[test]
    fn mutation_guard_is_released_even_on_error_or_cancellation() {
        let (_dir, state) = state();
        let guard = state.mutation().unwrap();
        assert!(state
            .take_pending()
            .err()
            .unwrap()
            .contains("still running"));
        drop(guard);
        assert_eq!(state.inner.lock().unwrap().mutations, 0);
        state.inner.lock().unwrap().installing = true;
        assert!(state.mutation().is_err());
    }
    #[test]
    fn stale_download_failures_cannot_override_new_preferences() {
        let (_dir, state) = state();
        state.inner.lock().unwrap().generation += 1;
        state.fail(0, "old failure");
        assert!(state.status().error.is_none());
    }
    #[test]
    fn unreadable_preferences_fail_closed() {
        let (dir, _) = state();
        std::fs::write(dir.path().join("preferences.json"), "broken").unwrap();
        let state = AppUpdates::new("0.2.0".into(), dir.path().join("preferences.json"), true);
        assert!(!state.status().enabled);
        assert!(state.status().error.is_some());
    }
}
