//! Stateless NVIDIA OpenShell adapter for ShellGuardian.
//!
//! OpenShell remains the owner of authentication, credentials, agent state, and
//! policy enforcement. This crate invokes only inspected CLI commands and returns
//! presentation types. It has no database or long-lived state store.

pub mod model;
pub mod process;
pub mod ssh;
mod updates;

use model::*;
use process::{redact, Runner};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    fmt,
    io::Write,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
pub use updates::{check_updates, compare_versions};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Serialize)]
pub struct Error {
    pub message: String,
}
impl Error {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.message.fmt(f)
    }
}
impl std::error::Error for Error {}

pub struct Bridge<R: Runner> {
    runner: R,
}

/// Resource identifiers are positional CLI arguments, never flags or paths.
pub fn validate_name(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value.as_bytes()[0].is_ascii_alphanumeric()
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    {
        return Err(Error::new("Choose a valid OpenShell resource name (letters, numbers, dots, underscores, or hyphens)."));
    }
    Ok(())
}

pub fn validate_scope(scope: &Scope) -> Result<()> {
    validate_name(&scope.gateway)?;
    validate_name(&scope.workspace)?;
    if let Some(id) = &scope.connection_id {
        validate_name(id)?;
    }
    Ok(())
}

fn scoped_args(scope: &Scope, args: &[&str]) -> Result<Vec<String>> {
    validate_scope(scope)?;
    Ok([
        "--color",
        "never",
        "--gateway",
        &scope.gateway,
        "--workspace",
        &scope.workspace,
    ]
    .into_iter()
    .chain(args.iter().copied())
    .map(str::to_owned)
    .collect())
}

fn decode<T: DeserializeOwned>(raw: &str) -> Result<T> {
    serde_json::from_str(raw).map_err(|_| {
        Error::new(
            "OpenShell returned an unsupported JSON format. Check CLI and gateway compatibility.",
        )
    })
}

fn object_policy(value: &Value) -> Result<Value> {
    value
        .get("policy")
        .filter(|p| p.is_object())
        .cloned()
        .ok_or_else(|| Error::new("OpenShell did not return an active policy payload."))
}

impl<R: Runner> Bridge<R> {
    pub fn new(runner: R) -> Self {
        Self { runner }
    }

    fn validate_connection(&self, connection_id: Option<&str>) -> Result<()> {
        if connection_id != self.runner.connection_id() {
            return Err(Error::new(
                "This SSH connection is no longer available. Reconnect before continuing.",
            ));
        }
        Ok(())
    }

    fn scoped_args(&self, scope: &Scope, args: &[&str]) -> Result<Vec<String>> {
        self.validate_connection(scope.connection_id.as_deref())?;
        scoped_args(scope, args)
    }

    /// Read the CLI version independently of any gateway's availability.
    pub async fn installed_version(&self) -> Result<String> {
        let raw = self
            .runner
            .run(&["--version".into()], Duration::from_secs(5))
            .await?;
        raw.split_whitespace()
            .last()
            .and_then(|v| semver::Version::parse(v).ok())
            .map(|version| version.to_string())
            .ok_or_else(|| Error::new("Could not read the installed OpenShell version."))
    }

    async fn read(&self, scope: &Scope, args: &[&str]) -> Result<String> {
        self.runner
            .run(&self.scoped_args(scope, args)?, Duration::from_secs(15))
            .await
    }

    /// Read every inventory page. Repeated cursors and excessive inventories fail
    /// explicitly instead of masquerading as a complete empty inventory.
    async fn collection<T: DeserializeOwned>(
        &self,
        scope: &Scope,
        args: &[&str],
        key: &str,
    ) -> Result<Vec<T>> {
        let mut items = Vec::new();
        let mut cursor = String::new();
        let mut visited = HashSet::new();
        for _ in 0..50 {
            let mut command = self.scoped_args(scope, args)?;
            command.extend([
                "--output".into(),
                "json".into(),
                "--page-size".into(),
                "100".into(),
            ]);
            if !cursor.is_empty() {
                command.push(format!("--page-token={cursor}"));
            }
            let raw = self.runner.run(&command, Duration::from_secs(15)).await?;
            let envelope: Value = decode(&raw)?;
            let page = envelope
                .get(key)
                .and_then(Value::as_array)
                .ok_or_else(|| Error::new("OpenShell inventory format is unsupported."))?;
            for item in page {
                items.push(decode::<T>(&item.to_string())?);
            }
            if items.len() > 5000 {
                return Err(Error::new(
                    "Inventory exceeds the 5,000-resource display limit.",
                ));
            }
            cursor = envelope
                .get("next_page_token")
                .and_then(Value::as_str)
                .ok_or_else(|| Error::new("OpenShell inventory omitted its pagination cursor."))?
                .to_string();
            if cursor.is_empty() {
                return Ok(items);
            }
            if cursor.len() > 8192 || !visited.insert(cursor.clone()) {
                return Err(Error::new(
                    "OpenShell returned an invalid or repeated pagination cursor.",
                ));
            }
        }
        Err(Error::new(
            "OpenShell inventory exceeded the 50-page display limit.",
        ))
    }

