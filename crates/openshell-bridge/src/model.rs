//! Safe presentation types. Unknown upstream fields never cross the desktop IPC.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub gateway: Option<String>,
    pub workspace: String,
}

impl Default for Selection {
    fn default() -> Self {
        Self {
            gateway: None,
            workspace: "default".into(),
        }
    }
}

/// Explicit request context. A UI selection never mutates OpenShell's CLI context.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Scope {
    pub gateway: String,
    pub workspace: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Gateway {
    pub name: String,
    pub endpoint: String,
    pub active: bool,
    #[serde(default)]
    pub auth: String,
    #[serde(default)]
    pub is_remote: bool,
    #[serde(default)]
    pub remote_host: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Authentication {
    pub status: String,
    #[serde(default)]
    pub provider: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GatewayStatus {
    pub status: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub authentication: Option<Authentication>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub phase: String,
    #[serde(default)]
    pub workspace: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub current_policy_version: u64,
    #[serde(default)]
    pub exit_code: Option<i32>,
}

/// The inspected CLI returns credential *names*, never values. This type also
/// discards unknown fields in case a future CLI extends its output.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Provider {
    pub name: String,
    #[serde(rename = "type")]
    pub provider_type: String,
    #[serde(default)]
    pub credential_keys: Vec<String>,
    #[serde(default)]
    pub config_keys: Vec<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub credential_expires_at_ms: std::collections::BTreeMap<String, i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub area: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub installed_version: Option<String>,
    pub gateways: Vec<Gateway>,
    pub scope: Option<Scope>,
    pub status: Option<GatewayStatus>,
    pub agents: Vec<Agent>,
    pub providers: Vec<Provider>,
    pub notices: Vec<Notice>,
    pub observed_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetail {
    pub agent: Agent,
    pub policy: Value,
    pub base_policy: Value,
    pub policy_source: String,
    pub policy_hash: String,
    pub config_revision: u64,
    pub providers: Vec<Provider>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LifecycleAction {
    Start,
    Stop,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderAction {
    Attach,
    Detach,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyEdit {
    pub scope: Scope,
    pub name: String,
    pub expected_hash: String,
    pub expected_revision: u64,
    pub policy_json: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub status: String,
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    pub release_url: Option<String>,
    pub published_at: Option<String>,
    pub error: Option<String>,
}
