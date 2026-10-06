# Development

The root Cargo workspace defaults to the desktop-independent `openshell-bridge`
crate. Native dependencies are required only for `shellguardian`/Tauri targets.
Commit both package lockfiles. The frontend uses React, TypeScript, Vite, and
Lucide icons; no external font/image service is used.

Browser tests use Chromium and explicit sample-preview data. They exercise
cancel/apply dialogs, provider attachment controls, policy comparisons, keyboard
navigation, scoping, unavailable data, and small-screen layout. They do not prove
native IPC or real OpenShell mutations.

```bash
npm ci
npx playwright install chromium
npm run build
npm test
cargo test -p openshell-bridge --locked
cargo clippy -p openshell-bridge --all-targets --locked -- -D warnings
cargo fmt --all -- --check
```

`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can select an existing Chromium binary.

## Restricted Linux environment

This workstation has GTK/WebKit runtime libraries but lacks development packages.
The standard system setup is in Tauri's prerequisite documentation. If installing
headers globally is unavailable, the optional helper downloads missing Ubuntu
development packages into `.cache/native` and resolves linker symlinks to existing
host runtime libraries:

```bash
bash scripts/prepare-linux-headers.sh
export PKG_CONFIG_SYSROOT_DIR="$PWD/.cache/native/sysroot"
export PKG_CONFIG_PATH="$PKG_CONFIG_SYSROOT_DIR/usr/lib/x86_64-linux-gnu/pkgconfig:$PKG_CONFIG_SYSROOT_DIR/usr/share/pkgconfig"
cargo check -p shellguardian --locked
npm run tauri build -- --debug --no-bundle
```

This helper is for Debian/Ubuntu x86-64 hosts with matching runtime packages.
It is development tooling, not app installation or a portable SDK distribution.
It does not change system packages and is not packaged with ShellGuardian.

The Snap Rust wrappers fail under the restricted execution environment. Direct
toolchain binaries worked. For this machine, the tested fallback is:

```bash
export PATH="/home/pierce/.rustup/toolchains/1.97.0-x86_64-unknown-linux-gnu/bin:$PATH"
export CARGO_HOME="$PWD/.cache/cargo"
```

Restricted execution can also deny localhost binds, IPC, or gateway sockets.
Those failures are environment evidence; reproduce outside that restriction before
attributing them to the application.

## Acceptance boundaries

The Linux native read-only smoke test uses `tauri-driver` and `WebKitWebDriver` on
ports 4544/4545. Start the driver under a private headless display, then run:

```bash
xvfb-run -a -s '-screen 0 1440x1000x24' tauri-driver --port 4544 --native-port 4545 --native-host 127.0.0.1
node scripts/native-smoke.mjs target/debug/shellguardian
```

The smoke test verifies real IPC, installed CLI version, local gateway data,
the official release check, and empty local/session storage. It captures native
screenshots and closes its application session. It performs no agent mutation.
Supply `--native-driver PATH` when WebKitWebDriver is not on PATH. On this Ubuntu
version its package is `webkitgtk-webdriver`, replacing the older package name.

Never modify existing agents to verify a new UI. Live mutation acceptance should
use an explicitly disposable environment with known test credentials and no paid
inference. Check both command receipts and subsequent gateway state. Do not mark
feature readiness stable from fake command contracts or a browser preview alone.
