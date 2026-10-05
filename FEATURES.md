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
  - [ ] Live read-only probe matches installed CLI and gateway output.
  - [ ] Command contract tests cover scoping, pagination, and failures.
  - [ ] Native application connects to a registered gateway.

## Agent supervision

- **Stability**: in-progress
- **Description**: Make each OpenShell sandbox's access understandable.
- **Properties**:
  - List sandbox names, states, images, creation times, and provider attachments.
  - Inspect filesystem, network, process, and resource configuration.
  - Start/stop a sandbox only on an explicit user action with reviewable context.
  - Show errors and stale state, and refresh after a mutation.
  - Clearly distinguish sandbox state from workload/process health.
- **Dependencies**: Stateless OpenShell connection.
- **Test Criteria**:
  - [ ] UI sample preview covers running, stopped, and unavailable states.
  - [ ] Rust tests verify lifecycle argument arrays and invalid target rejection.
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
  - [ ] Rust tests verify allowed mutations and reject invalid names/YAML.
  - [ ] Browser tests cover review/cancel/apply and backend error reporting.
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
  - [ ] Tests cover bounded output, log redaction, timeout, and failure paths.
  - [ ] UI distinguishes unavailable values from observed zero.

## OpenShell update awareness

- **Stability**: in-progress
- **Description**: Compare the installed CLI against NVIDIA's latest stable release.
- **Properties**:
  - Check the official NVIDIA/OpenShell GitHub release endpoint on user request.
  - Distinguish current, update available, ahead, and check unavailable.
  - Link to the official release; never download or execute an installer.
  - A failed update check must not interrupt local gateway access.
- **Dependencies**: Installed CLI, official GitHub releases API.
- **Test Criteria**:
  - [ ] Semver and failure-state tests pass.
  - [ ] Live release metadata matches the official endpoint.

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
