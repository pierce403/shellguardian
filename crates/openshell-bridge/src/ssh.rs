//! In-memory SSH transport for existing OpenShell authentication profiles.
//!
//! OpenSSH owns SSH configuration, host trust and key authentication. OpenShell
//! owns mTLS material. Only this module can construct a loopback endpoint override;
//! frontend inputs never choose an endpoint, command, key file, or SSH option.

use crate::{
    model::{Gateway, GatewayStatus, SshConnection, SshConnectionRequest},
    process::{read_bounded, redact, ProcessRunner, Runner},
    validate_name, Error, Result,
};
use std::{
    collections::HashMap,
    ffi::OsStr,
    net::{IpAddr, TcpListener},
    process::Stdio,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::AsyncReadExt,
    net::TcpStream,
    process::{Child, Command},
    sync::{Mutex, OwnedRwLockReadGuard, RwLock},
};

const START_TIMEOUT: Duration = Duration::from_secs(15);
const STDERR_LIMIT: usize = 16 * 1024;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Validate one SSH destination, never a URI, password, flag or command.
pub fn validate_request(request: &SshConnectionRequest) -> Result<()> {
    validate_name(&request.gateway)?;
    if request.remote_port == 0 || request.ssh_port == Some(0) {
        return Err(Error::new(
            "SSH and gateway ports must be between 1 and 65535.",
        ));
    }
    let destination = &request.destination;
    if destination.is_empty() || destination.len() > 320 {
        return Err(Error::new("Enter an SSH host alias or user@hostname."));
    }
    let (user, host) = match destination.split_once('@') {
        Some((user, host)) => (Some(user), host),
        None => (None, destination.as_str()),
    };
    if user.is_some_and(|user| {
        user.is_empty()
            || user.len() > 64
            || !user.as_bytes()[0].is_ascii_alphanumeric()
            || !user
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
    }) {
        return Err(Error::new(
            "The SSH username contains unsupported characters.",
        ));
    }
    let ip_host = host
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(host);
    let valid_ip = ip_host.parse::<IpAddr>().is_ok();
    let valid_hostname = !host.is_empty()
        && host.len() <= 253
        && host.as_bytes()[0].is_ascii_alphanumeric()
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    if !valid_ip && !valid_hostname {
        return Err(Error::new("Enter an SSH host alias, hostname, or IP address. Configure keys and jump hosts in your SSH config."));
    }
    Ok(())
}

fn ssh_args(request: &SshConnectionRequest, local_port: u16) -> Vec<String> {
    let mut args = vec!["-N".into(), "-T".into(), "-n".into()];
    for option in [
        "BatchMode=yes",
        "StrictHostKeyChecking=yes",
        "ExitOnForwardFailure=yes",
        "ControlMaster=no",
        "ControlPath=none",
        "ControlPersist=no",
        "ForkAfterAuthentication=no",
        "ForwardAgent=no",
        "ForwardX11=no",
        "PermitLocalCommand=no",
        "RemoteCommand=none",
        "ConnectTimeout=10",
        "ConnectionAttempts=1",
        "ServerAliveInterval=15",
        "ServerAliveCountMax=3",
    ] {
        args.extend(["-o".into(), option.into()]);
    }
    if let Some(port) = request.ssh_port {
        args.extend(["-p".into(), port.to_string()]);
    }
    args.extend([
        "-L".into(),
        format!("127.0.0.1:{local_port}:127.0.0.1:{}", request.remote_port),
        "--".into(),
        request.destination.clone(),
    ]);
    args
}

fn validate_forwarding_config(raw: &[u8], local_port: u16, remote_port: u16) -> Result<()> {
    let expected = format!("localforward [127.0.0.1]:{local_port} [127.0.0.1]:{remote_port}");
    let mut expected_count = 0;
    for line in String::from_utf8_lossy(raw).lines() {
        if line.starts_with("remoteforward ")
            || line.starts_with("dynamicforward ")
            || (line.starts_with("localforward ") && line != expected)
        {
            return Err(Error::new("This SSH host configuration contains additional port forwards. Use a dedicated SSH host alias without LocalForward, RemoteForward, or DynamicForward entries."));
        }
        if line == expected {
            expected_count += 1;
        }
    }
    if expected_count != 1 {
        return Err(Error::new("The SSH configuration disabled or duplicated ShellGuardian's local tunnel. Use a dedicated host alias without forwarding overrides."));
    }
    Ok(())
}

