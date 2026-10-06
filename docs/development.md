# Development

The root Cargo workspace defaults to the desktop-independent `openshell-bridge`
crate. Native dependencies are required only for `shellguardian`/Tauri targets.
Commit both package lockfiles. The frontend uses React, TypeScript, Vite, and
Lucide icons; no external font/image service is used.

Browser tests use Chromium and explicit sample-preview data. They exercise
cancel/apply dialogs, provider attachment controls, policy comparisons, keyboard
navigation, scoping, unavailable data, and small-screen layout. They do not prove
native IPC or real OpenShell mutations.

Theme tests exercise both palettes, live system preference changes, native event
priority and fallback, and delayed native reads. Contrast checks cover agent
cards, status labels, form fields, and policy review dialogs in both themes.

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

## Native SSH and system theme acceptance

`scripts/native-ssh-smoke.mjs` manages a private Xvfb display, random WebDriver and
SSH listener ports, temporary SSH keys, and an isolated client configuration. It
uses the already registered, active mTLS gateway at `https://127.0.0.1:17670` for
read-only status and inventory checks. It does not create gateways or change
OpenShell's active selection, credentials, policies, agents, or the user's SSH
configuration. The fixture owns all test SSH keys and removes them on exit.

Requirements are Linux, Xvfb, a C compiler with Xlib development headers,
OpenSSH client/server binaries, tauri-driver, and WebKitWebDriver. By default the
drivers are read from `.cache/tauri-driver/bin/tauri-driver` and
`.cache/native/sysroot/usr/bin/WebKitWebDriver`; set `TAURI_DRIVER` and
`WEBKIT_DRIVER` to override those paths. The server can be installed already or
extracted from an official distribution package without installing it globally.
The fixture checks `/usr/sbin/sshd`, then
`.cache/ssh-fixture-deps/root/usr/sbin/sshd`; `SHELLGUARDIAN_TEST_SSHD` overrides it.
Adjacent `sshd-session` and `sshd-auth` binaries from newer OpenSSH packages are
also supported.

For an embedded frontend built with `npm run tauri build -- --debug --no-bundle`:

```bash
node scripts/ssh-fixture.mjs --self-test
node scripts/native-ssh-smoke.mjs target/debug/shellguardian
```

A plain `cargo build -p shellguardian` uses Tauri's development URL. The following
mode starts and stops its own Vite server. Port 1420 must be free; avoid running
the browser suite at the same time:

```bash
SHELLGUARDIAN_NATIVE_DEV=1 node scripts/native-ssh-smoke.mjs target/debug/shellguardian
```

Other native tests can import `startSshFixture()` from `scripts/ssh-fixture.mjs`,
launch their application or driver with `fixture.env`, and use `fixture.alias`,
`fixture.port`, and remote port 17670. Always await `fixture.cleanup()` in a
`finally` block. The PATH wrapper invokes real OpenSSH with a private `-F`
configuration, pinned known-host key, explicit test identity, and batch-only
authentication. The server permits forwarding to the selected loopback targets
only, with no shell sessions or agent forwarding. `fixture.stopServer()` closes
both the owned listener and its captured session children, since stopping an
OpenSSH listener alone deliberately preserves established sessions.

`scripts/native-close-window.c` sends a native `WM_DELETE_WINDOW` request on the
fixture's private X display. This exercises the actual GTK/Tauri close lifecycle;
WebDriver's close-window endpoint only closes its WebKit browsing context. The
compiled helper exists only in the temporary fixture directory.

Verified on 2026-10-06 with Ubuntu OpenSSH 10.2p1: the native form connected through
real SSH and authenticated with OpenShell mTLS; snapshots preserved the SSH
connection ID; disconnect and native app close released their listeners; daemon
session loss was reported; expired IDs could not fall back to the healthy direct
gateway. Gateway registrations and the active CLI profile were unchanged. The
actual native OS theme read returned `dark`, matching the document theme and CSS
color scheme without changing desktop settings. The screenshot is
`test-results/native-ssh-connected.png`. The fixture self-test additionally
verified rejected client keys, changed host keys, refused remote ports, transport
to the existing OpenShell TLS endpoint, and removal of keys/listeners.

