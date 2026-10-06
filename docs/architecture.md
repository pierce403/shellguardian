# Architecture

ShellGuardian is a presentation layer over the installed NVIDIA OpenShell CLI.
There is no additional control plane. The Rust adapter is deliberately separate
from Tauri so its command contracts can be tested without GUI libraries.

| Owner | Responsibility |
| --- | --- |
| OpenShell gateway | Sandbox inventory, policies, provider state, authentication, runtime lifecycle |
| OpenShell sandbox/runtime | Network, filesystem, process and credential enforcement |
| Installed OpenShell CLI | Gateway discovery, remote connections, stored authentication, RPC compatibility |
| Rust bridge | Typed, scoped command arguments; bounded execution; safe presentation types |
| Tauri window | Display snapshots, collect user choices, review and request explicit actions |
| Tauri updater | Verify signed app packages and versions; install without changing OpenShell |

The webview cannot execute an arbitrary command or read credential files. IPC
exposes thirteen typed commands. Production CSP restricts network access to the
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

## Actions

Start/stop, provider attach/detach, and policy application require a review dialog
showing the sandbox, gateway and workspace. The backend validates names and uses
fixed arguments; it never launches a shell. It explicitly removes environment
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

## Preview

Sample data is available only through `?preview=1`, with a persistent warning.
Preview actions mutate session memory and return explicit simulated receipts.
Browser mode without that parameter shows a desktop-connection empty state.
No failed live request ever falls back to preview data.
