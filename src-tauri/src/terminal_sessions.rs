//! In-memory, window-owned PTYs for the bridge's two fixed OpenShell interactions.
//!
//! The webview supplies a sandbox and an interaction kind, never a command, local
//! path, environment, or gateway endpoint. A single nonblocking worker per PTY
//! bounds memory and makes close independent of a stalled reader or writer.

use crate::app_updates::AppUpdates;
use openshell_bridge::{
    interactive::{InteractionKind, InteractiveLaunch},
    model::Scope,
    ssh::SshConnections,
    Error, Result,
};
use portable_pty::{CommandBuilder, PtySize};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

const MAX_SESSIONS: usize = 8;
const MAX_OUTPUT: usize = 256 * 1024;
const MAX_READ: usize = 64 * 1024;
const MAX_INPUT: usize = 16 * 1024;
const MAX_QUEUED_INPUT: usize = 64 * 1024;
const INPUT_WAIT: Duration = Duration::from_secs(5);
const DETACH_GRACE: Duration = Duration::from_millis(300);
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub id: String,
    pub kind: InteractionKind,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRead {
    pub data: Vec<u8>,
    pub exited: bool,
    pub exit_code: Option<u32>,
    pub error: Option<String>,
}

#[derive(Default)]
struct Buffers {
    output: VecDeque<u8>,
    input: VecDeque<u8>,
    resize: Option<PtySize>,
    closing: bool,
    process_exited: bool,
    finished: bool,
    exit_code: Option<u32>,
    error: Option<String>,
}

impl Buffers {
    fn input(&mut self, data: &[u8]) -> Result<()> {
        if self.closing || self.process_exited {
            return Err(Error::new("This terminal has closed. Open a new session."));
        }
        if data.len() > MAX_INPUT {
            return Err(Error::new(
                "Terminal input exceeds 16 KiB. Paste a smaller block.",
            ));
        }
        if self.input.len() + data.len() > MAX_QUEUED_INPUT {
            return Err(Error::new(
                "Terminal input is busy. Wait before sending more.",
            ));
        }
        self.input.extend(data);
        Ok(())
    }

    fn read(&mut self) -> TerminalRead {
        let count = self.output.len().min(MAX_READ);
        TerminalRead {
            data: self.output.drain(..count).collect(),
            exited: self.finished && self.output.is_empty(),
            exit_code: self.exit_code,
            error: self.error.clone(),
        }
    }

    fn fail(&mut self, error: impl Into<String>) {
        self.error.get_or_insert_with(|| error.into());
        self.closing = true;
    }
}

enum Lease {
    OpenShell(InteractiveLaunch),
    #[cfg(test)]
    Fixture(Arc<std::sync::atomic::AtomicBool>),
}

impl Lease {
    fn check_alive(&self) -> Result<()> {
        match self {
            Self::OpenShell(launch) => launch.check_alive(),
            #[cfg(test)]
            Self::Fixture(alive) if alive.load(Ordering::SeqCst) => Ok(()),
            #[cfg(test)]
            Self::Fixture(_) => Err(Error::new("Fixture transport disconnected.")),
        }
    }
}