/// Inspect effective forwarding only. Full SSH configuration is never returned
/// or logged, and config/key files stay under OpenSSH's control.
async fn check_forwarding_config(
    request: &SshConnectionRequest,
    port: u16,
    executable: &OsStr,
) -> Result<()> {
    let mut child = Command::new(executable)
        .arg("-G")
        .args(ssh_args(request, port))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| {
            Error::new("Could not inspect SSH configuration. Check that OpenSSH is installed.")
        })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::new("SSH configuration output was unavailable."))?;
    let outcome = tokio::time::timeout(Duration::from_secs(5), async {
        let (output, status) = tokio::try_join!(read_bounded(stdout, 256 * 1024), async {
            child.wait().await.map_err(|_| Error::new("Could not inspect SSH configuration."))
        })?;
        if !status.success() {
            return Err(Error::new("SSH could not read this host configuration. Check the destination and your SSH config."));
        }
        validate_forwarding_config(&output, port, request.remote_port)
    }).await.map_err(|_| Error::new("SSH configuration inspection timed out. Check this host alias in your SSH config."));
    match outcome {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) | Err(error) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(error)
        }
    }
}

struct ProcessState {
    child: Option<Child>,
    error: Option<String>,
}

struct Connection {
    info: SshConnection,
    operations: Arc<RwLock<()>>,
    process: StdMutex<ProcessState>,
    stderr: Arc<StdMutex<Vec<u8>>>,
}

