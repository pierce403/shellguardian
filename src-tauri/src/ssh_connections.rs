//! Native IPC exposes transport metadata, never SSH credentials or endpoint overrides.

use crate::app_updates::AppUpdates;
use crate::terminal_sessions::TerminalSessions;
use openshell_bridge::{
    model::{SshConnection, SshConnectionRequest},
    ssh::SshConnections,
    Error,
};

#[tauri::command]
pub async fn connect_ssh_gateway(
    updates: tauri::State<'_, AppUpdates>,
    connections: tauri::State<'_, SshConnections>,
    request: SshConnectionRequest,
) -> Result<SshConnection, Error> {
    let _guard = updates.mutation().map_err(Error::new)?;
    connections.connect(request).await
}

#[tauri::command]
pub async fn get_ssh_connections(
    connections: tauri::State<'_, SshConnections>,
) -> Result<Vec<SshConnection>, Error> {
    Ok(connections.list().await)
}

#[tauri::command]
pub async fn disconnect_ssh_gateway(
    updates: tauri::State<'_, AppUpdates>,
    connections: tauri::State<'_, SshConnections>,
    terminals: tauri::State<'_, TerminalSessions>,
    connection_id: String,
) -> Result<(), Error> {
    let _guard = updates.mutation().map_err(Error::new)?;
    openshell_bridge::validate_name(&connection_id)?;
    terminals.close_for_connection(&connection_id).await;
    connections.disconnect(&connection_id).await
}
