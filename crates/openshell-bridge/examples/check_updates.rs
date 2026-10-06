//! Read-only check of the installed CLI and NVIDIA's official latest release.
use openshell_bridge::{check_updates, process::ProcessRunner, Bridge};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let installed = Bridge::new(ProcessRunner::default())
        .installed_version()
        .await
        .ok();
    println!(
        "{}",
        serde_json::to_string_pretty(&check_updates(installed).await)?
    );
    Ok(())
}