struct Session {
    owner: String,
    connection_id: Option<String>,
    buffers: Arc<Mutex<Buffers>>,
    lease: Arc<Mutex<Option<Lease>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Session {
    fn check_transport(&self) -> Result<()> {
        let result = self
            .lease
            .lock()
            .expect("terminal lease lock")
            .as_ref()
            .map_or(Ok(()), Lease::check_alive);
        if let Err(error) = &result {
            self.buffers
                .lock()
                .expect("terminal buffers lock")
                .fail(error.message.clone());
        }
        result
    }

    fn request_close(&self) {
        self.buffers.lock().expect("terminal buffers lock").closing = true;
    }

    async fn write_when_ready(&self, data: &[u8], timeout: Duration) -> Result<()> {
        if data.len() > MAX_INPUT {
            return Err(Error::new(
                "Terminal input exceeds 16 KiB. Paste a smaller block.",
            ));
        }
        let deadline = Instant::now() + timeout;
        loop {
            self.check_transport()?;
            {
                let mut buffers = self.buffers.lock().expect("terminal buffers lock");
                if buffers.closing
                    || buffers.process_exited
                    || buffers.input.len() + data.len() <= MAX_QUEUED_INPUT
                {
                    return buffers.input(data);
                }
            }
            if Instant::now() >= deadline {
                return Err(Error::new("Terminal input stayed busy. Remaining pasted input was not sent; wait before trying again."));
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn join(&self) {
        if let Some(worker) = self.worker.lock().expect("terminal worker lock").take() {
            let _ = worker.join();
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.request_close();
        self.join();
    }
}

#[derive(Default)]
struct Registry {
    sessions: HashMap<String, Arc<Session>>,
    disconnected: HashSet<String>,
    shutting_down: bool,
}

/// Owns only app-created local CLI processes, never the sandbox's agent process.
pub struct TerminalSessions {
    registry: tokio::sync::Mutex<Registry>,
    slots: Arc<tokio::sync::Semaphore>,
}

impl Default for TerminalSessions {
    fn default() -> Self {
        Self {
            registry: tokio::sync::Mutex::new(Registry::default()),
            slots: Arc::new(tokio::sync::Semaphore::new(MAX_SESSIONS)),
        }
    }
}

fn window_owner(label: &str) -> Result<()> {
    if label != "main" {
        return Err(Error::new(
            "Terminals are available only in ShellGuardian's main window.",
        ));
    }
    Ok(())
}

fn dimensions(cols: u16, rows: u16) -> Result<PtySize> {
    if !(2..=500).contains(&cols) || !(1..=300).contains(&rows) {
        return Err(Error::new(
            "Terminal size must be 2–500 columns and 1–300 rows.",
        ));
    }
    Ok(PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    })
}

fn openshell_command(args: &[String]) -> CommandBuilder {
    let mut command = CommandBuilder::new("openshell");
    command.args(args);
    command.env("TERM", "xterm-256color");
    for variable in [
        "OPENSHELL_GATEWAY_ENDPOINT",
        "OPENSHELL_GATEWAY_INSECURE",
        "OPENSHELL_GATEWAY",
        "OPENSHELL_WORKSPACE",
    ] {
        command.env_remove(variable);
    }
    command
}

fn owned_session(registry: &Registry, owner: &str, id: &str) -> Result<Arc<Session>> {
    window_owner(owner)?;
    registry
        .sessions
        .get(id)
        .filter(|session| session.owner == owner)
        .cloned()
        .ok_or_else(|| Error::new("This terminal session is unavailable. Open a new session."))
}

impl TerminalSessions {
    #[allow(clippy::too_many_arguments)]
    async fn open(
        &self,
        connections: &SshConnections,
        owner: &str,
        scope: Scope,
        name: &str,
        kind: InteractionKind,
        size: PtySize,
    ) -> Result<TerminalSession> {
        window_owner(owner)?;
        // Serialize setup with disconnect/shutdown so an in-flight preflight
        // cannot insert a terminal after the connection's close sweep.
        let mut registry = self.registry.lock().await;
        if registry.shutting_down
            || scope
                .connection_id
                .as_ref()
                .is_some_and(|id| registry.disconnected.contains(id))
        {
            return Err(Error::new(
                "This connection is closing. Reconnect before opening a terminal.",
            ));
        }
        if registry.sessions.len() >= MAX_SESSIONS {
            return Err(Error::new(
                "Close an existing terminal before opening another (maximum eight).",
            ));
        }
        // A closing worker still consumes a slot until its process is reaped.
        let slot = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::new("A terminal is still closing. Try again shortly."))?;
        let launch = connections.prepare_interaction(&scope, name, kind).await?;
        launch.check_alive()?;
        let command = openshell_command(&launch.args);
        let session = spawn_session(
            owner,
            scope.connection_id,
            kind,
            size,
            command,
            Lease::OpenShell(launch),
            Some(slot),
        )?;
        let id = format!("terminal-{}", NEXT_SESSION.fetch_add(1, Ordering::Relaxed));
        registry.sessions.insert(id.clone(), session);
        Ok(TerminalSession { id, kind })
    }

    async fn read(&self, owner: &str, id: &str) -> Result<TerminalRead> {
        let session = owned_session(&*self.registry.lock().await, owner, id)?;
        // Preserve buffered output on transport death, but close without fallback.
        let _ = session.check_transport();
        let result = session
            .buffers
            .lock()
            .expect("terminal buffers lock")
            .read();
        Ok(result)
    }

    async fn write(&self, owner: &str, id: &str, data: &str) -> Result<()> {
        let session = owned_session(&*self.registry.lock().await, owner, id)?;
        session.write_when_ready(data.as_bytes(), INPUT_WAIT).await
    }

    async fn resize(&self, owner: &str, id: &str, size: PtySize) -> Result<()> {
        let session = owned_session(&*self.registry.lock().await, owner, id)?;
        session.check_transport()?;
        let mut buffers = session.buffers.lock().expect("terminal buffers lock");
        if buffers.closing || buffers.process_exited {
            return Err(Error::new("This terminal has closed. Open a new session."));
        }
        // Coalesce rapid resize events rather than growing another queue.
        buffers.resize = Some(size);
        Ok(())
    }

    async fn close(&self, owner: &str, id: &str) -> Result<()> {
        window_owner(owner)?;
        let session = {
            let mut registry = self.registry.lock().await;
            if !registry.sessions.contains_key(id) {
                // A disconnect sweep or a lost successful close reply must not
                // trap the frontend in a dialog whose session already ended.
                return Ok(());
            }
            let session = owned_session(&registry, owner, id)?;
            session.request_close();
            registry.sessions.remove(id);
            session
        };
        let _ = tauri::async_runtime::spawn_blocking(move || session.join()).await;
        Ok(())
    }

    /// Close terminals before waiting for an SSH disconnect's exclusive lease.
    pub async fn close_for_connection(&self, connection_id: &str) {
        let sessions = {
            let mut registry = self.registry.lock().await;
            registry.disconnected.insert(connection_id.to_owned());
            let ids: Vec<_> = registry
                .sessions
                .iter()
                .filter(|(_, session)| session.connection_id.as_deref() == Some(connection_id))
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| registry.sessions.remove(&id))
                .collect()
        };
        close_sessions(sessions).await;
    }

    /// Release all PTY transports before shutting down app-owned SSH tunnels.
    pub async fn shutdown(&self) {
        let sessions = {
            let mut registry = self.registry.lock().await;
            registry.shutting_down = true;
            registry
                .sessions
                .drain()
                .map(|(_, session)| session)
                .collect()
        };
        close_sessions(sessions).await;
        // A concurrent close IPC removes its entry before awaiting cleanup.
        // Its worker still owns a slot, so wait for those off-registry workers
        // too before app Exit is allowed to tear down tunnels or the runtime.
        let _all_workers_finished = self
            .slots
            .clone()
            .acquire_many_owned(MAX_SESSIONS as u32)
            .await;
    }
}

async fn close_sessions(sessions: Vec<Arc<Session>>) {
    for session in &sessions {
        session.request_close();
    }
    let _ = tauri::async_runtime::spawn_blocking(move || {
        for session in sessions {
            session.join();
        }
    })
    .await;
}

#[cfg(target_os = "linux")]
fn spawn_session(
    owner: &str,
    connection_id: Option<String>,
    kind: InteractionKind,
    size: PtySize,
    command: CommandBuilder,
    lease: Lease,
    slot: Option<tokio::sync::OwnedSemaphorePermit>,
) -> Result<Arc<Session>> {
    let pair = portable_pty::native_pty_system()
        .openpty(size)
        .map_err(|_| Error::new("Could not allocate a local pseudo-terminal."))?;
    let fd = pair.master.as_raw_fd().ok_or_else(|| {
        Error::new("This platform does not provide a controllable pseudo-terminal.")
    })?;
    // SAFETY: fd belongs to pair.master, which outlives every read/write below.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(Error::new("Could not configure nonblocking terminal I/O."));
    }
    let child = pair.slave.spawn_command(command).map_err(|_| {
        Error::new("Could not start OpenShell. Check that its CLI is installed and executable.")
    })?;
    drop(pair.slave);
    let process = OwnedProcess {
        child,
        master: pair.master,
        reaped: false,
    };
    let session = Arc::new(Session {
        owner: owner.to_owned(),
        connection_id,
        buffers: Arc::new(Mutex::new(Buffers::default())),
        lease: Arc::new(Mutex::new(Some(lease))),
        worker: Mutex::new(None),
    });
    let buffers = session.buffers.clone();
    let lease = session.lease.clone();
    let worker = std::thread::Builder::new()
        .name("openshell-terminal".into())
        .spawn(move || {
            let _slot = slot;
            supervise(process, kind, buffers, lease);
        })
        .map_err(|_| Error::new("Could not start the terminal I/O worker."))?;
    *session.worker.lock().expect("terminal worker lock") = Some(worker);
    Ok(session)
}

#[cfg(not(target_os = "linux"))]
fn spawn_session(
    _owner: &str,
    _connection_id: Option<String>,
    _kind: InteractionKind,
    _size: PtySize,
    _command: CommandBuilder,
    _lease: Lease,
    _slot: Option<tokio::sync::OwnedSemaphorePermit>,
) -> Result<Arc<Session>> {
    Err(Error::new(
        "Interactive terminals are currently supported on Linux.",
    ))
}

#[cfg(target_os = "linux")]
struct OwnedProcess {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    reaped: bool,
}

#[cfg(target_os = "linux")]
impl OwnedProcess {
    fn kill_group(&mut self) {
        // portable-pty creates a fresh session with setsid before exec. Confirm
        // the still-owned, unreaped child is its group leader before signalling
        // that group. This reaches its local SSH helpers, never a remote agent.
        if let Some(pid) = self
            .child
            .process_id()
            .and_then(|pid| i32::try_from(pid).ok())
        {
            // SAFETY: this is the unreaped child, not a frontend-provided PID.
            if pid > 1 && unsafe { libc::getpgid(pid) } == pid {
                unsafe {
                    libc::kill(-pid, libc::SIGKILL);
                }
            } else if pid > 1 {
                // Kill directly, not portable-pty's SIGHUP-first convenience
                // method: no local signal handler may forward a remote stop.
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        } else {
            let _ = self.child.kill();
        }
    }

    fn poll_exit(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
        let pid = self
            .child
            .process_id()
            .ok_or_else(|| std::io::Error::other("missing owned child id"))?;
        // Inspect without reaping first, keeping the PID reserved while cleaning
        // up local descendants if the CLI exited ahead of its SSH helper.
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
        // SAFETY: info points to the correct initialized Linux waitid structure;
        // the child ID belongs to this worker and WNOWAIT leaves it unreaped.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let info = unsafe { info.assume_init() };
        if unsafe { info.si_pid() } == 0 {
            return Ok(None);
        }
        self.kill_group();
        self.child.try_wait()
    }

    fn kill_and_reap(&mut self) -> Option<u32> {
        if self.reaped {
            return None;
        }
        self.kill_group();
        let status = self.child.wait().ok().map(|status| status.exit_code());
        self.reaped = true;
        status
    }
}

#[cfg(target_os = "linux")]
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        self.kill_and_reap();
    }
}

