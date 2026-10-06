use super::*;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

#[derive(Clone, Default)]
struct FakeRunner {
    calls: Arc<Mutex<Vec<Vec<String>>>>,
    replies: Arc<Mutex<HashMap<String, VecDeque<Result<String>>>>>,
}

impl FakeRunner {
    fn reply(&self, command: &str, response: &str) {
        self.replies
            .lock()
            .unwrap()
            .entry(command.into())
            .or_default()
            .push_back(Ok(response.into()));
    }
    fn fail(&self, command: &str, message: &str) {
        self.replies
            .lock()
            .unwrap()
            .entry(command.into())
            .or_default()
            .push_back(Err(Error::new(message)));
    }
}

impl Runner for FakeRunner {
    async fn run(&self, args: &[String], _: Duration) -> Result<String> {
        self.calls.lock().unwrap().push(args.to_vec());
        let command = if args.first().map(String::as_str) == Some("--color") {
            &args[6..]
        } else {
            args
        };
        let key = command.join(" ");
        if command.starts_with(&["policy".into(), "set".into()]) {
            let position = command.iter().position(|part| part == "--policy").unwrap();
            let staged = std::fs::read_to_string(&command[position + 1]).unwrap();
            let value: Value = serde_json::from_str(&staged).unwrap();
            assert!(value.is_object());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    std::fs::metadata(&command[position + 1])
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o600
                );
            }
            return Ok("Applied".into());
        }
        self.replies
            .lock()
            .unwrap()
            .get_mut(&key)
            .and_then(VecDeque::pop_front)
            .unwrap_or_else(|| Err(Error::new(format!("Unexpected fake command: {key}"))))
    }
}

