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
  - [x] Published v0.3.2 announces `bot.recurse.shellguardian` through both Wayland
        and GTK; the X11 class matches. Shipped older-launcher migration passed in
        isolation. Installed the verified patch and repaired the user's launchers.
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

## Agent interaction and full terminal

- **Stability**: in-progress
- **Description**: Interact with a sandbox's existing agent and open an independent shell.
- **Properties**:
  - Talk to agent attaches OpenShell's canonical main process. If that process is
    not an interactive agent, explain the limitation instead of synthesizing chat.
  - Open terminal starts a separate `/bin/sh -i` inside the selected Ready sandbox.
    No arbitrary host command, shell, environment, or endpoint crosses IPC.
  - Show the captured gateway/workspace/sandbox/SSH session and close on scope changes.
  - Support terminal input, ANSI output, resizing, live OS theme, and bounded
    memory-only scrollback. No persistent conversation store or telemetry upload.
  - Agent detach does not interrupt its main process. Tunnel disconnect and app
    exit clean up owned local PTYs before their SSH transports.
  - Disable terminal-driven clipboard, file, and hyperlink actions; bound queues
    and apply output backpressure. Missing/stale IDs never fall back to direct access.
- **Dependencies**: OpenShell 0.1.2 connect/exec, Linux PTY, xterm.js, session transport.
- **Test Criteria**:
  - [x] Bridge tests enforce fixed commands, live readiness, valid scope, stale-ID rejection.
  - [x] Native PTY tests verify input/output/resize, bounded buffers, detach, and cleanup.
  - [x] Browser tests verify session scoping, errors, theme, keyboard, and late-open cleanup.
  - [x] Native UI verified against an isolated no-credential/no-inference sandbox.
  - [x] Interactive sessions accepted through a private loopback SSH test server,
        including live-PTY disconnect, stale-ID rejection, normal window close,
        and disappearance of owned CLI/SSH processes. No existing agents changed.
  - Evidence: 42 bridge tests, 34 native tests (one child helper is deliberately
    excluded from direct execution), and 33 browser checks on 2026-10-06.
    `scripts/native-interaction-smoke.mjs` verifies actual WebKit keyboard input,
    canonical-main replies, independent shell commands, ANSI rendering, and TTY size.
  - [x] Published v0.4.0 AppImage passes the same native interaction and SSH
        acceptance; its exact verified bytes are installed in the user's existing path.
  - Remaining: an interactive session across a physical remote host; neither the
    sample workload nor Ready proves an AI agent.

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

## Hermes supervisor

- **Stability**: implemented and verified against a live Hermes 0.16.0 supervisor;
  sandboxed execution is the next milestone (see the roadmap below)
- **Description**: A Supervisor page, below Overview, for asking a local Hermes agent
  for work and watching it happen. Tabs: Chat (with live work and usage limits
  alongside), Board (the kanban), Agents (model, provider, keys, supervisor duties),
  Sessions, and Schedules. It also installs Hermes with its official installer after
  the user reviews it. The sidebar shows the supervisor's gateway state beside
  OpenShell's.
