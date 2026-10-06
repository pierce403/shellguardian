# ShellGuardian agent instructions

## Purpose and responsibilities

ShellGuardian is a Tauri desktop interface for NVIDIA OpenShell. Codex is the
initial coding collaborator. Maintain the desktop UI, the narrow Rust CLI
adapter, acceptance evidence, and these operating notes. OpenShell owns agent
state, credentials, policies, authentication, and enforcement.

Read `FEATURES.md`, `MEMORY.md`, and `SKILLS.md` before substantial changes. Follow
the affected feature properties; update readiness and evidence in the same
contribution. Record useful discoveries and failures in `NOTES.md`. Commit
focused milestones. Do not disturb existing agents to test the application.

## Architecture boundaries

- No application database, service daemon, credential vault, or browser storage.
  The only app preference on disk is `autoUpdate` in `preferences.json` under
  Tauri's app config directory. It defaults on; unreadable preferences fail closed.
  Gateway selection, SSH sessions, and detected appearance remain in memory.
- Invoke installed `openshell` and `ssh` executables from Rust with validated,
  fixed argument arrays. Never execute a shell or expose arbitrary command
  execution over IPC.
- Reuse OpenShell's registered gateways and authentication. Scope each request
  explicitly to its gateway and workspace. Changing the UI selection must not
  change OpenShell's active gateway.
- SSH owns transport only: require an explicitly selected registered mTLS profile,
  existing SSH key/agent authentication, and strict host trust. Only native code
  creates loopback endpoint overrides. Never disable TLS or fall back to direct
  access for a dead/stale session ID. Keep operation leases through whole bridge
  operations; normal disconnect waits, while app exit kills and reaps owned SSH
  children after mutation/setup guards permit exit. Never persist SSH sessions.
- Follow OS appearance using native theme events with media-query fallback; do
  not add a saved theme preference. Keep Ubuntu desktop ID, GTK application ID,
  and GLib program name aligned: GTK 3 uses the latter for Wayland's app ID.
  Set the program name and repair managed launchers before creating any window.
  Launcher repair may modify only exact installer-owned entries; preserve
  customizations and `--no-desktop` installs, and never change GNOME favorites.
  Keep the old Wayland ID's compatibility launcher hidden from application menus.
- Keep credentials out of the webview, logs, errors, fixtures, and repository.
  Read provider summaries and attachment metadata only, never credential values.
- Display unavailable measurements as unavailable, never as zero. Sandbox state
  is not proof of an agent process running. CPU/memory limits are not usage.
- Apply policies and provider changes through OpenShell and report its result.
  Filesystem/process changes may require sandbox recreation. Do not implement
  fake enforcement, local token budgets, or guessed credential-use counters.
- Destructive recreation, deletion, installing/upgrading OpenShell, and gateway
  provisioning are outside the initial interface. OpenShell update checks are
  read-only. ShellGuardian self-updates use the fixed, signed GitHub stable channel.
  Stage verified updates in memory; install on normal close or explicit restart.
  Never interrupt an in-flight OpenShell mutation. Never disable signature/version
  verification or expose frontend-controlled URLs, programs, or trust keys.

## Layout

- `crates/openshell-bridge`: desktop-independent CLI adapter, session SSH transport,
  and contract tests.
- `src-tauri`: native application and typed IPC commands.
- `src`: React/TypeScript presentation and explicit sample-preview fixtures.
- `docs`: architecture, upstream contract, and development instructions.
- `install.sh`: HTTPS/checksum-verified per-user Linux installer. No root or sudo.
- `.github/workflows/release.yml`: exact-tag signed Linux AppImage releases.
- `website`: static website, independent npm lockfile, and Cloudflare deployment
  config for shellguardian.org. Commit/push before deploy; verify public byte parity
  and HTTPS/installer redirect. Do not replace unrelated DNS or mail records.
  Publish only `website/dist`, never the Tauri app's root `dist`. Keep project,
  installation, release, and GitHub information in plain HTML; JavaScript is an
  optional copy-command helper. The website must not connect to OpenShell servers.
- `memory`: compact project observations and dated verification records.

## Collaboration conventions

Prefer concrete evidence, concise prose, and small vertical slices. Use lots of
meaningful Rust tests around command safety, parsing, and failure paths. Keep
public API documentation in Rustdoc and longer explanations under `docs/`.
Avoid em dashes in UI copy. Tell the user what works and name the exact remaining
gate. Never claim a sample preview, green build, or API response proves native UI
behavior. The guide at https://recurse.bot informed these conventions.

## Environment discoveries

- This checkout began with only an Apache-2.0 license and a clean `main` branch.
- On 2026-10-05, `/usr/bin/openshell` reported 0.1.2. The active `openshell`
  gateway authenticated with mTLS and returned zero sandboxes. `collusion-vm`
  was registered but refused connections. Re-check these facts live.
- The Snap Cargo/Rust wrappers fail in the restricted environment. Direct
  toolchain binaries under `~/.rustup/toolchains/` work; use an explicit PATH
  rather than changing system installation.
- Linux GTK/WebKit development packages are missing. `sudo -n` requires
  interactive authentication even outside the restricted sandbox.
- `bash scripts/prepare-linux-headers.sh` successfully extracted development
  headers into `.cache/native` and enabled the native build using the host runtime
  libraries. See `docs/development.md` for the tested environment variables.
- Verified: `npm run build`, `npm run format:check`, `cargo test -p openshell-bridge`,
  `cargo clippy -p openshell-bridge --all-targets -- -D warnings`, native Cargo
  check/Clippy, Tauri debug build, Chromium UI checks, and native read-only WebKit
  smoke test. Keep the distinction between contracts, preview, and live behavior.
- Rust dependencies require 1.90 or newer; verification used 1.97.0. npm uses
  repository lockfiles and an ignored local dependency cache in this environment.
- Vite must ignore `src-tauri`, `target`, and `.cache` in its watcher. Native code
  generation created HTML under `target` and caused unrelated frontend reloads
  before those build/cache directories were excluded.
- `vendor/glib` carries a two-line upstream fix for RUSTSEC-2024-0429 because
  Tauri's GTK 3 graph requires GLib 0.18. Preserve its provenance and licenses;
  do not format the upstream snapshot. Run its optimized regression before
  changing/removing this backport. See `vendor/glib/SHELLGUARDIAN.md`.
- Keep the release private key in `TAURI_SIGNING_PRIVATE_KEY` on GitHub and an
  owner-only ignored backup, never source or logs. The public key in Tauri config
  is safe to share. Losing the private key prevents updates to existing installs.
- `npm run test:installer` tests mocked downloads and failure safety. If Node
  reports `spawnSync bash EPERM` in this restricted process sandbox despite a
  successful child exit, repeat outside it; do not weaken installer behavior.