fn scope() -> Scope {
    Scope {
        gateway: "local".into(),
        workspace: "default".into(),
    }
}
fn agent() -> Value {
    serde_json::json!({ "id": "sample-id", "name": "researcher", "phase": "Ready", "workspace": "default", "created_at": "2026-10-05 10:00:00", "current_policy_version": 3 })
}
fn base() -> Value {
    serde_json::json!({ "hash": "original", "config_revision": 4, "policy_source": "sandbox", "policy": { "version": 1, "filesystem_policy": { "read_only": ["/usr"], "read_write": ["/sandbox"] }, "process": { "run_as_user": "sandbox" }, "network_policies": {} } })
}
fn edit() -> PolicyEdit {
    PolicyEdit {
        scope: scope(),
        name: "researcher".into(),
        expected_hash: "original".into(),
        expected_revision: 4,
        policy_json: base()["policy"].to_string(),
    }
}
fn connected_runner() -> FakeRunner {
    let runner = FakeRunner::default();
    runner.reply("--version", "openshell 0.1.2\n");
    runner.reply(
        "gateway list --output json",
        r#"[{"name":"local","active":true,"endpoint":"https://127.0.0.1:18080","auth":"mtls"}]"#,
    );
    runner.reply("status --output json", r#"{"status":"connected","version":"0.1.2","authentication":{"status":"authenticated","provider":"mTLS transport"}}"#);
    runner.reply(
        "sandbox list --output json --page-size 100",
        &serde_json::json!({ "sandboxes": [agent()], "next_page_token": "" }).to_string(),
    );
    runner.reply("provider list --output json --page-size 100", r#"{"providers":[{"name":"github","type":"github","credential_keys":["GITHUB_TOKEN"],"credentials":{"GITHUB_TOKEN":"synthetic-value-must-not-cross-ipc"}}],"next_page_token":""}"#);
    runner
}

#[test]
fn identifier_validation_rejects_flags_paths_and_shell_syntax() {
    for name in [
        "", "--global", "-n", "a/b", "a b", "$(id)", "x;touch", "x\n", "../local",
    ] {
        assert!(validate_name(name).is_err(), "{name}");
    }
    for name in ["local", "remote-dgx", "agent_2", "team.dev"] {
        assert!(validate_name(name).is_ok());
    }
    assert!(validate_name(&"a".repeat(129)).is_err());
}

#[test]
fn strict_ipc_inputs_reject_unknown_fields_and_actions() {
    assert!(serde_json::from_value::<Scope>(
        serde_json::json!({"gateway":"local","workspace":"default","gatewayInsecure":true})
    )
    .is_err());
    assert!(serde_json::from_str::<LifecycleAction>("\"delete\"").is_err());
    assert!(serde_json::from_str::<ProviderAction>("\"rotate\"").is_err());
}

#[tokio::test]
async fn snapshot_scopes_reads_without_selecting_a_gateway() {
    let runner = connected_runner();
    let snapshot = Bridge::new(runner.clone())
        .snapshot(Selection::default())
        .await
        .unwrap();
    assert_eq!(snapshot.installed_version.as_deref(), Some("0.1.2"));
    assert_eq!(snapshot.scope.unwrap(), scope());
    assert_eq!(snapshot.agents[0].phase, "Ready");
    assert!(snapshot.notices.is_empty());
    for call in runner.calls.lock().unwrap().iter().skip(2) {
        assert_eq!(
            &call[..6],
            &[
                "--color",
                "never",
                "--gateway",
                "local",
                "--workspace",
                "default"
            ]
        );
        assert!(!call.iter().any(
            |arg| ["select", "--gateway-insecure", "--all-workspaces"].contains(&arg.as_str())
        ));
    }
}

#[tokio::test]
async fn provider_payloads_discard_credential_values() {
    let snapshot = Bridge::new(connected_runner())
        .snapshot(Selection::default())
        .await
        .unwrap();
    let serialized = serde_json::to_string(&snapshot).unwrap();
    assert!(serialized.contains("GITHUB_TOKEN"));
    assert!(!serialized.contains("synthetic-value-must-not-cross-ipc"));
    assert!(!serialized.contains("credentials"));
}

#[tokio::test]
async fn invalid_scope_is_rejected_before_process_execution() {
    let runner = FakeRunner::default();
    assert!(Bridge::new(runner.clone())
        .snapshot(Selection {
            gateway: Some("--global".into()),
            ..Selection::default()
        })
        .await
        .is_err());
    assert!(runner.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn inventory_follows_opaque_pagination_tokens() {
    let runner = FakeRunner::default();
    runner.reply(
        "sandbox list --output json --page-size 100",
        &serde_json::json!({"sandboxes":[agent()],"next_page_token":"opaque+token="}).to_string(),
    );
    runner.reply(
        "sandbox list --output json --page-size 100 --page-token=opaque+token=",
        r#"{"sandboxes":[],"next_page_token":""}"#,
    );
    let items = Bridge::new(runner.clone())
        .collection::<Agent>(&scope(), &["sandbox", "list"], "sandboxes")
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(runner.calls.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn repeated_cursor_fails_instead_of_hanging() {
    let runner = FakeRunner::default();
    runner.reply(
        "sandbox list --output json --page-size 100",
        r#"{"sandboxes":[],"next_page_token":"repeat"}"#,
    );
    runner.reply(
        "sandbox list --output json --page-size 100 --page-token=repeat",
        r#"{"sandboxes":[],"next_page_token":"repeat"}"#,
    );
    assert!(Bridge::new(runner)
        .collection::<Agent>(&scope(), &["sandbox", "list"], "sandboxes")
        .await
        .unwrap_err()
        .message
        .contains("repeated"));
}

#[tokio::test]
async fn unknown_inventory_shape_is_not_an_empty_success() {
    let runner = FakeRunner::default();
    runner.reply("sandbox list --output json --page-size 100", "[]");
    assert!(Bridge::new(runner)
        .collection::<Agent>(&scope(), &["sandbox", "list"], "sandboxes")
        .await
        .is_err());
}

#[tokio::test]
async fn disconnected_gateway_preserves_inventory_failures() {
    let runner = FakeRunner::default();
    runner.reply("--version", "openshell 0.1.2");
    runner.reply(
        "gateway list --output json",
        r#"[{"name":"local","active":true,"endpoint":"http://127.0.0.1:18080"}]"#,
    );
    let snapshot = Bridge::new(runner)
        .snapshot(Selection::default())
        .await
        .unwrap();
    assert!(snapshot.status.is_none());
    assert_eq!(snapshot.notices.len(), 3);
    assert!(snapshot
        .notices
        .iter()
        .any(|notice| notice.area == "agents"));
}

#[tokio::test]
async fn no_active_gateway_is_not_silently_replaced_by_first_entry() {
    let runner = FakeRunner::default();
    runner.reply("--version", "openshell 0.1.2");
    runner.reply(
        "gateway list --output json",
        r#"[{"name":"local","active":false,"endpoint":"http://127.0.0.1:18080"}]"#,
    );
    let snapshot = Bridge::new(runner.clone())
        .snapshot(Selection::default())
        .await
        .unwrap();
    assert!(snapshot.scope.is_none());
    assert_eq!(runner.calls.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn partial_provider_failure_does_not_hide_agents() {
    let runner = connected_runner();
    runner
        .replies
        .lock()
        .unwrap()
        .remove("provider list --output json --page-size 100");
    runner.fail(
        "provider list --output json --page-size 100",
        "Permission denied.",
    );
    let snapshot = Bridge::new(runner)
        .snapshot(Selection::default())
        .await
        .unwrap();
    assert_eq!(snapshot.agents.len(), 1);
    assert_eq!(snapshot.notices[0].area, "providers");
}

#[tokio::test]
async fn lifecycle_and_provider_actions_are_exact_and_wait_for_upstream() {
    let runner = FakeRunner::default();
    runner.reply("sandbox stop researcher", "Stopped");
    runner.reply("sandbox start researcher", "Ready");
    runner.reply(
        "sandbox provider detach researcher github --wait --timeout 30 --output json",
        "{}",
    );
    runner.reply(
        "sandbox provider attach researcher github --wait --timeout 30 --output json",
        "{}",
    );
    let bridge = Bridge::new(runner.clone());
    bridge
        .lifecycle(&scope(), "researcher", LifecycleAction::Stop)
        .await
        .unwrap();
    bridge
        .lifecycle(&scope(), "researcher", LifecycleAction::Start)
        .await
        .unwrap();
    bridge
        .provider_change(&scope(), "researcher", "github", ProviderAction::Detach)
        .await
        .unwrap();
    bridge
        .provider_change(&scope(), "researcher", "github", ProviderAction::Attach)
        .await
        .unwrap();
    assert_eq!(runner.calls.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn mutations_do_not_retry_an_ambiguous_failure() {
    let runner = FakeRunner::default();
    runner.fail("sandbox stop researcher", "Timed out; status unknown.");
    assert!(Bridge::new(runner.clone())
        .lifecycle(&scope(), "researcher", LifecycleAction::Stop)
        .await
        .is_err());
    assert_eq!(runner.calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn safe_policy_is_staged_privately_and_removed_after_apply() {
    let runner = FakeRunner::default();
    runner.reply(
        "policy get researcher --base --output json",
        &base().to_string(),
    );
    Bridge::new(runner.clone())
        .apply_policy(edit())
        .await
        .unwrap();
    let calls = runner.calls.lock().unwrap();
    let last = calls.last().unwrap();
    let position = last.iter().position(|arg| arg == "--policy").unwrap();
    assert!(!std::path::Path::new(&last[position + 1]).exists());
    assert!(last.windows(2).any(|parts| parts == ["--timeout", "30"]));
}

#[tokio::test]
async fn concurrent_policy_edits_are_rejected_before_mutation() {
    let runner = FakeRunner::default();
    runner.reply(
        "policy get researcher --base --output json",
        &base().to_string(),
    );
    let mut changed = edit();
    changed.expected_revision = 3;
    assert!(Bridge::new(runner.clone())
        .apply_policy(changed)
        .await
        .unwrap_err()
        .message
        .contains("changed"));
    assert_eq!(runner.calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn inherited_global_policy_cannot_be_replaced_from_agent_editor() {
    let runner = FakeRunner::default();
    let mut current = base();
    current["policy_source"] = "global".into();
    runner.reply(
        "policy get researcher --base --output json",
        &current.to_string(),
    );
    assert!(Bridge::new(runner.clone())
        .apply_policy(edit())
        .await
        .unwrap_err()
        .message
        .contains("global"));
    assert_eq!(runner.calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn static_policy_changes_require_recreation() {
    for field in ["filesystem_policy", "landlock", "process"] {
        let runner = FakeRunner::default();
        runner.reply(
            "policy get researcher --base --output json",
            &base().to_string(),
        );
        let mut changed = edit();
        let mut proposed = base()["policy"].clone();
        proposed[field] = serde_json::json!({ "changed": true });
        changed.policy_json = proposed.to_string();
        assert!(Bridge::new(runner.clone())
            .apply_policy(changed)
            .await
            .unwrap_err()
            .message
            .contains("creation"));
        assert_eq!(runner.calls.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn invalid_and_oversized_policy_inputs_do_not_execute() {
    for policy in ["not json".into(), "[]".into(), " ".repeat(65537)] {
        let runner = FakeRunner::default();
        let mut changed = edit();
        changed.policy_json = policy;
        assert!(Bridge::new(runner.clone())
            .apply_policy(changed)
            .await
            .is_err());
        assert!(runner.calls.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn log_windows_are_bounded_and_redacted() {
    let runner = FakeRunner::default();
    runner.reply(
        "logs researcher -n 150 --since 1h",
        "[HTTP] Authorization: Bearer synthetic-secret-value\nAPI_KEY=synthetic-secret-value",
    );
    let logs = Bridge::new(runner)
        .logs(&scope(), "researcher")
        .await
        .unwrap();
    assert!(!logs.contains("synthetic-secret-value"));
    assert!(logs.contains("[redacted]"));
}

#[test]
fn redaction_covers_common_key_material_but_retains_useful_log_context() {
    let input = "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz\n{\"api_key\":\"synthetic-secret\"}\nhttps://user:password@example.com\n-----BEGIN PRIVATE KEY-----\nsynthetic-key\n-----END PRIVATE KEY-----\nNET:OPEN ALLOWED api.github.com:443";
    let safe = redact(input);
    assert!(!safe.contains("abcdefghijklmnopqrstuvwxyz"));
    assert!(!safe.contains("synthetic-secret"));
    assert!(!safe.contains("synthetic-key"));
    assert!(!safe.contains("user:password"));
    assert!(safe.contains("NET:OPEN ALLOWED api.github.com:443"));
}

#[test]
fn updates_use_semver_and_distinguish_current_ahead_and_available() {
    assert_eq!(compare_versions("0.1.2", "v0.1.2").unwrap(), "current");
    assert_eq!(compare_versions("0.1.2", "v0.1.10").unwrap(), "available");
    assert_eq!(compare_versions("0.2.0", "v0.1.9").unwrap(), "ahead");
    assert_eq!(
        compare_versions("0.2.0-rc.1", "0.2.0").unwrap(),
        "available"
    );
    assert!(compare_versions("unknown", "0.1.2").is_err());
    assert!(compare_versions("0.1.2", "0.2.0-rc.1").is_err());
}