The test used the official Ubuntu `openssh-server_10.2p1-2ubuntu3.6_amd64.deb`
extracted under the ignored cache, checked against the installed apt index's
SHA256 `108256262b0fb7bb8eddd92e87230f775c90eb321413e8789754b3509f7b55c6`.
Physical separate-host/network acceptance and native live OS setting changes
remain separate from this loopback transport and current-theme acceptance.

## Published AppImage acceptance

The public-release verifier downloads the exact version's GitHub assets, checks
the complete SHA256 manifest and signed-version metadata, runs the published
installer in isolated data/bin directories, and executes the shipped AppImage
through the native SSH test. It also requires `desktop-file-validate`, `xwininfo`,
and `xprop` for desktop entry and native X11 window identity checks:

```bash
node scripts/verify-public-release.mjs 0.3.2
```

Artifacts, the isolated install, screenshot, and `verification.json` are retained
under `.cache/public-release-0.3.2`. `HOME` and `XDG_CONFIG_HOME` remain unchanged
so OpenShell can use its existing profile; only install/bin paths and
`XDG_DATA_HOME` point into the test directory. The verifier does not change app
preferences, OS appearance, or GNOME favorites. The native harness also cleans
up its private processes if an external timeout sends SIGTERM.

On 2026-10-06 the published 0.3.1 AppImage passed the native SSH lifecycle and
theme checks above. Its installed launcher/icon passed desktop entry validation,
the live X11 WM_CLASS was `shellguardian`, `Shellguardian`, and
`_GTK_APPLICATION_ID` was `bot.recurse.shellguardian`, matching the stable desktop
ID. Native AppImage update support was detected and the installed bytes were
unchanged after acceptance. These checks establish installed artwork and X11/GTK
metadata, not the separate Wayland app ID or the rendered GNOME dock icon. The user
subsequently reported a generic gear on Wayland despite those checks passing.
Actually adding the app to a user's GNOME dock remains a user action.

## Native Wayland identity acceptance

GTK 3 uses the GLib program name, not GtkApplication's ID, for `xdg_toplevel.app_id`.
The app now sets both identities to the installed desktop filename stem,
`bot.recurse.shellguardian`, before any window is created. Launcher migration also
runs before Tauri creates configured windows, not inside its later setup hook.

From a real Wayland session with `WAYLAND_DISPLAY` and `XDG_RUNTIME_DIR` available:

```bash
node scripts/native-wayland-identity.mjs target/debug/shellguardian
```

The test briefly opens its own window on that display, using a private D-Bus session
and temporary XDG directories. Automatic updates are disabled only in that fixture.
It captures only Wayland/GTK identity metadata, times out after ten seconds, and
cleans up its own process group and temporary files. It does not close the user's
app or change their preferences, favorites, or OpenShell state. Pass an AppImage
path to check the packaged build through the same path.

On 2026-10-06, the fixed debug build reported `bot.recurse.shellguardian` for both
identities. The native SSH harness with `SHELLGUARDIAN_VERIFY_DESKTOP_IDENTITY=1`
also verified the corresponding X11 class and GTK application ID. This closes the
protocol-level coverage gap; visual dock confirmation still requires the user's
actual GNOME session, not an Xvfb screenshot or metadata-only assertion.

Published v0.3.2 passed both identity paths on 2026-10-06. The released AppImage
also repaired an exact v0.3.1 launcher in the isolated managed installation, proving
the release-only AppImage/path checks permit the intended migration. Receipts are
`wayland-verification.json` and `migration-verification.json` beside the standard
public-release report. The user's per-user installation was upgraded to those same
verified bytes without closing the existing window or modifying favorites.