- **Properties**:
  - Discovery: profiles from `hermes profile list` and each profile's provider from
    `hermes profile show`, every 60 seconds and on demand. `auto` is flagged as
    Hermes's placeholder OpenRouter default.
  - Create only new, empty profiles with `--no-alias`; never clone or overwrite.
  - Chat: one turn at a time through `hermes -p <profile> chat -Q --format=stream-json
    --query=... [--resume=...]`, bounded in size and time, run from the home directory.
    While a turn runs the page polls native progress: reply text so far and the tool
    calls made, as plain-language steps. A message sent while a turn is running is
    kept as a draft, and drafts survive a tab switch. Conversations live in memory only.
    Token totals are Hermes's running totals for the conversation; unknown totals are
    not shown as zero.
  - Stop: the chat CLI is only a viewer, so signalling it detaches it while the agent
    keeps working. Stop detaches the viewer, then interrupts the turn at the gateway
    (`session.events.since` for the execution generation, then `session.interrupt`),
    holding the one-turn lock until that returns. The reply says "stopped by you" only
    when the gateway accepted the interrupt; otherwise it says ShellGuardian stopped
    watching and Hermes may still be working. The 10 minute limit ends a turn the same
    way and keeps the session and what had arrived.
  - A reply that Hermes marks incomplete (for example at its step limit) is shown as the
    reply with a note, not as an error.
  - Dangerous commands fail closed (`HERMES_INTERACTIVE=1`, no stdin), never auto-approved.
  - Hermes children never inherit provider keys from the desktop environment.
  - Replies render through a small built-in Markdown subset (paragraphs, lists, bold,
    inline and fenced code) as React elements; links are plain text and no HTML is injected.
  - Work alongside chat: running tasks with elapsed time and the latest progress note,
    blocked tasks, the tasks this conversation created (also listed under the reply
    that created them), and usage limits.
  - Usage limits: `model.options` reports usage windows for signed-in subscription
    providers (for example Claude session and week, Codex week). They are shown as
    meters; a provider that reports none is shown as unavailable, never zero.
  - Board: one column per status, a drawer per task (request, result, timeline with
    worker check-ins folded, runs, worker log tail, worker transcript, comments), a
    New task dialog, an agent filter, archived toggle, and long columns capped until
    expanded. The board refetches only when its change signal moves (file metadata of
    the board database, checked every 1.5 seconds), with a 15 second fallback. A notice
    appears when an assignee has waiting work but its gateway is stopped.
  - Installation downloads the official script over HTTPS, shows its SHA-256 and text,
    and runs only that exact file, re-hashed, in an in-app terminal with `--skip-setup`.
  - Provider setup: `model.options` (including providers not set up yet), Hermes's own
    validated assignment `profiles.configure` with its expensive-model confirmation,
    and `model.save_key` for API-key providers. Sign-in providers (Codex, Nous, xAI)
    use `hermes -p <profile> setup model` in the in-app terminal. The full wizard stays
    available. Terminal output is shown, never logged or persisted.
  - Gateway RPC: native code mints a single-use, profile-scoped ticket with `hermes -p
    <profile> gateway attach --json`, sends it only as the `hermes-gateway-ticket.<T>`
    subprotocol to a validated loopback `ws://…/api/ws`, waits for `gateway.ready`,
    makes one fixed call, declines any server request, and closes. The webview gets
    whitelisted scalar fields only. Start gateway (`attach --start`) runs only on an
    explicit click.
  - Sessions: every session from `hermes sessions list` (the gateway's own list hides
    one-shot chats and kanban worker runs), labelled chat, task run, or conversation,
    with read-only transcripts from `session.transcript`. Schedules: `cron.manage` list.
  - Kanban uses the Hermes CLI: `boards list`, `list [--archived]`, `show`, `log`,
    `stats` with `--json`, plus `create` and `comment`. Free text is passed as
    `--opt=value` or after `--`; IDs must start alphanumeric.
  - "Prepare as supervisor" (explicit click) enables the `kanban` toolset by re-sending
    the profile's enabled toolsets plus `kanban` (`profiles.describe` then
    `profiles.configure`, which has replace semantics) and installs the ShellGuardian
    playbook skill `shellguardian-supervisor`. It refuses to replace a same-named skill
    it does not own and never touches `SOUL.md`.
  - A second launch focuses the running window (single-instance plugin).
  - Remote host support is not implemented.
