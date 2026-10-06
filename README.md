# ShellGuardian

A Tauri desktop control room for NVIDIA OpenShell agents. Inspect agent access,
control sandbox lifecycle, manage provider attachments, review network policies,
and check the installed OpenShell version and official release status.

OpenShell owns the state, credentials, authentication, and enforcement.
ShellGuardian has no database, service daemon, or persistent browser storage.
The native Rust bridge uses the installed CLI and its existing registered local
or remote gateways. Selecting a gateway in the app does not change CLI context.

## Run

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
- No gateway provisioning, sandbox creation/deletion, automatic installation,
  token-budget enforcement, or persistent activity archive is included.
- Live mutation and remote-host acceptance still require a disposable test
  environment. Existing agents and credentials were not changed during development.

See [FEATURES.md](FEATURES.md), [architecture](docs/architecture.md), and the
[inspected upstream contract](docs/openshell-contract.md) for acceptance evidence
and ownership boundaries. Repository workflows follow the practical guidance at
[recurse.bot](https://recurse.bot/).

Apache-2.0 licensed. ShellGuardian is an independent project, not an NVIDIA product.

The GTK dependency uses a documented [GLib compatibility backport](vendor/glib/SHELLGUARDIAN.md)
for an upstream string-iterator soundness advisory. Its original license is retained.