#[cfg(target_os = "linux")]
fn read_output(fd: i32, buffers: &mut Buffers) -> bool {
    let available = (MAX_OUTPUT - buffers.output.len()).min(8192);
    if available == 0 {
        return false;
    }
    let mut bytes = [0u8; 8192];
    // SAFETY: fd remains owned by the worker's master and the destination has
    // exactly the checked capacity. O_NONBLOCK prevents an indefinite read.
    let count = unsafe { libc::read(fd, bytes.as_mut_ptr().cast(), available) };
    if count > 0 {
        buffers.output.extend(&bytes[..count as usize]);
        false
    } else if count == 0 {
        true
    } else {
        let error = std::io::Error::last_os_error();
        // Linux PTYs report EIO when the last slave closes.
        if error.raw_os_error() == Some(libc::EIO) {
            return true;
        }
        if !matches!(
            error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
        ) {
            buffers.fail("Could not read terminal output.");
        }
        false
    }
}

#[cfg(target_os = "linux")]
fn write_input(fd: i32, buffers: &mut Buffers) {
    let (bytes, _) = buffers.input.as_slices();
    let count = bytes.len().min(4096);
    if count == 0 {
        return;
    }
    // SAFETY: fd and this slice remain valid for the nonblocking syscall.
    let written = unsafe { libc::write(fd, bytes.as_ptr().cast(), count) };
    if written > 0 {
        buffers.input.drain(..written as usize);
    } else if written < 0 {
        let error = std::io::Error::last_os_error();
        if !matches!(
            error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
        ) {
            buffers.fail("Could not send terminal input.");
        }
    }
}

