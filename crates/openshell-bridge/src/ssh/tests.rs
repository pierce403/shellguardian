use super::*;
use crate::{model::Selection, Bridge};

fn request() -> SshConnectionRequest {
    SshConnectionRequest {
        gateway: "remote-profile".into(),
        destination: "alice@server".into(),
        remote_port: 17670,
        ssh_port: None,
    }
}

#[test]
fn destination_validation_rejects_command_and_option_injection() {
    for destination in [
        "",
        "-oProxyCommand=id",
        "alice@-oProxyCommand=id",
        "host extra",
        "host\nextra",
        "host;id",
        "$(id)",
        "`id`",
        "ssh://host",
        "alice:password@host",
        "a@b@c",
        "host/../../file",
        "host:22",
        "[::1]:22",
        "user@",
        "@host",
        "user@host%bad",
    ] {
        let mut input = request();
        input.destination = destination.into();
        assert!(validate_request(&input).is_err(), "{destination}");
    }
    for destination in [
        "my-alias",
        "alice@my-alias",
        "192.168.0.42",
        "alice@[::1]",
        "::1",
    ] {
        let mut input = request();
        input.destination = destination.into();
        assert!(validate_request(&input).is_ok(), "{destination}");
    }
    let mut input = request();
    input.remote_port = 0;
    assert!(validate_request(&input).is_err());
    input.remote_port = 17670;
    input.ssh_port = Some(0);
    assert!(validate_request(&input).is_err());
    input.ssh_port = None;
    input.gateway = "../other-profile".into();
    assert!(validate_request(&input).is_err());
}

#[test]
fn ssh_arguments_are_fixed_loopback_forward_without_remote_command() {
    let mut input = request();
    input.ssh_port = Some(2222);
    let args = ssh_args(&input, 41321);
    for option in [
        "BatchMode=yes",
        "StrictHostKeyChecking=yes",
        "ExitOnForwardFailure=yes",
        "ControlPath=none",
        "ForkAfterAuthentication=no",
        "PermitLocalCommand=no",
        "RemoteCommand=none",
    ] {
        assert!(args.windows(2).any(|pair| pair == ["-o", option]));
    }
    assert!(args.windows(2).any(|pair| pair == ["-p", "2222"]));
    assert_eq!(
        &args[args.len() - 4..],
        [
            "-L",
            "127.0.0.1:41321:127.0.0.1:17670",
            "--",
            "alice@server"
        ]
    );
    assert!(!args.iter().any(|arg| arg == "-f" || arg == "-g"));
    input.ssh_port = None;
    assert!(!ssh_args(&input, 41321).iter().any(|arg| arg == "-p"));
}

#[test]
fn inherited_forwarding_cannot_open_extra_local_or_remote_sockets() {
    let valid = "hostname server\nlocalforward [127.0.0.1]:41321 [127.0.0.1]:17670\n";
    assert!(validate_forwarding_config(valid.as_bytes(), 41321, 17670).is_ok());
    for extra in [
        "localforward [0.0.0.0]:9999 [127.0.0.1]:80\n",
        "remoteforward 9000 localhost:9000\n",
        "dynamicforward 8080\n",
        "localforward [127.0.0.1]:41321 [127.0.0.1]:17670\n",
    ] {
        assert!(
            validate_forwarding_config(format!("{valid}{extra}").as_bytes(), 41321, 17670).is_err()
        );
    }
    assert!(validate_forwarding_config(b"clearallforwardings yes\n", 41321, 17670).is_err());
}

#[test]
fn ssh_ipc_does_not_accept_credentials_or_program_overrides() {
    let base = serde_json::json!({"gateway":"remote-profile","destination":"alice@server","remotePort":17670,"sshPort":null});
    for key in [
        "password",
        "privateKey",
        "program",
        "endpoint",
        "options",
        "command",
    ] {
        let mut input = base.clone();
        input[key] = "unexpected".into();
        assert!(serde_json::from_value::<SshConnectionRequest>(input).is_err());
    }
}

