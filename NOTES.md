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
