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
  - Evidence: live `inspect` and native WebKit smoke tests; published Linux x86_64
    AppImage accepted on 2026-10-06. Current suites pass 38 bridge and 18 native tests.
  - Remaining: physical remote host acceptance. Linux preview packaging is published;
    other platforms remain unsupported.

## Session SSH connections

- **Stability**: in-progress
- **Description**: Reach remote OpenShell gateways through app-owned SSH tunnels.
- **Properties**:
  - Explicitly select an existing mTLS profile; OpenShell retains its certificates.
    OpenSSH retains key/agent authentication, host configuration, and host trust.
  - Default remote OpenShell port is 17670. An omitted SSH port preserves alias
    configuration. Forward only to the remote machine's loopback interface.
  - Only native code constructs the local HTTPS endpoint. The gateway certificate
    must cover IP SAN 127.0.0.1; TLS verification is never disabled.
  - Bind every scoped request to its session and profile. Dead, missing, or stale
    IDs fail closed without direct-gateway fallback.
  - Hold an operation lease across complete reads/mutations. Normal disconnect
    waits for operations; app exit kills and reaps the owned SSH children.
  - Retain session details only in memory; never write gateway configuration.
- **Dependencies**: OpenSSH, registered OpenShell mTLS profile, native IPC.
- **Test Criteria**:
  - [x] Bridge tests cover command validation, profile/endpoint binding, host trust,
        failure cleanup, stale IDs, and operation/disconnect coordination.
  - [x] Native fixture verifies authenticated gateway reads through a loopback
        tunnel and explicit disconnect, without agent mutations.
  - [x] Native normal-close cleanup closes the owned tunnel listener.
  - [x] Native tunnel death is reported disconnected; stale reads fail while the
        original direct gateway remains healthy. Active CLI context is unchanged.
  - [ ] Physical remote host accepted with an authorized OpenShell gateway.

## Desktop appearance and Ubuntu launcher

- **Stability**: in-progress
- **Description**: Follow OS appearance and provide a recognizable, pinnable icon.
- **Properties**:
  - Detect light/dark appearance before rendering, follow native theme changes,
    and use the live OS media query when native theme information is unavailable.
  - Save no theme preference. Cover forms, dialogs, status, and preview surfaces
    with the same theme tokens.
  - Install the scalable shield/terminal icon with matching desktop, GTK, Wayland,
    and X11 identities. Repair managed launchers before mapping the first window.
    Keep the old Wayland ID's compatibility entry hidden from app menus. Do not
    modify the user's dock favorites.
  - AppImage updates retain launcher paths and repair untouched legacy installer
    entries. Preserve custom entries/icons and absent `--no-desktop` installations.
- **Dependencies**: Tauri theme events, freedesktop desktop entry, per-user installer.
- **Test Criteria**:
  - [x] Six browser checks cover both themes, live media changes, native event
        precedence, fallback, delayed-read races, and readable text contrast.
  - [x] Native Tauri/WebKit detects this Ubuntu session's dark OS appearance and
        applies matching theme tokens. Physical OS-settings changes remain untested.
  - [x] Twelve installer checks include valid desktop metadata, matching icon bytes,
        and preservation of custom, symlinked, and nonregular compatibility entries.
  - [x] Ten native unit tests cover safe, idempotent launcher repair.
  - [x] Published v0.3.1 installer and native AppImage verify the icon, desktop entry,
        X11 WM_CLASS, and GTK application ID. No user favorites were changed.
        These checks missed its separate Wayland ID; the user reported a generic icon.
  - [x] Fixed native debug build announces `bot.recurse.shellguardian` through both
        Wayland and GTK; the X11 class matches. Current installed launchers repaired.
  - [ ] Live Ubuntu dock pinning/grouping verified with the packaged application.

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
  It is plain HTML with About, Install, and Releases sections, versioned downloads,
  checksums, and GitHub/docs/issue links. Only an optional copy helper uses JavaScript.
  The Tauri app runs locally; the hosted website never connects to OpenShell.

Test Criteria:

- [x] Preference defaults, persistence, permissions, corrupt-file fail-closed behavior,
      stale download generations, and in-flight mutation guards have Rust tests.
- [x] Installer checks cover integrity/network failures, unsafe versions, root and
      unsupported platforms, space-containing paths, rollback, and unmanaged/symlink targets.
- [x] Browser tests cover the default-on switch, opt-out, and simulated manual update.
- [x] Public release assets verified by checksum, installed in an isolated user path,
      and the shipped AppImage connects to the real local OpenShell gateway.
- [x] Native signed old-to-new update installs on normal close; opt-out persists across restart.
- [ ] Adversarial signature/version/network responses exercised through the native updater.
- [x] Website published at shellguardian.org from committed source; HTTPS, content
      parity, browser rendering, and installation redirect/bytes verified.
- [x] Revised static project/release page accepted in the public browser, including
      responsive layout and optional copy-command behavior.
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
