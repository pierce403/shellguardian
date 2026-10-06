# ShellGuardian features

Behavioral specifications follow https://features.md/ and the working conventions
at https://recurse.bot/. Stability is exactly `stable`, `in-progress`, or `planned`.
Acceptance checkboxes require evidence, not assumptions.

## Stateless OpenShell connection

- **Stability**: in-progress
- **Description**: Use the installed OpenShell CLI as the source of truth.
- **Properties**:
  - Show installed CLI version, registered gateways, reachability, authentication,
    and the selected gateway's reported version.
  - Work with registered local or remote gateways without copying credentials.
  - Keep gateway/workspace selection in memory; never change active CLI context.
  - Follow inventory pagination and show partial failures explicitly.
  - No database, persistence layer, localStorage, or application service.
- **Dependencies**: OpenShell 0.1.2, Rust adapter, Tauri IPC.
- **Test Criteria**:
  - [x] Live read-only probe matches installed CLI and gateway output.
  - [x] Command contract tests cover scoping, pagination, and failures.
  - [x] Native application connects to a registered gateway.
  - Evidence: 25 Rust tests, live `inspect` probe, and native WebKit smoke test on 2026-10-05.
  - Remaining: physical remote host acceptance and production release packaging.

## Agent supervision

- **Stability**: in-progress
- **Description**: Make each OpenShell sandbox's access understandable.
- **Properties**:
  - List sandbox names, states, creation times, and provider attachments. Image
    and resource fields appear only when a supported upstream interface exposes them.
  - Inspect filesystem, network, and process policy. Mark resource configuration
    and measurements unavailable when the CLI omits them.
  - Start/stop a sandbox only on an explicit user action with reviewable context.
  - Show errors and stale state, and refresh after a mutation.
  - Clearly distinguish sandbox state from workload/process health.
- **Dependencies**: Stateless OpenShell connection.
- **Test Criteria**:
  - [x] UI sample preview covers ready, stopped, and unavailable states.
  - [x] Rust tests verify lifecycle argument arrays and invalid target rejection.
  - [ ] Native start/stop verified against a disposable authorized sandbox.

## Policies and credential access

- **Stability**: in-progress
- **Description**: Inspect and edit access through OpenShell's enforcement plane.
- **Properties**:
  - Display effective policy and edit the base policy without overriding provider
    or global policy composition.
  - OpenShell validates policy updates and reports application status.
  - Review scope and changes before applying a policy or attaching/detaching a
    provider. Wait for acknowledgement and surface failure or timeout.
  - Provider inventory uses summaries; credential material is never retrieved.
  - Static filesystem/process controls are identified as requiring recreation.
- **Dependencies**: Agent supervision, OpenShell policy/provider commands.
- **Test Criteria**:
  - [x] Rust tests verify allowed mutations and reject invalid names/JSON policies.
  - [x] Browser tests cover review/cancel/apply and backend error reporting.
  - [ ] Native mutation verified against a disposable authorized sandbox.

## Activity and usage

- **Stability**: in-progress
- **Description**: Present gateway-owned logs and honest measurement coverage.
- **Properties**:
  - Retrieve bounded sandbox log windows on demand, with no persistent log store.
  - Redact likely credential material before returning logs to the webview.
  - Never invent token, cost, credential usage, or CPU/memory usage measurements.
  - If the installed CLI has no usage surface, show that limitation in the UI.
- **Dependencies**: OpenShell log command and current CLI contract.
- **Test Criteria**:
  - [x] Tests cover bounded output, log redaction, timeout, and failure paths.
  - [x] UI distinguishes unavailable values from observed zero.
  - Remaining: no upstream usage counters and no live sandbox log acceptance yet.

## OpenShell update awareness

- **Stability**: in-progress
- **Description**: Compare the installed CLI against NVIDIA's latest stable release.
- **Properties**:
  - Check the official NVIDIA/OpenShell GitHub release endpoint once the CLI is
    detected, with an explicit button to check again.
  - Distinguish current, update available, ahead, and check unavailable.
  - Link to the official release; never download or execute an installer.
  - A failed update check must not interrupt local gateway access.
- **Dependencies**: Installed CLI, official GitHub releases API.
- **Test Criteria**:
  - [x] Semver and failure-state tests pass.
  - [x] Live release metadata matches the official endpoint.
  - Evidence: compiled `check_updates` probe and native automatic check both
    reported installed/latest 0.1.2 on 2026-10-05.

## ShellGuardian installation and automatic updates

Stability: in-progress

Properties:

- A per-user `curl | bash` installer downloads the stable Linux x86_64 AppImage
  over HTTPS, verifies the release SHA256, and stages an atomic replacement.
  No sudo, privileged package changes, or OpenShell installation is performed.
- Automatic ShellGuardian updates default on. Only the on/off preference is
  persisted, in one owner-only JSON file, not a database or browser storage.
- Updates use Tauri's signed, version-bound stable release channel. Downloads
  are verified before staging in memory and installed on normal close. Explicit
  restart or manual download is available; opt-out prevents automatic installation.
- In-flight OpenShell changes block installation/close. Development/raw binary
  builds do not self-update. OpenShell upgrades remain separate and explicit.
- A project website explains current scope, installation, update behavior, and
  platform/prerequisite limitations without presenting sample data as live.

Test Criteria:

- [x] Preference defaults, persistence, permissions, corrupt-file fail-closed behavior,
  stale download generations, and in-flight mutation guards have Rust tests.
- [x] Installer checks cover integrity/network failures, unsafe versions, root and
  unsupported platforms, space-containing paths, rollback, and unmanaged/symlink targets.
- [x] Browser tests cover the default-on switch, opt-out, and simulated manual update.
- [ ] Signed public AppImage and installer run successfully from an isolated user path.
- [ ] Native signed old-to-new update, persistent opt-out, and rejection paths verified.
- [ ] Website published from exact committed source with functioning installation links.
- [ ] macOS, Windows, and Linux ARM packages published and accepted. Not yet supported.

## Future extensions

- **Stability**: planned
- **Description**: Add richer native controls as upstream contracts become available.
- **Properties**:
  - Structured policy proposal approvals, upstream usage accounting, and resource
    editing must use supported OpenShell interfaces and capability detection.
  - Gateway onboarding and sandbox creation must preserve OpenShell ownership.
- **Dependencies**: Verified upstream interfaces and dedicated acceptance work.
- **Test Criteria**:
  - [ ] Each extension has a verified upstream contract and native acceptance test.