#[test]
fn connection_requires_actual_authenticated_grpc_status() {
    assert!(require_authenticated_status(
        r#"{"status":"connected","authentication":{"status":"authenticated"}}"#
    )
    .is_ok());
    for status in [
        r#"{"status":"connected"}"#,
        r#"{"status":"connected_http","authentication":{"status":"authenticated"}}"#,
        r#"{"status":"connected","authentication":{"status":"failed"}}"#,
        r#"{"status":"disconnected","authentication":{"status":"unverified"}}"#,
        "invalid json",
    ] {
        assert!(require_authenticated_status(status).is_err());
    }
    let error = require_authenticated_status(
        r#"{"status":"disconnected","error":"password=synthetic-must-not-cross"}"#,
    )
    .unwrap_err();
    assert!(!error.message.contains("synthetic-must-not-cross"));
}

#[tokio::test]
async fn unknown_or_mismatched_ids_never_fall_back_to_direct_runner() {
    let manager = SshConnections::default();
    assert!(manager
        .runner(Some("remote-profile"), Some("missing-id"))
        .await
        .is_err());
    assert!(manager.runner(None, Some("missing-id")).await.is_err());
    let direct = manager.runner(Some("remote-profile"), None).await.unwrap();
    let error = Bridge::new(direct)
        .snapshot(Selection {
            gateway: Some("remote-profile".into()),
            connection_id: Some("missing-id".into()),
            ..Selection::default()
        })
        .await
        .unwrap_err();
    assert!(error.message.contains("no longer available"));
}

#[cfg(unix)]
async fn fixture_connection() -> (Arc<Connection>, u32) {
    let child = Command::new("/bin/sleep")
        .arg("30")
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let pid = child.id().unwrap();
    (
        Arc::new(Connection {
            info: SshConnection {
                id: "ssh-fixture".into(),
                gateway: "remote-profile".into(),
                destination: "fixture".into(),
                remote_port: 17670,
                ssh_port: None,
                local_port: 41321,
                status: "connected".into(),
                error: None,
            },
            operations: Arc::new(RwLock::new(())),
            process: StdMutex::new(ProcessState {
                child: Some(child),
                error: None,
            }),
            stderr: Arc::new(StdMutex::new(Vec::new())),
        }),
        pid,
    )
}

