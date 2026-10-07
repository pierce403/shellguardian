# Architecture

ShellGuardian is a presentation layer over the installed NVIDIA OpenShell CLI.
There is no additional control plane. The Rust adapter is deliberately separate
from Tauri so its command contracts can be tested without GUI libraries.

| Owner                     | Responsibility                                                                 |
| ------------------------- | ------------------------------------------------------------------------------ |
| OpenShell gateway         | Sandbox inventory, policies, provider state, authentication, runtime lifecycle |
| OpenShell sandbox/runtime | Network, filesystem, process and credential enforcement                        |
| Installed OpenShell CLI   | Gateway discovery, stored authentication, RPC compatibility                    |
| OpenSSH                   | Host configuration, host trust, key/agent authentication, encrypted forwarding |
| Rust bridge               | Typed, scoped commands; bounded execution; in-memory SSH process ownership     |
| Tauri window              | Display snapshots, collect user choices, review and request explicit actions   |
| Tauri updater             | Verify signed app packages and versions; install without changing OpenShell    |

The webview cannot execute an arbitrary host command or read host credential files.
IPC exposes typed commands. Production CSP restricts network access to the
Tauri IPC channel. OpenShell release checks contact the fixed NVIDIA endpoint;
app updates use the fixed ShellGuardian GitHub stable-release channel and signed
assets. Neither accepts frontend-controlled endpoints or trust keys.
The URL opener opens only the fixed official OpenShell releases page.

## Reads

The UI requests a snapshot every 15 seconds. Version/gateway discovery and scoped
status/sandbox/provider inventories are independent. Failures have named areas;
an unavailable inventory is not displayed as an observed zero. Inventories follow
opaque pagination cursors with explicit count/page/output bounds.

Opening an agent fetches its effective policy, editable base policy and attached
provider summaries. Logs are fetched only when the activity view is opened or
refreshed, bounded to 150 lines in the last hour. Views retain data in memory only.
The bridge strips unknown fields from agent/provider presentation types.

OpenShell's reported authentication status is distinct from public endpoint
reachability. Protected reads and actions remain subject to OpenShell's own
authorization; ShellGuardian never weakens TLS verification or adds a separate
identity store.

## SSH transport

OpenShell 0.1.2 stores SSH registration metadata but does not establish this
tunnel for scoped CLI requests. ShellGuardian owns only the transport process;
the user explicitly chooses the remote server's registered mTLS profile.
OpenSSH supplies existing key/agent authentication and strict `known_hosts`
verification. No password, private key, host-key approval, arbitrary SSH option,
or executable crosses IPC. Host aliases keep their configured SSH port unless
the user explicitly supplies a port. Remote OpenShell defaults to port 17670.

Native code reserves a loopback port and invokes `ssh -N -T` to forward
`127.0.0.1:<local-port>` to remote `127.0.0.1:<OpenShell-port>`. It checks effective
SSH configuration and rejects additional forwards. After forwarding opens, an
authenticated OpenShell status read must succeed before the session is usable.
OpenShell receives its selected profile plus a native-generated
`--gateway-endpoint https://127.0.0.1:<local-port>`. The server certificate must
include IP SAN `127.0.0.1`; `localhost` alone does not cover this address. Normal
TLS and mTLS verification remain enabled.

Each session ID is bound to its profile and owned process. A complete bridge
operation holds a lease, including paginated reads and policy read/apply sequences.
Missing, stale, mismatched, or dead sessions return errors rather than routing to
the profile's direct endpoint. Normal disconnect waits for leases before killing
and reaping its child. Normal exit is guarded against mutations and connection
setup, then kills/reaps the app's SSH children without waiting for read leases.
No saved connection list, SSH credentials, or gateway-registration changes are
introduced. SSH configuration remains trusted local-user configuration.

## Actions

Start/stop, provider attach/detach, and policy application require a review dialog
showing the sandbox, gateway and workspace. The backend validates names and uses
fixed arguments; it never launches a host shell. It explicitly removes environment
overrides that could redirect a scoped request to another gateway.

Provider/policy changes request OpenShell acknowledgement. Policy application
re-reads the base policy hash and configuration revision, refuses inherited global
policy replacement, and refuses changes to startup-only controls. A temporary
policy file is owner-only and removed when the command completes. JSON is a
valid YAML document; upstream performs schema and enforcement validation.