    /// Read-only snapshot. Independent failures are kept separate, so a provider
    /// permissions failure does not hide a successfully fetched agent inventory.
    pub async fn snapshot(&self, selection: Selection) -> Result<Snapshot> {
        self.validate_connection(selection.connection_id.as_deref())?;
        validate_name(&selection.workspace)?;
        if let Some(name) = &selection.gateway {
            validate_name(name)?;
        }
        let (version, gateways) = tokio::join!(self.installed_version(), async {
            self.runner
                .run(
                    &[
                        "gateway".into(),
                        "list".into(),
                        "--output".into(),
                        "json".into(),
                    ],
                    Duration::from_secs(5),
                )
                .await
        });
        let mut notices = Vec::new();
        let installed_version = match version {
            Ok(version) => Some(version),
            Err(error) => {
                notices.push(Notice {
                    area: "installation".into(),
                    message: error.message,
                });
                None
            }
        };
        let mut gateways: Vec<Gateway> = match gateways.and_then(|raw| decode(&raw)) {
            Ok(gateways) => gateways,
            Err(error) => {
                notices.push(Notice {
                    area: "gateways".into(),
                    message: error.message,
                });
                Vec::new()
            }
        };
        for gateway in &mut gateways {
            gateway.endpoint = redact(&gateway.endpoint);
        }
        let selected = match &selection.gateway {
            Some(name) => gateways.iter().find(|g| &g.name == name),
            None => gateways.iter().find(|g| g.active),
        };
        let scope = selected.map(|g| Scope {
            gateway: g.name.clone(),
            workspace: selection.workspace,
            connection_id: selection.connection_id,
        });
        if scope.is_none() {
            notices.push(Notice {
                area: "connection".into(),
                message:
                    "No selected gateway is registered. Register one with OpenShell, then refresh."
                        .into(),
            });
        }
        let (mut status, mut agents, mut providers) = (None, Vec::new(), Vec::new());
        if let Some(scope) = &scope {
            let (status_result, agents_result, providers_result) = tokio::join!(
                async {
                    decode::<GatewayStatus>(
                        &self.read(scope, &["status", "--output", "json"]).await?,
                    )
                },
                self.collection::<Agent>(scope, &["sandbox", "list"], "sandboxes"),
                self.collection::<Provider>(scope, &["provider", "list"], "providers")
            );
            match status_result {
                Ok(value) => status = Some(value),
                Err(error) => notices.push(Notice {
                    area: "connection".into(),
                    message: error.message,
                }),
            }
            match agents_result {
                Ok(value) => agents = value,
                Err(error) => notices.push(Notice {
                    area: "agents".into(),
                    message: error.message,
                }),
            }
            match providers_result {
                Ok(value) => providers = value,
                Err(error) => notices.push(Notice {
                    area: "providers".into(),
                    message: error.message,
                }),
            }
        }
        let observed_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        Ok(Snapshot {
            installed_version,
            gateways,
            scope,
            status,
            agents,
            providers,
            notices,
            observed_at,
        })
    }

    pub async fn detail(&self, scope: &Scope, name: &str) -> Result<AgentDetail> {
        validate_name(name)?;
        let (agent_result, base_result, providers) = tokio::join!(
            async {
                self.read(scope, &["sandbox", "get", name, "--output", "json"])
                    .await
            },
            async {
                self.read(
                    scope,
                    &["policy", "get", name, "--base", "--output", "json"],
                )
                .await
            },
            async {
                self.collection::<Provider>(
                    scope,
                    &["sandbox", "provider", "list", name],
                    "providers",
                )
                .await
            }
        );
        let agent_value: Value = decode(&agent_result?)?;
        let base: Value = decode(&base_result?)?;
        Ok(AgentDetail {
            agent: decode(&agent_value.to_string())?,
            policy: object_policy(&agent_value)?,
            base_policy: object_policy(&base)?,
            policy_source: base
                .get("policy_source")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .into(),
            policy_hash: base
                .get("hash")
                .and_then(Value::as_str)
                .ok_or_else(|| Error::new("OpenShell omitted the policy hash."))?
                .into(),
            config_revision: base
                .get("config_revision")
                .and_then(Value::as_u64)
                .ok_or_else(|| Error::new("OpenShell omitted the configuration revision."))?,
            providers: providers?,
        })
    }