#[cfg(unix)]
#[tokio::test]
async fn endpoint_override_preserves_profile_and_rejects_scope_mismatch() {
    let (connection, _) = fixture_connection().await;
    let runner = ConnectionRunner {
        direct: ProcessRunner::default(),
        lease: Some(connection.lease().await.unwrap()),
    };
    let args = [
        "--color",
        "never",
        "--gateway",
        "remote-profile",
        "--workspace",
        "default",
        "status",
        "--output",
        "json",
    ]
    .map(str::to_owned);
    let routed = runner.route(&args).unwrap();
    assert_eq!(
        &routed[..2],
        ["--gateway-endpoint", "https://127.0.0.1:41321"]
    );
    assert_eq!(&routed[2..], args);
    let mut wrong_profile = args.clone();
    wrong_profile[3] = "other-profile".into();
    assert!(runner.route(&wrong_profile).is_err());
    assert!(runner
        .route(&["gateway".into(), "select".into(), "remote-profile".into()])
        .is_err());
    assert!(runner
        .route(&["--gateway-endpoint=https://attacker.example".into()])
        .is_err());
    drop(runner);
    connection.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn disconnect_waits_for_complete_operation_then_reaps_owned_child() {
    let (connection, pid) = fixture_connection().await;
    let manager = Arc::new(SshConnections::default());
    manager
        .connections
        .lock()
        .await
        .insert(connection.info.id.clone(), connection.clone());
    assert!(manager
        .runner(Some("wrong-profile"), Some("ssh-fixture"))
        .await
        .is_err());
    let lease = manager
        .runner(Some("remote-profile"), Some("ssh-fixture"))
        .await
        .unwrap();
    let disconnect_manager = manager.clone();
    let disconnect =
        tokio::spawn(async move { disconnect_manager.disconnect("ssh-fixture").await });
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(!disconnect.is_finished());
    assert!(connection.check_alive().is_ok());
    drop(lease);
    tokio::time::timeout(Duration::from_secs(2), disconnect)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(connection.check_alive().is_err());
    assert!(manager
        .runner(Some("remote-profile"), Some("ssh-fixture"))
        .await
        .is_err());
    assert!(manager.list().await.is_empty());
    #[cfg(target_os = "linux")]
    assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
    #[cfg(not(target_os = "linux"))]
    let _ = pid;
}

#[cfg(unix)]
#[tokio::test]
async fn tunnel_death_invalidates_existing_lease_before_next_command() {
    let (connection, _) = fixture_connection().await;
    let manager = SshConnections::default();
    manager
        .connections
        .lock()
        .await
        .insert(connection.info.id.clone(), connection.clone());
    let runner = ConnectionRunner {
        direct: ProcessRunner::default(),
        lease: Some(connection.lease().await.unwrap()),
    };
    connection
        .process
        .lock()
        .unwrap()
        .child
        .as_mut()
        .unwrap()
        .start_kill()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while connection.check_alive().is_ok() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let error = runner
        .run(&["--version".into()], Duration::from_secs(1))
        .await
        .unwrap_err();
    assert!(error.message.contains("disconnected"));
    assert_eq!(manager.list().await[0].status, "disconnected");
}

struct InventoryRunner(&'static str);
impl Runner for InventoryRunner {
    async fn run(&self, args: &[String], _: Duration) -> Result<String> {
        assert_eq!(args, ["gateway", "list", "--output", "json"]);
        Ok(self.0.into())
    }
}

#[tokio::test]
async fn unsupported_or_unregistered_auth_profile_does_not_spawn_ssh() {
    let manager = SshConnections::default();
    for inventory in [
        "[]",
        r#"[{"name":"remote-profile","endpoint":"https://server","active":true,"auth":"cloudflare_jwt"}]"#,
    ] {
        let error = manager
            .connect_using(
                request(),
                InventoryRunner(inventory),
                OsStr::new("/not-an-executable"),
            )
            .await
            .unwrap_err();
        assert!(!error.message.contains("not found on PATH"));
        assert!(manager.list().await.is_empty());
    }
}

#[cfg(unix)]
#[tokio::test]
async fn failed_ssh_configuration_leaves_no_registered_session() {
    let manager = SshConnections::default();
    let result = manager.connect_using(request(), InventoryRunner(r#"[{"name":"remote-profile","endpoint":"https://server","active":true,"auth":"mtls"}]"#), OsStr::new("/usr/bin/false")).await;
    assert!(result.is_err());
    assert!(manager.list().await.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn failed_ssh_child_is_reaped_before_connection_failure_returns() {
    let connection = Connection::spawn(&request(), 41321, OsStr::new("/usr/bin/false")).unwrap();
    let pid = connection
        .process
        .lock()
        .unwrap()
        .child
        .as_ref()
        .unwrap()
        .id()
        .unwrap();
    assert!(connection.wait_for_listener().await.is_err());
    connection.stop().await;
    assert_eq!(connection.status().status, "disconnected");
    #[cfg(target_os = "linux")]
    assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists());
    #[cfg(not(target_os = "linux"))]
    let _ = pid;
}

#[cfg(unix)]
#[tokio::test]
async fn shutdown_reaps_all_sessions_and_old_ids_remain_unusable() {
    let (connection, _) = fixture_connection().await;
    let manager = SshConnections::default();
    manager
        .connections
        .lock()
        .await
        .insert(connection.info.id.clone(), connection);
    let read_lease = manager
        .runner(Some("remote-profile"), Some("ssh-fixture"))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), manager.shutdown())
        .await
        .unwrap();
    assert!(read_lease
        .run(&["--version".into()], Duration::from_secs(1))
        .await
        .is_err());
    assert_eq!(manager.list().await[0].status, "disconnected");
    assert!(manager
        .runner(Some("remote-profile"), Some("ssh-fixture"))
        .await
        .is_err());
}
