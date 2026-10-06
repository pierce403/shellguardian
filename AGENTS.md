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
- Invoke the installed `openshell` executable from Rust with fixed argument
  arrays. Never execute a shell or expose arbitrary command execution over IPC.
- Reuse OpenShell's registered gateways and authentication. Scope each request
  explicitly to its gateway and workspace. Changing the UI selection must not
  change OpenShell's active gateway.
- Keep credentials out of the webview, logs, errors, fixtures, and repository.
  Read provider summaries and attachment metadata only, never credential values.
- Display unavailable measurements as unavailable, never as zero. Sandbox state
  is not proof of an agent process running. CPU/memory limits are not usage.
- Apply policies and provider changes through OpenShell and report its result.
  Filesystem/process changes may require sandbox recreation. Do not implement
  fake enforcement, local token budgets, or guessed credential-use counters.
- Destructive recreation, deletion, installing/upgrading OpenShell, and gateway
  provisioning are outside the initial interface. Update checks are read-only.

## Layout

- `crates/openshell-bridge`: desktop-independent CLI adapter and contract tests.
- `src-tauri`: native application and typed IPC commands.
- `src`: React/TypeScript presentation and explicit sample-preview fixtures.
- `docs`: architecture, upstream contract, and development instructions.
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