- **Test criteria**:
  - [x] Rust (90 tests): name and session validation, profile and session table
    parsing, stream-json handling (only allowlisted tool arguments reach the reply),
    live progress, one-turn locking, Stop and timeout killing the process group,
    environment allowlist, installer staging and hash binding, loopback URL and ticket
    validation, a fake loopback gateway (subprotocol, `gateway.ready`, declined server
    requests, key redaction before truncation), result projections, flag-safe kanban
    arguments, trusted database paths, a change signal that ignores readers, the
    interrupt sequence against a scripted gateway, incomplete replies, and time limits
    that keep the session (2026-11-18).
  - [x] Chromium (51 tests): chat progress, drafts, Stop (armed on its own clock, so it
    works when progress cannot be read), retry, Markdown rendering,
    honest wording for confirmed and unconfirmed stops, board loading and failure
    states that never show unread counts as zero,
    reply-linked tasks, the live board, drawer, new task, filters, capped columns,
    folded check-ins, provider and key flows (the key never stays in the page), gateway
    notices that never start a gateway on their own, sessions, schedules, keyboard
    tabs, and that the board refetches only when the change signal moves (2026-11-18).
  - [x] Live Hermes 0.16.0, read-only: the Rust gateway client against the real gateway
    (`model.options` with real usage windows, `profiles.describe`, `session.transcript`
    including a kanban worker's), the session list (13 real sessions, kinds correct),
    and kanban reads with a change signal that stayed stable across reads (2026-11-18).
  - [x] Live streaming chat: two real turns through the new chat path replied, streamed
    progress, reported tokens, and resumed the session (2026-11-18).
  - [x] `scripts/supervisor-acceptance.mjs` against the live supervisor (guanyu, Codex,
    board `sg-acceptance`): 4/4 passed. Single task created, tracked, and completed;
    dependent task started after its parent; a plain question created no task; an
    impossible task ended blocked (2026-11-18).
  - [x] Native WebKit, read-only live mode: every Supervisor tab rendered real data,
    no browser storage was used (2026-11-18). The OpenShell update check was skipped in
    that run because GitHub rate-limited the machine.
  - [x] A second launch exits 0 and the first instance keeps running, with no panic
    (two real launches in a private display and bus, 2026-11-18).
  - [x] Live download of the official installer (68,015 bytes, staged owner-only,
    hash-bound); the script still supports `--skip-setup`. Not run (2026-11-18).
  - [x] Stop on a real long-running turn: the gateway confirmed the interrupt and the
    next message was answered in 6 seconds. Before the gateway interrupt, the same
    follow-up waited about two minutes behind the turn that was still running
    (2026-11-18).
  - [x] Independent audit of the redesign (five reviewers, each significant finding
    checked by a second agent): 13 confirmed findings and 15 minor ones, all addressed
    (2026-11-18).
  - [x] Optimized 0.6.0 build (embedded frontend, production content security policy):
    the same read-only native walk-through rendered every Supervisor tab (2026-11-18).
    The AppImage itself is built and signed only by the release workflow.
  - [ ] Native WebKit for the redesigned page with an isolated Hermes: now that Hermes
    is installed per-user, the isolated smoke modes need a redirected home directory.
  - [ ] Run the official installer end to end on a clean account.
  - [ ] Confirm a dangerous command is denied in a live chat turn.
  - [ ] SSH-only remote discovery and chat using strict host-key verification.

## Supervisor orchestration roadmap

- **Stability**: planned; milestone 1 (watchable board, supervisor tests) implemented
- **Description**: The supervisor turns requests into kanban tasks; Hermes agents make
  the decisions; agent CLIs (Codex, Claude Code, Gemini CLI) do the work in OpenShell
  sandboxes with supervisor-chosen credentials; the user watches live.
- **Milestones**:
  1. Watchable board and supervisor acceptance tests (this is in "Hermes supervisor").
  2. Managed sandboxes: bridge `sandbox create --no-keep`/`exec`/label-guarded delete,
     a `shellguardian-mcp` stdio server (`providers_list`, `sandboxes_list`,
     `run_agent_task`), limits in code (existing providers only, managed sandboxes only,
     default-deny network, concurrency and runtime caps), grants recorded as kanban
     comments and sandbox labels, and a "Pause all work" control. Needs OpenShell
     providers and a sandbox image with the agent CLIs, which do not exist yet.
  3. Usage limits and routing: Codex and Claude (OAuth) limits from `hermes usage`;
     Gemini and Venice have no quota source in Hermes and need local tracking. A model
     scoreboard with a grading signal (review step, checks, user rating).
  4. Role agents on demand from templates, with a maximum count and a retire flow.