    pub async fn logs(&self, scope: &Scope, name: &str) -> Result<String> {
        validate_name(name)?;
        let logs = self
            .read(scope, &["logs", name, "-n", "150", "--since", "1h"])
            .await?;
        Ok(redact(&logs))
    }

    /// CLI lifecycle commands wait for readiness/stopped state. ShellGuardian
    /// never interprets sandbox readiness as agent-process health.
    pub async fn lifecycle(
        &self,
        scope: &Scope,
        name: &str,
        action: LifecycleAction,
    ) -> Result<String> {
        validate_name(name)?;
        let verb = match action {
            LifecycleAction::Start => "start",
            LifecycleAction::Stop => "stop",
        };
        self.runner
            .run(
                &self.scoped_args(scope, &["sandbox", verb, name])?,
                Duration::from_secs(120),
            )
            .await?;
        Ok(format!("OpenShell acknowledged sandbox {verb}."))
    }

    pub async fn provider_change(
        &self,
        scope: &Scope,
        name: &str,
        provider: &str,
        action: ProviderAction,
    ) -> Result<String> {
        validate_name(name)?;
        validate_name(provider)?;
        let verb = match action {
            ProviderAction::Attach => "attach",
            ProviderAction::Detach => "detach",
        };
        self.runner
            .run(
                &self.scoped_args(
                    scope,
                    &[
                        "sandbox",
                        "provider",
                        verb,
                        name,
                        provider,
                        "--wait",
                        "--timeout",
                        "30",
                        "--output",
                        "json",
                    ],
                )?,
                Duration::from_secs(40),
            )
            .await?;
        Ok("OpenShell acknowledged the provider change for new processes. Existing processes can retain their old environment.".into())
    }

    /// Apply JSON (a YAML-compatible policy payload) via an owner-only temporary
    /// file. Re-read before applying to detect ordinary concurrent edits. This is
    /// not atomic compare-and-swap: the CLI has no expected-revision write flag.
    pub async fn apply_policy(&self, edit: PolicyEdit) -> Result<String> {
        validate_scope(&edit.scope)?;
        validate_name(&edit.name)?;
        if edit.policy_json.len() > 64 * 1024 {
            return Err(Error::new("Policy exceeds the 64 KiB editor limit."));
        }
        let proposed: Value = decode(&edit.policy_json)?;
        if !proposed.is_object() {
            return Err(Error::new("Policy must be a JSON object."));
        }
        let current: Value = decode(
            &self
                .read(
                    &edit.scope,
                    &["policy", "get", &edit.name, "--base", "--output", "json"],
                )
                .await?,
        )?;
        if current.get("hash").and_then(Value::as_str) != Some(edit.expected_hash.as_str())
            || current.get("config_revision").and_then(Value::as_u64)
                != Some(edit.expected_revision)
        {
            return Err(Error::new("This policy changed after you opened it. Reload the agent and review the current policy before applying."));
        }
        if current.get("policy_source").and_then(Value::as_str) != Some("sandbox") {
            return Err(Error::new("This sandbox inherits its global policy. ShellGuardian does not replace gateway-global policy."));
        }
        let base = object_policy(&current)?;
        for key in ["filesystem_policy", "landlock", "process"] {
            if base.get(key) != proposed.get(key) {
                return Err(Error::new("Filesystem and process controls are fixed at creation. Recreate the sandbox through OpenShell to change them."));
            }
        }
        let mut file = tempfile::Builder::new()
            .prefix("shellguardian-policy-")
            .suffix(".yaml")
            .tempfile()
            .map_err(|_| Error::new("Could not stage the policy for OpenShell."))?;
        file.write_all(edit.policy_json.as_bytes())
            .and_then(|_| file.flush())
            .map_err(|_| Error::new("Could not write the staged policy."))?;
        let path = file
            .path()
            .to_str()
            .ok_or_else(|| Error::new("Policy staging path is unsupported."))?;
        self.runner
            .run(
                &self.scoped_args(
                    &edit.scope,
                    &[
                        "policy",
                        "set",
                        &edit.name,
                        "--policy",
                        path,
                        "--wait",
                        "--timeout",
                        "30",
                    ],
                )?,
                Duration::from_secs(40),
            )
            .await?;
        Ok("OpenShell acknowledged the policy update. Reload the effective policy to see the applied access.".into())
    }
}

#[cfg(test)]
mod tests;