The revision check catches normal stale editor state, but is not an atomic
compare-and-swap: the inspected CLI exposes no expected-revision write flag. A
concurrent write between the check and apply remains possible. Do not claim
stronger concurrency guarantees without adding an upstream-supported contract.

Timeout/error does not prove rollback. The UI requires closing and refreshing
before another attempt instead of automatically retrying an uncertain mutation.
The process runner bounds stdout/stderr, closes stdin, and kills a pending CLI
process on cancellation/timeout. CLI-spawned descendants are not independently
managed by ShellGuardian.

## Agent sessions and terminals

User-selected interactive sessions are a separate, explicit sandbox-I/O path.
The native process is always `openshell`, with bridge-validated fixed arguments:
attach the existing main process or run `/bin/sh -i` inside that sandbox. It is
not arbitrary local execution and does not create a second conversation service.
The pane shows its captured gateway, workspace, sandbox, and SSH connection;
changing selection closes it instead of retargeting input.

Linux native PTYs carry raw bytes and resize events. Opaque session IDs belong to
the main window. Native memory limits cover session count, queued input, and
output; bounded read frames feed the emulator only after its previous render
callback completes. Scrollback is memory-only. OSC clipboard and hyperlink
requests are consumed without action; no clipboard, URL, or file-opening addon
is enabled. Terminal output is untrusted data, never application markup.

An interaction holds its SSH lease until the owned CLI process is cleaned up.
Tunnel disconnect closes matching PTYs first; exit closes all PTYs before SSH.
Explicit agent detach sends Ctrl-P Ctrl-Q, then stops only the owned local
transport if needed. It never sends Ctrl-C or `exit` to the agent. Closing an
independent terminal ends that exec session. Normal typing still has its normal
terminal meaning, including the ability to interrupt or exit a process.

The terminal necessarily displays what a user asks their sandbox to print, which
may include sensitive text. Unlike the bounded/redacted activity view, it is a
faithful interactive byte stream. It is never persisted, uploaded, or logged by
ShellGuardian. OpenShell retains ownership of its own main-process output and
last-used-sandbox metadata. See [the inspected contract](openshell-contract.md).

## Credentials and telemetry

Provider inventory/attachments expose credential **names** and expiry metadata,
not values. ShellGuardian never calls credential environment lookup, inference
bundle APIs, or provider creation/rotation. Logs/errors receive best-effort
redaction for common keys, authorization headers, JWTs, private keys, and URL
credentials. Arbitrary application log content may still be sensitive; redaction
is not a complete secret detector.

The local user, installed CLI, Tauri application, and its packaged frontend are
trusted. The UI review dialog is a user workflow, not an authorization boundary
against a compromised application. Agent-facing enforcement belongs to OpenShell.

Token/cost/credential-use statistics are unavailable through the inspected CLI.
There is no local accounting approximation or pretend budget control. New metrics
must come from a verified OpenShell interface and remain gateway-owned.

## App updates and preferences

Automatic ShellGuardian updates default on. Tauri verifies each downloaded
artifact and its signed version; bytes stay in memory until normal close or an
explicit restart. In-flight OpenShell mutations block self-installation and close.
Opt-out cancels/discards pending work, and OpenShell is never upgraded automatically.

The only saved app preference is `autoUpdate` in one atomically replaced owner-only
JSON file. Missing means on; corrupt/unreadable means paused, not silently enabled.
This is not an agent database or a second source of runtime state. See
[installation and updates](releases.md) for file locations and release trust.

## Desktop integration

The UI applies OS light/dark appearance before React renders, then follows Tauri
theme events. A live `prefers-color-scheme` query provides the browser/platform
fallback. Theme changes are session state, with no new preference file.

Ubuntu uses `bot.recurse.shellguardian` for both the GTK app ID and desktop entry
name, with `StartupWMClass=shellguardian` for X11. The installer registers the
scalable shield/terminal icon under the user's hicolor theme. Release AppImages
can repair the exact legacy installer-created entry after an update; absent or
customized launchers/icons are preserved. The app never changes dock favorites.

## Preview

Sample data is available only through `?preview=1`, with a persistent warning.
Preview actions mutate session memory and return explicit simulated receipts.
Browser mode without that parameter shows a desktop-connection empty state.
No failed live request ever falls back to preview data.
