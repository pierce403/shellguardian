//! Fixed OpenShell commands for user-requested sandbox interaction.
//!
//! This is not a general local command runner or a synthesized chat API. Agent
//! mode attaches the existing main process; terminal mode creates a separate
//! sandbox shell. The native PTY owner must retain the launch until cleanup so
//! SSH disconnect cannot remove its transport while the session is using it.

use crate::{
    model::{Agent, Scope},
    process::Runner,
    scoped_args,
    ssh::{ConnectionRunner, SshConnections},
    validate_name, Error, Result,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Two supported interactive operations, never a frontend-provided command.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum InteractionKind {
    Agent,
    Terminal,
}

/// Validated arguments plus the lease for exactly the selected SSH connection.
pub struct InteractiveLaunch {
    pub args: Vec<String>,
    runner: ConnectionRunner,
}

impl InteractiveLaunch {
    /// A lost tunnel is terminal: callers must close, never retry directly.
    pub fn check_alive(&self) -> Result<()> {
        self.runner.check_alive()
    }
}

async fn prepare_args<R: Runner>(
    runner: &R,
    scope: &Scope,
    name: &str,
    kind: InteractionKind,
) -> Result<Vec<String>> {
    validate_name(name)?;
    if runner.connection_id() != scope.connection_id.as_deref() {
        return Err(Error::new(
            "This SSH connection is no longer available. Reconnect before continuing.",
        ));
    }
    let get = scoped_args(scope, &["sandbox", "get", name, "--output", "json"])?;
    let raw = runner.run(&get, Duration::from_secs(15)).await?;
    let agent: Agent = crate::decode(&raw)?;
    if agent.name != name || (!agent.workspace.is_empty() && agent.workspace != scope.workspace) {
        return Err(Error::new(
            "OpenShell returned a different sandbox. Refresh before opening a session.",
        ));
    }
    if agent.phase != "Ready" {
        return Err(Error::new(
            "This sandbox is not Ready. Start it and refresh before opening a session.",
        ));
    }
    // A real local PTY is required for OpenShell's streaming interactive exec.
    // The program after `--` runs inside the sandbox, never on this host.
    let suffix: &[&str] = match kind {
        InteractionKind::Agent => &["sandbox", "connect", name],
        InteractionKind::Terminal => &[
            "sandbox", "exec", "--name", name, "--tty", "--", "/bin/sh", "-i",
        ],
    };
    scoped_args(scope, suffix)
}

impl SshConnections {
    /// Check live sandbox state and retain its scoped transport for a native PTY.
    /// Readiness only permits an attempt; it does not prove the main process is
    /// an interactive agent. OpenShell owns attachment semantics and history.
    pub async fn prepare_interaction(
        &self,
        scope: &Scope,
        name: &str,
        kind: InteractionKind,
    ) -> Result<InteractiveLaunch> {
        let runner = self
            .runner(Some(&scope.gateway), scope.connection_id.as_deref())
            .await?;
        let args = prepare_args(&runner, scope, name, kind).await?;
        Ok(InteractiveLaunch {
            args: runner.route(&args)?,
            runner,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Fake {
        json: String,
        calls: Mutex<Vec<Vec<String>>>,
        id: Option<String>,
    }
    impl Fake {
        fn phase(phase: &str) -> Self {
            Self {
                json: serde_json::json!({"id":"id1","name":"agent-1","workspace":"work","phase":phase}).to_string(),
                calls: Mutex::new(Vec::new()),
                id: None,
            }
        }
    }
    impl Runner for Fake {
        fn connection_id(&self) -> Option<&str> {
            self.id.as_deref()
        }
        async fn run(&self, args: &[String], _: Duration) -> Result<String> {
            self.calls.lock().unwrap().push(args.to_vec());
            Ok(self.json.clone())
        }
    }
    fn scope() -> Scope {
        Scope {
            gateway: "local".into(),
            workspace: "work".into(),
            connection_id: None,
        }
    }

    #[tokio::test]
    async fn fixed_commands_keep_explicit_scope_and_check_readiness() {
        let fake = Fake::phase("Ready");
        for (kind, suffix) in [
            (
                InteractionKind::Agent,
                vec!["sandbox", "connect", "agent-1"],
            ),
            (
                InteractionKind::Terminal,
                vec![
                    "sandbox", "exec", "--name", "agent-1", "--tty", "--", "/bin/sh", "-i",
                ],
            ),
        ] {
            let args = prepare_args(&fake, &scope(), "agent-1", kind)
                .await
                .unwrap();
            assert_eq!(
                &args[..6],
                [
                    "--color",
                    "never",
                    "--gateway",
                    "local",
                    "--workspace",
                    "work"
                ]
            );
            assert_eq!(&args[6..], suffix);
        }
        for call in fake.calls.lock().unwrap().iter() {
            assert_eq!(
                &call[6..],
                ["sandbox", "get", "agent-1", "--output", "json"]
            );
            assert!(!call
                .iter()
                .any(|v| v.contains("insecure") || v.contains("credential")));
        }
    }

    #[tokio::test]
    async fn invalid_inputs_cannot_launch_or_read_a_sandbox() {
        let fake = Fake::phase("Ready");
        for name in ["", "--help", "a;sh", "../agent", "a\nsh"] {
            assert!(prepare_args(&fake, &scope(), name, InteractionKind::Agent)
                .await
                .is_err());
        }
        for bad_scope in [
            Scope {
                gateway: "--gateway-insecure".into(),
                ..scope()
            },
            Scope {
                workspace: "default;sh".into(),
                ..scope()
            },
            Scope {
                connection_id: Some("stale".into()),
                ..scope()
            },
        ] {
            assert!(
                prepare_args(&fake, &bad_scope, "agent-1", InteractionKind::Terminal)
                    .await
                    .is_err()
            );
        }
        assert!(fake.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn nonready_malformed_and_mismatched_responses_fail_closed() {
        for phase in ["Pending", "Stopped", "Error", "ready", ""] {
            assert!(prepare_args(
                &Fake::phase(phase),
                &scope(),
                "agent-1",
                InteractionKind::Agent
            )
            .await
            .is_err());
        }
        let mut fake = Fake::phase("Ready");
        for raw in [
            "not json",
            r#"{"id":"a","name":"other","phase":"Ready"}"#,
            r#"{"id":"a","name":"agent-1","phase":"Ready","workspace":"other"}"#,
        ] {
            fake.json = raw.into();
            assert!(
                prepare_args(&fake, &scope(), "agent-1", InteractionKind::Terminal)
                    .await
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn stale_native_session_never_falls_back_to_direct() {
        let connections = SshConnections::default();
        let scope = Scope {
            connection_id: Some("ssh-expired".into()),
            ..scope()
        };
        let error = connections
            .prepare_interaction(&scope, "agent-1", InteractionKind::Terminal)
            .await
            .err()
            .expect("stale ID rejected");
        assert!(error.message.contains("no longer available"));
    }
}