#[cfg(target_os = "linux")]
fn supervise(
    mut process: OwnedProcess,
    kind: InteractionKind,
    buffers: Arc<Mutex<Buffers>>,
    lease: Arc<Mutex<Option<Lease>>>,
) {
    let fd = process.master.as_raw_fd().expect("validated PTY fd");
    let mut closing_since = None;
    let mut eof = false;
    loop {
        let alive = lease
            .lock()
            .expect("terminal lease lock")
            .as_ref()
            .map_or(Ok(()), Lease::check_alive);
        let mut state = buffers.lock().expect("terminal buffers lock");
        if let Err(error) = alive {
            state.fail(error.message);
        }
        if state.closing && closing_since.is_none() {
            state.input.clear();
            if kind == InteractionKind::Agent && !state.process_exited {
                // OpenShell's detach escape, never Ctrl-C or sandbox stop.
                state.input.extend([0x10, 0x11]);
            }
            closing_since = Some(Instant::now());
        }
        if let Some(size) = state.resize.take() {
            if process.master.resize(size).is_err() {
                state.fail("Could not resize the terminal.");
            }
        }
        if !state.process_exited {
            write_input(fd, &mut state);
        }
        if !eof {
            eof = read_output(fd, &mut state);
        }
        if !process.reaped {
            match process.poll_exit() {
                Ok(Some(status)) => {
                    process.reaped = true;
                    state.process_exited = true;
                    state.exit_code = Some(status.exit_code());
                }
                Ok(None) => {}
                Err(_) => state.fail("Could not check the terminal process."),
            }
        }
        if state.process_exited {
            // A slow webview may still be draining bounded output; it must not
            // keep an SSH disconnect waiting on an already-ended CLI session.
            lease.lock().expect("terminal lease lock").take();
        }
        if closing_since
            .is_some_and(|since| kind != InteractionKind::Agent || since.elapsed() >= DETACH_GRACE)
        {
            drop(state);
            let code = process.kill_and_reap();
            state = buffers.lock().expect("terminal buffers lock");
            state.exit_code = state.exit_code.or(code);
            state.process_exited = true;
            state.finished = true;
            break;
        }
        if state.process_exited && eof {
            state.finished = true;
            break;
        }
        let can_read = state.output.len() < MAX_OUTPUT && !eof;
        let can_write = !state.input.is_empty() && !state.process_exited;
        drop(state);
        // A fixed heartbeat notices close/resize/dead transport even if neither
        // endpoint is consuming data. Memory backpressure never blocks cleanup.
        let mut descriptor = libc::pollfd {
            fd,
            events: (if can_read { libc::POLLIN } else { 0 })
                | (if can_write { libc::POLLOUT } else { 0 }),
            revents: 0,
        };
        if descriptor.events == 0 {
            std::thread::sleep(Duration::from_millis(20));
        } else {
            // SAFETY: descriptor is initialized and points to one live fd.
            unsafe {
                libc::poll(&mut descriptor, 1, 20);
            }
        }
    }
    lease.lock().expect("terminal lease lock").take();
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn open_agent_terminal(
    window: tauri::WebviewWindow,
    updates: tauri::State<'_, AppUpdates>,
    connections: tauri::State<'_, SshConnections>,
    terminals: tauri::State<'_, TerminalSessions>,
    scope: Scope,
    name: String,
    kind: InteractionKind,
    cols: u16,
    rows: u16,
) -> Result<TerminalSession> {
    window_owner(window.label())?;
    let size = dimensions(cols, rows)?;
    let _guard = updates.mutation().map_err(Error::new)?;
    terminals
        .open(&connections, window.label(), scope, &name, kind, size)
        .await
}

#[tauri::command]
pub async fn read_agent_terminal(
    window: tauri::WebviewWindow,
    terminals: tauri::State<'_, TerminalSessions>,
    session_id: String,
) -> Result<TerminalRead> {
    terminals.read(window.label(), &session_id).await
}

#[tauri::command]
pub async fn write_agent_terminal(
    window: tauri::WebviewWindow,
    terminals: tauri::State<'_, TerminalSessions>,
    session_id: String,
    data: String,
) -> Result<()> {
    terminals.write(window.label(), &session_id, &data).await
}

#[tauri::command]
pub async fn resize_agent_terminal(
    window: tauri::WebviewWindow,
    terminals: tauri::State<'_, TerminalSessions>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<()> {
    terminals
        .resize(window.label(), &session_id, dimensions(cols, rows)?)
        .await
}

#[tauri::command]
pub async fn close_agent_terminal(
    window: tauri::WebviewWindow,
    terminals: tauri::State<'_, TerminalSessions>,
    session_id: String,
) -> Result<()> {
    terminals.close(window.label(), &session_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queued_session() -> Arc<Session> {
        Arc::new(Session {
            owner: "main".into(),
            connection_id: None,
            buffers: Arc::new(Mutex::new(Buffers {
                input: VecDeque::from(vec![b'x'; MAX_QUEUED_INPUT]),
                ..Buffers::default()
            })),
            lease: Arc::new(Mutex::new(None)),
            worker: Mutex::new(None),
        })
    }

    #[tokio::test]
    async fn input_waits_for_queue_room_without_dropping_the_session() {
        let session = queued_session();
        let (result, ()) = tokio::join!(
            session.write_when_ready(b"paste", Duration::from_secs(1)),
            async {
                tokio::time::sleep(Duration::from_millis(20)).await;
                session.buffers.lock().unwrap().input.clear();
            }
        );
        result.unwrap();
        assert_eq!(
            session
                .buffers
                .lock()
                .unwrap()
                .input
                .iter()
                .copied()
                .collect::<Vec<_>>(),
            b"paste"
        );
        assert!(!session.buffers.lock().unwrap().closing);
    }

    #[tokio::test]
    async fn input_wait_is_bounded_and_close_interrupts_it() {
        let session = queued_session();
        let error = session
            .write_when_ready(b"paste", Duration::from_millis(20))
            .await
            .unwrap_err();
        assert!(error.message.contains("stayed busy"));
        assert!(!session.buffers.lock().unwrap().closing);
        let (result, ()) = tokio::join!(
            session.write_when_ready(b"paste", Duration::from_secs(1)),
            async {
                tokio::time::sleep(Duration::from_millis(20)).await;
                session.request_close();
            }
        );
        assert!(result.unwrap_err().message.contains("closed"));
    }

    #[tokio::test]
    async fn close_is_idempotent_without_relaxing_window_ownership() {
        let terminals = TerminalSessions::default();
        terminals
            .registry
            .lock()
            .await
            .sessions
            .insert("fixture".into(), queued_session());
        terminals.close("main", "fixture").await.unwrap();
        terminals.close("main", "fixture").await.unwrap();
        assert!(terminals.close("other", "fixture").await.is_err());
        assert!(terminals.read("main", "fixture").await.is_err());
        assert!(terminals.write("main", "fixture", "x").await.is_err());
        assert!(terminals
            .resize("main", "fixture", dimensions(80, 24).unwrap())
            .await
            .is_err());
    }

    #[test]
    fn command_is_fixed_and_cannot_inherit_scope_or_insecure_overrides() {
        let command = openshell_command(&["sandbox".into(), "connect".into(), "fixture".into()]);
        assert_eq!(
            command.get_argv(),
            &["openshell", "sandbox", "connect", "fixture"]
        );
        assert_eq!(
            command.get_env("TERM"),
            Some(std::ffi::OsStr::new("xterm-256color"))
        );
        assert!(command.get_cwd().is_none());
        for variable in [
            "OPENSHELL_GATEWAY_ENDPOINT",
            "OPENSHELL_GATEWAY_INSECURE",
            "OPENSHELL_GATEWAY",
            "OPENSHELL_WORKSPACE",
        ] {
            assert!(command.get_env(variable).is_none());
        }
    }

    #[test]
    fn dimensions_reject_zero_and_unbounded_cells() {
        assert!(dimensions(80, 24).is_ok());
        assert!(dimensions(2, 1).is_ok());
        assert!(dimensions(500, 300).is_ok());
        for (cols, rows) in [(0, 24), (1, 24), (501, 24), (80, 0), (80, 301)] {
            assert!(dimensions(cols, rows).is_err());
        }
    }

    #[test]
    fn input_is_byte_bounded_and_rejects_after_close() {
        let mut buffers = Buffers::default();
        assert!(buffers.input(&vec![0; MAX_INPUT + 1]).is_err());
        for _ in 0..4 {
            buffers.input(&vec![0; MAX_INPUT]).unwrap();
        }
        assert!(buffers.input(b"x").is_err());
        assert_eq!(buffers.input.len(), MAX_QUEUED_INPUT);
        buffers.closing = true;
        assert!(buffers.input(b"").is_err());
    }

    #[test]
    fn reads_preserve_bytes_and_only_report_exit_after_last_output() {
        let mut buffers = Buffers {
            finished: true,
            exit_code: Some(7),
            ..Buffers::default()
        };
        buffers
            .output
            .extend((0..MAX_READ + 3).map(|i| (i % 256) as u8));
        let first = buffers.read();
        assert_eq!(first.data.len(), MAX_READ);
        assert!(!first.exited);
        let last = buffers.read();
        assert_eq!(last.data, [0, 1, 2]);
        assert!(last.exited);
        assert_eq!(last.exit_code, Some(7));
    }

    #[test]
    fn only_main_window_can_access_its_session() {
        let mut registry = Registry::default();
        registry.sessions.insert(
            "one".into(),
            Arc::new(Session {
                owner: "main".into(),
                connection_id: None,
                buffers: Arc::new(Mutex::new(Buffers::default())),
                lease: Arc::new(Mutex::new(None)),
                worker: Mutex::new(None),
            }),
        );
        assert!(owned_session(&registry, "main", "one").is_ok());
        assert!(owned_session(&registry, "other", "one").is_err());
        assert!(owned_session(&registry, "main", "missing").is_err());
    }

    #[cfg(unix)]
    fn fixture(
        kind: InteractionKind,
        executable: &str,
        args: &[&str],
    ) -> (Arc<Session>, Arc<std::sync::atomic::AtomicBool>) {
        let alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let mut command = CommandBuilder::new(executable);
        command.args(args);
        let session = spawn_session(
            "main",
            Some("fixture-connection".into()),
            kind,
            dimensions(80, 24).unwrap(),
            command,
            Lease::Fixture(alive.clone()),
            None,
        )
        .unwrap();
        (session, alive)
    }

    #[cfg(unix)]
    fn wait_for(session: &Session, predicate: impl Fn(&Buffers) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !predicate(&session.buffers.lock().unwrap()) {
            if Instant::now() > deadline {
                session.request_close();
                session.join();
                panic!("terminal fixture timed out");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    #[cfg(unix)]
    fn real_pty_handles_input_resize_and_releases_lease_on_exit() {
        let (session, _) = fixture(InteractionKind::Terminal, "/usr/bin/cat", &[]);
        session
            .buffers
            .lock()
            .unwrap()
            .input(b"terminal-fixture\n")
            .unwrap();
        wait_for(&session, |state| !state.output.is_empty());
        session.buffers.lock().unwrap().resize = Some(dimensions(101, 39).unwrap());
        session.request_close();
        session.join();
        assert!(session.buffers.lock().unwrap().finished);
        assert!(session.lease.lock().unwrap().is_none());
    }

    #[test]
    #[cfg(unix)]
    fn stalled_output_is_bounded_and_close_does_not_deadlock() {
        let (session, _) = fixture(
            InteractionKind::Terminal,
            "/usr/bin/yes",
            &["bounded-fixture"],
        );
        wait_for(&session, |state| state.output.len() == MAX_OUTPUT);
        std::thread::sleep(Duration::from_millis(60));
        assert_eq!(session.buffers.lock().unwrap().output.len(), MAX_OUTPUT);
        let before = Instant::now();
        session.request_close();
        session.join();
        assert!(before.elapsed() < Duration::from_secs(2));
    }

    #[test]
    #[cfg(unix)]
    fn transport_death_autonomously_closes_without_polling() {
        let (session, alive) = fixture(InteractionKind::Terminal, "/usr/bin/cat", &[]);
        alive.store(false, Ordering::SeqCst);
        wait_for(&session, |state| state.finished);
        session.join();
        assert_eq!(
            session.buffers.lock().unwrap().error.as_deref(),
            Some("Fixture transport disconnected.")
        );
        assert!(session.lease.lock().unwrap().is_none());
    }

    #[test]
    #[cfg(unix)]
    fn natural_exit_preserves_output_and_exit_code() {
        let (session, _) = fixture(
            InteractionKind::Terminal,
            "/usr/bin/printf",
            &["terminal-fixture"],
        );
        wait_for(&session, |state| state.finished);
        session.join();
        let result = session.buffers.lock().unwrap().read();
        assert_eq!(result.data, b"terminal-fixture");
        assert_eq!(result.exit_code, Some(0));
        assert!(result.exited);
        assert!(session.lease.lock().unwrap().is_none());
    }

    #[test]
    #[cfg(target_os = "linux")]
    #[ignore = "Only run as an isolated child of the PTY tests"]
    fn pty_fixture_child() {
        use std::io::{Read, Write};
        let mode = std::env::var("SHELLGUARDIAN_PTY_FIXTURE").expect("PTY fixture marker");
        let mut termios = std::mem::MaybeUninit::<libc::termios>::zeroed();
        assert_eq!(unsafe { libc::tcgetattr(0, termios.as_mut_ptr()) }, 0);
        let mut termios = unsafe { termios.assume_init() };
        unsafe {
            libc::cfmakeraw(&mut termios);
        }
        assert_eq!(unsafe { libc::tcsetattr(0, libc::TCSANOW, &termios) }, 0);
        std::io::stdout().write_all(b"fixture-ready\n").unwrap();
        std::io::stdout().flush().unwrap();
        if mode == "detach" {
            let mut bytes = [0u8; 2];
            std::io::stdin().read_exact(&mut bytes).unwrap();
            assert_eq!(bytes, [0x10, 0x11]);
            std::io::stdout().write_all(b"detach-ok\n").unwrap();
        } else if mode == "resize" {
            let mut byte = [0u8; 1];
            std::io::stdin().read_exact(&mut byte).unwrap();
            let mut size = std::mem::MaybeUninit::<libc::winsize>::zeroed();
            assert_eq!(
                unsafe { libc::ioctl(0, libc::TIOCGWINSZ, size.as_mut_ptr()) },
                0
            );
            let size = unsafe { size.assume_init() };
            assert_eq!((size.ws_col, size.ws_row), (101, 39));
            std::io::stdout().write_all(b"resize-ok\n").unwrap();
        } else {
            panic!("unknown fixture mode");
        }
        std::io::stdout().flush().unwrap();
    }

    #[cfg(target_os = "linux")]
    fn controlled_fixture(mode: &str, kind: InteractionKind) -> Arc<Session> {
        let mut command = CommandBuilder::new(std::env::current_exe().unwrap());
        command.args([
            "--ignored",
            "--exact",
            "terminal_sessions::tests::pty_fixture_child",
            "--nocapture",
        ]);
        command.env("SHELLGUARDIAN_PTY_FIXTURE", mode);
        let session = spawn_session(
            "main",
            None,
            kind,
            dimensions(80, 24).unwrap(),
            command,
            Lease::Fixture(Arc::new(std::sync::atomic::AtomicBool::new(true))),
            None,
        )
        .unwrap();
        wait_for(&session, |state| {
            String::from_utf8_lossy(&state.output.iter().copied().collect::<Vec<_>>())
                .contains("fixture-ready")
        });
        session
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn agent_close_sends_detach_escape_without_ctrl_c() {
        let session = controlled_fixture("detach", InteractionKind::Agent);
        session.request_close();
        session.join();
        let result = session.buffers.lock().unwrap().read();
        assert_eq!(result.exit_code, Some(0));
        assert!(String::from_utf8_lossy(&result.data).contains("detach-ok"));
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn resize_reaches_the_real_pty_slave() {
        let session = controlled_fixture("resize", InteractionKind::Terminal);
        session.buffers.lock().unwrap().resize = Some(dimensions(101, 39).unwrap());
        wait_for(&session, |state| state.resize.is_none());
        session.buffers.lock().unwrap().input(b"x").unwrap();
        wait_for(&session, |state| state.finished);
        session.join();
        let result = session.buffers.lock().unwrap().read();
        assert_eq!(result.exit_code, Some(0));
        assert!(String::from_utf8_lossy(&result.data).contains("resize-ok"));
    }

    #[tokio::test]
    #[cfg(target_os = "linux")]
    async fn connection_close_and_shutdown_release_owned_sessions() {
        let terminals = TerminalSessions::default();
        let (session, alive) = fixture(InteractionKind::Agent, "/usr/bin/cat", &[]);
        terminals
            .registry
            .lock()
            .await
            .sessions
            .insert("fixture-session".into(), session.clone());
        terminals.close_for_connection("unrelated").await;
        assert_eq!(terminals.registry.lock().await.sessions.len(), 1);
        terminals.close_for_connection("fixture-connection").await;
        assert!(terminals.registry.lock().await.sessions.is_empty());
        assert!(terminals
            .registry
            .lock()
            .await
            .disconnected
            .contains("fixture-connection"));
        assert!(session.buffers.lock().unwrap().finished);
        assert_eq!(Arc::strong_count(&alive), 1);
        assert!(terminals.read("main", "fixture-session").await.is_err());
        terminals.shutdown().await;
        assert!(terminals.registry.lock().await.shutting_down);
    }

    #[tokio::test]
    #[cfg(target_os = "linux")]
    async fn shutdown_waits_for_a_worker_already_removed_by_close() {
        let terminals = Arc::new(TerminalSessions::default());
        let slot = terminals.slots.clone().acquire_owned().await.unwrap();
        let session = spawn_session(
            "main",
            None,
            InteractionKind::Agent,
            dimensions(80, 24).unwrap(),
            CommandBuilder::new("/usr/bin/cat"),
            Lease::Fixture(Arc::new(std::sync::atomic::AtomicBool::new(true))),
            Some(slot),
        )
        .unwrap();
        terminals
            .registry
            .lock()
            .await
            .sessions
            .insert("closing".into(), session.clone());
        let close_state = terminals.clone();
        let close = tokio::spawn(async move { close_state.close("main", "closing").await });
        while terminals
            .registry
            .lock()
            .await
            .sessions
            .contains_key("closing")
        {
            tokio::task::yield_now().await;
        }
        terminals.shutdown().await;
        assert!(session.buffers.lock().unwrap().finished);
        assert!(session.lease.lock().unwrap().is_none());
        assert_eq!(terminals.slots.available_permits(), MAX_SESSIONS);
        close.await.unwrap().unwrap();
    }
}
