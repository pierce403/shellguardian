# ShellGuardian

A Tauri desktop control room for NVIDIA OpenShell agents. [shellguardian.org](https://shellguardian.org/)

Inspect agent access,
control sandbox lifecycle, manage provider attachments, review network policies,
talk to an interactive agent, open a sandbox terminal, and check the installed
OpenShell version and official release status.

OpenShell owns the state, credentials, authentication, and enforcement.
ShellGuardian has no database, service daemon, or persistent browser storage.
The native Rust bridge uses the installed CLI and its existing registered local
or remote gateways. Session SSH tunnels can reach a remote server through its
registered OpenShell authentication profile. Selecting a gateway in the app does
not change CLI context. The interface follows your OS light or dark appearance.

## Run

Linux x86_64 preview releases are installed per user. No sudo is needed:

```bash
curl -fsSL https://shellguardian.org/install.sh | bash
```

Requires existing OpenShell configuration, GTK 3, and WebKitGTK 4.1 runtime
libraries. The launcher extracts the AppImage without FUSE. Other platforms are
not published yet. For inspection-first and pinned installation, see
[installation and updates](docs/releases.md).

On Ubuntu, open ShellGuardian from Show Apps and choose **Pin to Dash** from its
dock icon. The installer supplies the shield/terminal icon and desktop entry;
updates retain their identity. The app does not change your favorites.

Automatic **ShellGuardian** updates default on. Signed updates download while the
app is open and install when you close it normally, without interrupting an
OpenShell change. Turn them off in OpenShell & settings. Only this preference is
saved, in one small `preferences.json` file. There is no database. OpenShell is
never installed or upgraded automatically.

### Connect over SSH

In **OpenShell & settings**, enter an SSH host alias or `user@host` and explicitly
choose the remote server's existing OpenShell mTLS profile. OpenSSH uses your
configured key or agent and requires a host key already trusted in `known_hosts`.
Configure authentication and host trust with OpenSSH first; the app has no password
or host-key approval prompt.

The remote OpenShell port defaults to `17670`. Leave the SSH port blank to keep
the host alias's configured port, or specify one under Port settings. The tunnel
forwards a private local port to `127.0.0.1` on the remote machine. OpenShell still
verifies mTLS: the remote server's certificate must include IP SAN `127.0.0.1`
for the tunnel endpoint; a `localhost` DNS SAN alone is insufficient.

Connections exist only for the current app session. Disconnect waits for active
operations; closing the app stops its SSH processes. A failed connection remains
disconnected until you reconnect, with no fallback to a different gateway.

### Talk to an agent or open a terminal

Inspect a Ready sandbox, then choose **Talk to agent** or **Open terminal**.
The agent pane attaches its existing main process through OpenShell. An
interactive agent presents its own interface; a shell or headless workload does
not become a chat bot. **Detach agent** leaves that main process running.

The terminal opens a separate `/bin/sh -i` inside the same sandbox, not on your
host. You can inspect files, run commands, and use terminal programs subject to
OpenShell's policies. The workload image must contain `/bin/sh`.

Both panes show their gateway/workspace and use the selected SSH connection when
applicable. Input goes directly to the process, including Ctrl+C. Closing a
terminal ends its connection and asks OpenShell to terminate that exec session;
background or detached jobs may continue. This does not stop the sandbox.
Changing scope or quitting closes the local connections. Output and scrollback
stay in memory and can include sensitive text you ask the sandbox to print.
OpenShell owns its existing agent state and history.

### Development

Requirements: NVIDIA OpenShell 0.1.2, Node.js 22.12+ (validated with 24.19), Rust
1.90+, and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm ci
npm run tauri dev
```

Configure and authenticate gateways with OpenShell first. ShellGuardian opens the
active registered gateway and defaults to the `default` workspace. Pick another
gateway in the top bar or change the session workspace under OpenShell & settings.

To explore the frontend in a browser:

```bash
npm run dev
```

Open `http://127.0.0.1:1420/?preview=1` for explicitly labeled sample data and
simulated controls. The ordinary browser URL never substitutes samples for live
data. Connecting to your actual OpenShell environment requires the desktop app.

## Verify and build

```bash
npm run build
npm run format:check
cargo test -p openshell-bridge --locked
cargo clippy -p openshell-bridge --all-targets --locked -- -D warnings
cargo fmt --all -- --check
npx playwright install chromium
npm test
npm run tauri build
```

The bridge can be tested without native GUI development packages. Read-only live
probes are available separately:

```bash
cargo run -p openshell-bridge --example inspect
cargo run -p openshell-bridge --example inspect -- registered-gateway-name
cargo run -p openshell-bridge --example check_updates
```

For this Linux workstation's restricted build environment, see
[development notes](docs/development.md). The optional header extraction script
uses an ignored development cache; it is not part of the application.

## Current boundaries

- OpenShell 0.1.2 does not expose inference token totals, credential-use counters,
  or CPU/memory usage in the inspected CLI. The app marks them as unavailable.
- Sandbox `Ready` means the sandbox is ready, not that an agent process is healthy.
- The policy editor edits JSON, which OpenShell accepts as YAML. It checks for
  ordinary concurrent edits and delegates policy validation/loading to OpenShell.
  Filesystem, Landlock, and process controls require sandbox recreation.
- Provider changes wait for acknowledgement. Existing processes can retain their
  old environment, even after the attachment changes for new processes.
- No gateway provisioning, sandbox creation/deletion, automatic OpenShell installation,
  token-budget enforcement, or persistent activity archive is included.
- A native tunnel fixture verifies authenticated OpenShell reads and disconnect.
  Physical remote-host acceptance and live agent mutations still require a
  disposable test environment. Existing agents and credentials were not changed.

See [FEATURES.md](FEATURES.md), [architecture](docs/architecture.md), and the
[inspected upstream contract](docs/openshell-contract.md) for acceptance evidence
and ownership boundaries. Repository workflows follow the practical guidance at
[recurse.bot](https://recurse.bot/).

Apache-2.0 licensed. ShellGuardian is an independent project, not an NVIDIA product.

The GTK dependency uses a documented [GLib compatibility backport](vendor/glib/SHELLGUARDIAN.md)
for an upstream string-iterator soundness advisory. Its original license is retained.