impl Connection {
    fn spawn(
        request: &SshConnectionRequest,
        local_port: u16,
        executable: &OsStr,
    ) -> Result<Arc<Self>> {
        let mut child = Command::new(executable)
            .args(ssh_args(request, local_port))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .env("SSH_ASKPASS_REQUIRE", "never")
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    Error::new("OpenSSH was not found on PATH. Install the SSH client, then reopen ShellGuardian.")
                } else {
                    Error::new("Could not start the SSH connection.")
                }
            })?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or_else(|| Error::new("SSH error output was unavailable."))?;
        let captured = Arc::new(StdMutex::new(Vec::new()));
        let captured_task = captured.clone();
        // Keep draining after the display cap so the child cannot block on stderr.
        tokio::spawn(async move {
            let mut chunk = [0u8; 2048];
            loop {
                match stderr.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        let mut bytes = captured_task.lock().expect("SSH stderr lock");
                        let remaining = STDERR_LIMIT.saturating_sub(bytes.len());
                        bytes.extend_from_slice(&chunk[..count.min(remaining)]);
                    }
                }
            }
        });
        let epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        Ok(Arc::new(Self {
            info: SshConnection {
                id: format!("ssh-{epoch}-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed)),
                gateway: request.gateway.clone(),
                destination: request.destination.clone(),
                remote_port: request.remote_port,
                ssh_port: request.ssh_port,
                local_port,
                status: "connected".into(),
                error: None,
            },
            operations: Arc::new(RwLock::new(())),
            process: StdMutex::new(ProcessState {
                child: Some(child),
                error: None,
            }),
            stderr: captured,
        }))
    }

    fn check_alive(&self) -> Result<()> {
        let mut process = self.process.lock().expect("SSH process lock");
        if let Some(error) = &process.error {
            return Err(Error::new(error.clone()));
        }
        if let Some(child) = &mut process.child {
            match child.try_wait() {
                Ok(None) => return Ok(()),
                Err(_) => {
                    // Retain ownership for explicit shutdown even if polling fails.
                    process.error = Some("Could not verify the SSH process. Disconnect and reconnect before continuing.".into());
                }
                Ok(Some(_)) => {
                    process.child = None;
                    let bytes = self.stderr.lock().expect("SSH stderr lock");
                    let detail = redact(&String::from_utf8_lossy(&bytes));
                    process.error = Some(format!(
                        "SSH disconnected. {}",
                        if detail.trim().is_empty() {
                            "Check the SSH host, trusted host key, and key or agent authentication, then reconnect.".into()
                        } else {
                            detail.trim().chars().take(2000).collect::<String>()
                        }
                    ));
                }
            }
        }
        Err(Error::new(process.error.clone().unwrap_or_else(|| {
            "This SSH connection was disconnected. Reconnect before continuing.".into()
        })))
    }

    fn status(&self) -> SshConnection {
        let mut info = self.info.clone();
        if self.check_alive().is_err() {
            info.status = "disconnected".into();
            info.error = self.process.lock().expect("SSH process lock").error.clone();
        }
        info
    }

    async fn stop(&self) {
        // Existing leases cover entire operations, including multi-command writes.
        let _exclusive = self.operations.write().await;
        self.stop_child().await;
    }

    async fn stop_child(&self) {
        let child = self.process.lock().expect("SSH process lock").child.take();
        if let Some(mut child) = child {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }

    async fn wait_for_listener(&self) -> Result<()> {
        tokio::time::timeout(START_TIMEOUT, async {
            loop {
                self.check_alive()?;
                if TcpStream::connect(("127.0.0.1", self.info.local_port)).await.is_ok() {
                    // A conflicting bind can race listener discovery. Check the
                    // owned child again before attempting authenticated traffic.
                    tokio::time::sleep(Duration::from_millis(75)).await;
                    return self.check_alive();
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }).await.map_err(|_| Error::new("SSH did not open its local tunnel in time. Check key or agent authentication and the host's known_hosts entry."))?
    }

    async fn lease(self: &Arc<Self>) -> Result<ConnectionLease> {
        let guard = self.operations.clone().read_owned().await;
        self.check_alive()?;
        Ok(ConnectionLease {
            connection: self.clone(),
            _guard: guard,
        })
    }
}

struct ConnectionLease {
    connection: Arc<Connection>,
    _guard: OwnedRwLockReadGuard<()>,
}

/// A runner holds its connection lease for the whole enclosing Bridge operation.
/// The only endpoint it may add is the leased native SSH listener.
pub struct ConnectionRunner<R = ProcessRunner> {
    direct: R,
    lease: Option<ConnectionLease>,
}

impl<R> ConnectionRunner<R> {
    fn route(&self, args: &[String]) -> Result<Vec<String>> {
        let Some(lease) = &self.lease else {
            return Ok(args.to_vec());
        };
        lease.connection.check_alive()?;
        if args.iter().any(|arg| {
            arg == "--gateway-endpoint"
                || arg == "--gateway-insecure"
                || arg.starts_with("--gateway-endpoint=")
        }) {
            return Err(Error::new(
                "SSH requests cannot override their verified connection endpoint.",
            ));
        }
        let Some(index) = args.iter().position(|arg| arg == "--gateway") else {
            // Version and gateway inventory are local CLI discovery.
            if args == ["--version"] || args == ["gateway", "list", "--output", "json"] {
                return Ok(args.to_vec());
            }
            return Err(Error::new(
                "An SSH request must name its OpenShell authentication profile.",
            ));
        };
        if args.get(index + 1) != Some(&lease.connection.info.gateway) {
            return Err(Error::new(
                "This SSH connection belongs to a different OpenShell profile.",
            ));
        }
        let mut routed = vec![
            "--gateway-endpoint".into(),
            format!("https://127.0.0.1:{}", lease.connection.info.local_port),
        ];
        routed.extend_from_slice(args);
        Ok(routed)
    }
}

impl<R: Runner> Runner for ConnectionRunner<R> {
    fn connection_id(&self) -> Option<&str> {
        self.lease
            .as_ref()
            .map(|lease| lease.connection.info.id.as_str())
    }

    async fn run(&self, args: &[String], timeout: Duration) -> Result<String> {
        let result = self.direct.run(&self.route(args)?, timeout).await;
        if let Some(lease) = &self.lease {
            lease.connection.check_alive()?;
        }
        result
    }
}

/// Owns only in-memory transport sessions. It never writes OpenShell configuration.
#[derive(Default)]
pub struct SshConnections {
    connections: Mutex<HashMap<String, Arc<Connection>>>,
    changes: Mutex<()>,
}

impl SshConnections {
    /// Connect a trusted SSH host using an existing registered mTLS profile.
    pub async fn connect(&self, request: SshConnectionRequest) -> Result<SshConnection> {
        self.connect_using(request, ProcessRunner::default(), OsStr::new("ssh"))
            .await
    }

    async fn connect_using<R: Runner>(
        &self,
        request: SshConnectionRequest,
        runner: R,
        executable: &OsStr,
    ) -> Result<SshConnection> {
        validate_request(&request)?;
        let _change = self.changes.lock().await;
        let raw = runner
            .run(
                &[
                    "gateway".into(),
                    "list".into(),
                    "--output".into(),
                    "json".into(),
                ],
                Duration::from_secs(5),
            )
            .await?;
        let gateways: Vec<Gateway> = serde_json::from_str(&raw)
            .map_err(|_| Error::new("Could not read registered OpenShell profiles."))?;
        let gateway = gateways.iter().find(|gateway| gateway.name == request.gateway)
            .ok_or_else(|| Error::new("Select an existing OpenShell profile for this remote server. Set up its client certificates with OpenShell first."))?;
        if gateway.auth != "mtls" {
            return Err(Error::new("SSH connections currently require an OpenShell mTLS profile. Edge and OIDC profiles should use their registered direct connection."));
        }
        {
            let mut connections = self.connections.lock().await;
            for connection in connections.values() {
                if connection.info.gateway == request.gateway
                    && connection.info.destination == request.destination
                    && connection.info.remote_port == request.remote_port
                    && connection.info.ssh_port == request.ssh_port
                    && connection.check_alive().is_ok()
                {
                    return Err(Error::new("This SSH connection is already open. Select it from Connections, or disconnect it before reconnecting."));
                }
            }
            // Bound retained diagnostics; an evicted ID still fails closed.
            if connections.len() >= 32 {
                connections.retain(|_, connection| connection.check_alive().is_ok());
            }
            if connections
                .values()
                .filter(|connection| connection.check_alive().is_ok())
                .count()
                >= 16
            {
                return Err(Error::new("Disconnect an SSH connection before opening another (16 active connections maximum)."));
            }
        }
        let reservation = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|_| Error::new("Could not reserve a local SSH tunnel port."))?;
        let port = reservation
            .local_addr()
            .map_err(|_| Error::new("Could not read the local SSH port."))?
            .port();
        drop(reservation);
        check_forwarding_config(&request, port, executable).await?;
        let connection = Connection::spawn(&request, port, executable)?;
        let outcome = async {
            connection.wait_for_listener().await?;
            let scoped = ConnectionRunner {
                direct: runner,
                lease: Some(connection.lease().await?),
            };
            let status = scoped
                .run(
                    &[
                        "--color".into(),
                        "never".into(),
                        "--gateway".into(),
                        request.gateway.clone(),
                        "--workspace".into(),
                        "default".into(),
                        "status".into(),
                        "--output".into(),
                        "json".into(),
                    ],
                    Duration::from_secs(20),
                )
                .await?;
            require_authenticated_status(&status)?;
            connection.check_alive()?;
            Ok::<(), Error>(())
        }
        .await;
        if let Err(error) = outcome {
            connection.stop().await;
            return Err(error);
        }
        let info = connection.status();
        self.connections
            .lock()
            .await
            .insert(info.id.clone(), connection);
        Ok(info)
    }

    /// Acquire a lease before a complete scoped operation. Missing/dead IDs and
    /// mismatched profiles return errors; none can fall back to direct access.
    pub async fn runner(
        &self,
        gateway: Option<&str>,
        id: Option<&str>,
    ) -> Result<ConnectionRunner> {
        let lease = match id {
            None => None,
            Some(id) => {
                validate_name(id)?;
                let connection = self.connections.lock().await.get(id).cloned()
                    .ok_or_else(|| Error::new("This SSH connection is no longer available. Reconnect before continuing."))?;
                if gateway != Some(connection.info.gateway.as_str()) {
                    return Err(Error::new(
                        "This SSH connection belongs to a different OpenShell profile.",
                    ));
                }
                Some(connection.lease().await?)
            }
        };
        Ok(ConnectionRunner {
            direct: ProcessRunner::default(),
            lease,
        })
    }

    pub async fn list(&self) -> Vec<SshConnection> {
        let mut connections: Vec<_> = self
            .connections
            .lock()
            .await
            .values()
            .map(|connection| connection.status())
            .collect();
        connections.sort_by(|a, b| a.id.cmp(&b.id));
        connections
    }

    /// Wait for active operations, then terminate and reap the owned SSH child.
    pub async fn disconnect(&self, id: &str) -> Result<()> {
        validate_name(id)?;
        let _change = self.changes.lock().await;
        let connection = self
            .connections
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| Error::new("This SSH connection is no longer available."))?;
        connection.stop().await;
        self.connections.lock().await.remove(id);
        Ok(())
    }

    /// Called after native exit guards have excluded mutations and setup. Abort
    /// read leases immediately so paginated reads cannot delay process exit.
    /// Never sends signals to unowned PIDs.
    pub async fn shutdown(&self) {
        let _change = self.changes.lock().await;
        let connections: Vec<_> = self.connections.lock().await.values().cloned().collect();
        for connection in connections {
            connection.stop_child().await;
        }
    }
}

fn require_authenticated_status(raw: &str) -> Result<()> {
    let status: GatewayStatus = serde_json::from_str(raw)
        .map_err(|_| Error::new("OpenShell returned an unsupported SSH connection status."))?;
    if status.status == "connected"
        && status
            .authentication
            .as_ref()
            .is_some_and(|auth| auth.status == "authenticated")
    {
        return Ok(());
    }
    let detail = serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| error.as_str())
                .map(str::to_owned)
        })
        .map(|error| redact(&error).chars().take(1500).collect::<String>());
    Err(Error::new(format!(
        "The SSH tunnel opened, but OpenShell could not authenticate the gateway. Use this remote server's mTLS profile and a server certificate valid for 127.0.0.1.{}",
        detail.map(|detail| format!(" {detail}")).unwrap_or_default()
    )))
}

#[cfg(test)]
mod tests;
