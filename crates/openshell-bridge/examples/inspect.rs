//! Read-only live probe. Does not start/stop sandboxes or edit any configuration.
use openshell_bridge::{model::Selection, process::ProcessRunner, Bridge};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let gateway = std::env::args().nth(1);
    let snapshot = Bridge::new(ProcessRunner::default())
        .snapshot(Selection {
            gateway,
            ..Selection::default()
        })
        .await?;
    println!("{}", serde_json::to_string_pretty(&snapshot)?);
    Ok(())
}
