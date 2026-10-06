# ShellGuardian development notes

## 2026-10-05: foundation research

The initial checkout at `/home/pierce/projects/shellguardian` contained `LICENSE`
and commit `acf2567`; there were no user edits. Origin is the existing
`pierce403/shellguardian` repository. No source repository or gateway was changed
during discovery.

Read the live https://recurse.bot guide. Adopted canonical `AGENTS.md`, measurable
`FEATURES.md` entries, indexed project notes, narrow CLI-first workflows, useful
failure evidence, and focused milestone commits. No agent persona change, empty
responsibility prompt, scheduled check, or speculative skill library is needed.

Read NVIDIA's documentation and downloaded official OpenShell tag `v0.1.2`,
commit `6648bd0c290efbc41ba131ee9831ee45cd431f94`, into a temporary research
checkout. The official latest stable release was `v0.1.2`, published
2026-09-28T03:58:00Z. Current installed CLI is `openshell 0.1.2`.

Read-only live discovery found two registered gateways. `openshell` at
`https://127.0.0.1:17670` reported connected, version 0.1.2, mTLS authenticated,
and an empty sandbox inventory. `collusion-vm` at `http://127.0.0.1:18081` refused
connections. Those are time-specific observations, not app defaults or fixtures.

The CLI provides JSON status, gateway inventory, sandbox/provider inventory,
policy reads, provider attach/detach, and start/stop. Logs are bounded text.
ShellGuardian will delegate all enforcement and credentials to these interfaces.
No user agents will be started, stopped, attached, or reconfigured for testing.

### Native environment gate

GTK 3 and WebKitGTK 4.1 development packages are absent. Native Tauri compilation
requires them. `sudo -n true` outside the sandbox returned `interactive
authentication is required`. The direct Rust 1.97.0 toolchain works; Snap wrappers
fail under the environment restrictions. Backend contract tests and frontend
build/browser checks can proceed independently of native GUI dependencies.

## Implementation and acceptance

Implemented the Tauri 2 application, React/TypeScript interface, and a separate
Rust `openshell-bridge` crate. The adapter exposes only scoped inventory/status,
policy reads/apply, provider summaries/attachments, lifecycle controls, bounded
logs, and an independent official release check. The app has no database or
browser persistence. It does not export provider values or provision gateways.

The inspected 0.1.2 source's sandbox JSON omits image and resource usage. Its CLI
and gateway API also omit token/billing and credential-use counters. Those are
displayed as unavailable rather than zero. Startup filesystem/Landlock/process
settings require recreation. The editor refuses inherited global-policy
replacement and rechecks hash/configuration revision before applying; this check
is not atomic because the CLI has no expected-revision write flag.

The Ubuntu runtime libraries were already present. Downloaded 30.8 MB of missing
development package archives into ignored `.cache/native`, extracted them, and
resolved development linker symlinks to the installed runtimes. This enabled
native compilation without a privileged system package install. The helper is
checked in as `scripts/prepare-linux-headers.sh`. Nothing in that cache is part of
the desktop application or Git history.

### Verified evidence

- 25 Rust tests passed: fixed/scoped arguments, invalid input rejection, pagination
  and repeated cursors, independent failures, summary field allowlisting, policy
  revision checks, global/static policy guards, owner-only temporary files,
  timeout/output/UTF-8 errors, log redaction, and semantic version comparisons.
- 11 Chromium checks passed for browser/preview distinction, search, lifecycle
  review/cancel/apply, provider access, policy comparison, activity, keyboard
  navigation, workspace selection, unavailable inventories, and narrow layouts.
  The additional ambiguous-mutation test confirms one request, a disabled retry,
  and an explicit close/refresh path after an uncertain command error.
- Frontend production build and TypeScript checks passed. Both lockfiles are
  committed. Rust formatting and bridge/native Clippy passed with warnings denied.
- Native Tauri check and packaged debug build passed using the isolated headers.
  The executable is `target/debug/shellguardian` (unoptimized development build).
- The compiled read-only `inspect` example returned mTLS authentication, gateway
  version 0.1.2, and zero sandboxes/providers from the real active local gateway.
- The compiled update checker returned `current`, installed/latest 0.1.2, official
  release URL, and publication time 2026-09-28T03:58:00Z.
- The actual packaged application was driven by tauri-driver 2.1.0 and Ubuntu's
  WebKitWebDriver on a private Xvfb display. `scripts/native-smoke.mjs` verified
  real Tauri IPC, installed version, connected local gateway, automatic official
  release status, and zero local/session storage entries. Native screenshots were
  inspected visually. Its receipt explicitly reported `mutationsPerformed:false`.

### Remaining acceptance gates

Native start/stop, policy apply and provider changes have contract/browser evidence
but have not been applied to a real sandbox. Live logs need a sandbox producing
activity. A physical remote host and cross-platform release builds remain untested.
No existing sandboxes, providers, keys, policies, gateway selections, or runtime
services were changed. The current active workspace was empty. Features remain
`in-progress`; passing a preview or native read-only smoke test does not establish
production readiness for all controls.

### Development watcher cleanup

The preview server's logs showed page reloads for generated Tauri HTML under
`target/debug/build/.../tauri-codegen-assets`. Vite now excludes native source,
Rust build output, and development caches from its watcher. This is independent
of the packaged frontend and prevents build artifacts from triggering UI reloads.

### GTK dependency advisory

GitHub flagged GHSA-wrw7-89jp-8q8g / RUSTSEC-2024-0429 after the initial push.
The dependency is GLib 0.18.5, required by Tauri's GTK 3 graph. The advisory is an
immutable Rust pointer reference passed to a mutable C out-argument in
`VariantStrIter::impl_get`; optimization can discard that write and leave a null
pointer. A registry upgrade to the patched 0.20 line does not satisfy GTK 3's
0.18 dependency range.

Verified the original crate archive's SHA-256 against the original Cargo.lock
checksum, then vendored that single 1.1 MB package with its original license.
Applied the exact two-line runtime fix from official gtk-rs-core PR 1343 using
the root Cargo patch table. No package version was changed and no GitHub alert
was manually dismissed. Added two optimized forward/reverse/mixed iterator
regressions; both passed. The unchanged third-party snapshot emits existing style
and lifetime warnings on Rust 1.97; it is excluded from workspace formatting.
Provenance and maintenance/removal conditions are in `vendor/glib/SHELLGUARDIAN.md`.
