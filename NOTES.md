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

## 2026-10-06: website, installer, and signed app updates

The user requested a website, `curl | bash` installer, and default-on auto-update.
This applies to ShellGuardian, not automatic OpenShell upgrades. App state remains
database-free; the only added persistent preference is the update opt-out.

Implemented a fixed stable-channel Tauri updater with signature and signed-version
verification, staged in-memory downloads, install-on-normal-close, explicit restart,
and in-flight OpenShell mutation guards. Missing preferences default on; unreadable
preferences fail closed. Off cancels/discards staged work; failed saves do not claim
the user's choice was persisted. Raw/development Linux binaries do not self-update.

Created the project-specific signing key under owner-only ignored `.cache/signing`
and saved it as `TAURI_SIGNING_PRIVATE_KEY` in the repo's Actions secrets. Only the
public verification key is committed. This backup must be preserved outside build
caches before cleanup. Workflow actions are pinned to verified official commit SHAs.

Eight native updater/preference unit tests and twelve Chromium app checks passed.
Nine installer checks passed outside the process sandbox. A `spawnSync bash EPERM`
inside the restricted sandbox occurred even though its child exited successfully;
the same check passed outside it. The script tests HTTPS flags, checksums, root/
unsupported-platform refusal, malformed versions, network failure, preserved existing
files, symlink/unmanaged targets, space paths, and reinstall rollback.

Public release, native signed-update, and website acceptance evidence follows once
those stages complete. Linux x86_64 is the initial supported release platform;
other platform builds must not be advertised as available without real artifacts.

### Public release and native acceptance

GitHub Actions run 37485994688 passed on exact commit
`4a6d8a68ee44104cb498afde646369a8e270e00c`, tag `v0.2.0`. Published the 85.2 MB
Linux x86_64 AppImage, signed/version-bound manifest, signature, installer,
version file, and SHA256SUMS. All five public asset digests verified. The public
installer fetched GitHub assets, verified the checksum, and installed successfully
into ignored `.cache/public-install` user paths without root or system changes.

Real native IPC confirmed default-on updates, an owner-only opt-out file,
persistence across native restart, and re-enable. The update probe uses an old
release-mode 0.1.0 executable in a disposable writable AppImage slot; its backend
is the same tagged source. Production's default frontend cannot call `window.close`
over IPC. An initial probe mistakenly swallowed that permission error and timed
out. The fixture alone now includes `core:window:allow-close` so it exercises the
native normal-close event without widening the published app's capability.

That probe passed: downloaded and verified the published 0.2.0 signature plus
signed version, held the download without replacing the 0.1.0 fixture, then applied
it through native normal-close handling. Replacement SHA256 exactly matched public
AppImage `bbfee801458e8f917dfe5ba4c4a72afd01ad64b327ef37c5f05cffbffe561be0`.
No OpenShell mutations were performed. The fixture is a versioned executable in a
disposable AppImage slot, not a previously published 0.1.0 distribution.

### Cloudflare publication

The user explicitly requested https://shellguardian.org. The earlier private Sites
preview was already published; its identity/source remain preserved, but the public
production origin now uses the user's Cloudflare account with Workers Static Assets.
This avoids adding login or another stateful website backend. Website files live in
`website/dist`; app frontend output is still ignored `dist` at the repository root.

Verified the active zone `296c374c7a073a52f910bca1fc01c7a2` in existing account
`b6d1478423f0bb0c0477df387305e46b`. No existing matching Worker, route, or custom
domain was registered. Public apex A/AAAA/CNAME were absent. Five existing
Namecheap mail-forwarding MX records were found and must be preserved. The existing
Wrangler OAuth has Workers/route/SSL permissions, not DNS-record read/edit, so a
direct DNS-list request returned 403. Worker custom-domain registration manages
only its apex record; no broad DNS token or other security access was added.

Wrangler 4.147.0 initially pulled development-only Sharp with GHSA-wq5f-xc86-pv6w,
published in the advisory database today. Verified official Sharp 0.35.5 as patched,
added a scoped override, and rechecked the deployment dry-run. npm audit now reports
zero vulnerabilities for the website tools. Static site header policy restricts
scripts/styles/images to local assets and prohibits framing. `/install.sh` and
`/latest.json` redirect to the official project GitHub Release.

Cloudflare deployment from website source commit `baf5064` succeeded as Worker
version `85b866dd-1341-4e37-b1b3-3a7645ab9fe1`; the custom domain is enabled in
the expected account/zone. Authoritative DNS and Cloudflare's public DNS-over-HTTPS
resolver returned IPv4/IPv6 addresses. The workstation temporarily had cached
negative IPv4 answers: HTTPS with verified SNI and an authoritative-address
override worked first, then ordinary hostname HTTPS succeeded without an override.
Public HTML matched committed bytes. `/install.sh` returned the correct HTTPS
GitHub redirect, and its fetched bytes matched the committed/released script.

The published AppImage's real native webview connected to the existing mTLS
OpenShell 0.1.2 gateway, performed its official release check, and reported zero
browser storage entries. Its first attempt used the updater test driver's isolated
`XDG_CONFIG_HOME`, which also hid the existing OpenShell registration. Restarting
the driver in the ordinary read-only environment fixed the harness, with no
production source change or copied keys. No user gateway/agent state was changed.

Added a transport-only Worker because `_redirects` cannot express scheme/domain
conditions. It upgrades HTTP to the fixed HTTPS canonical host while preserving
path/query, then streams HTTPS static assets through the ASSETS binding. This does
not change mail records, zone-wide TLS settings, or other hostnames. Tests cover
redirect, canonical-host handling, and static passthrough.

Retained an owner-only signing-key backup in `.release-keys/updater.key`, explicitly
Git-ignored and separate from disposable build caches. The directory is 0700 and
the key 0600. The user should retain an independent backup before moving/removing
the checkout. The private key has never been printed or committed.

Final production deployment uses pushed source `c0bb158bde2ff07c87a5ee1e5166947210011ce0`,
Worker version `65517dda-a467-4046-99c1-a108d2334f81`, with its source SHA in the
deployment message. Verified HTTP 308 to the canonical HTTPS URL, HTTPS HTML/CSS/JS/
screenshot byte parity, and the installer/update-manifest GitHub redirects and bytes.
The live site rendered in the user's browser. All five original MX records remain.
Local DNS answers were intermittently negative during these checks; authoritative
DNS, public DoH, named TLS to the authoritative edge, ordinary HTTPS when resolved,
and the live browser independently confirmed the public origin. Native test drivers
and preview listeners are stopped; only committed source, signed public assets,
ignored test receipts/caches, and the protected signing-key backup remain.

## 2026-10-06: static project website clarification

The user clarified that shellguardian.org should describe the desktop project,
installation, and releases, with links to GitHub. The existing production source
was already static HTML, not the Tauri build, but its marketing-style layout lacked
an explicit release catalog. Reworked it into About, Install, and Releases sections
with versioned AppImage, installer, checksum, signature, release/source, documentation,
and issue links. Moved the sample screenshot below the release information and
explicitly distinguished the locally running app from the hosted project page.

Verified current GitHub v0.2.0 release metadata before authoring the static snapshot:
published 2026-10-06, Linux x86_64 AppImage 85,174,776 bytes, and all advertised
verification files uploaded. No app binaries, gateway registrations, agents, DNS,
mail, or hosting architecture were changed. The existing Worker only handles the
HTTPS redirect and static assets; only `website/dist` is deployed.

The optional copy button starts hidden and is enabled by its tiny helper. All
project, installation, and release information lives in the HTML, without remote
fetches or browser storage. Added dependency-free checks for section/anchor/asset
links, versioned downloads, and copy success plus clipboard-denied fallback.
Public deployment and browser acceptance evidence follows below.

Pre-publication checks passed: transport tests, static content/links, copy helper
success/fallback, formatting/diff checks, and Wrangler's static-assets dry-run.
All 17 distinct advertised project GitHub URLs returned HTTP 200, including each
versioned download, documentation, license, releases, and issue tracker.

The public byte check found Cloudflare automatically injecting its analytics
beacon into the HTML, despite the site's restrictive CSP and no authored analytics.
This was not an app runtime. Added a site-local `Cache-Control: public, max-age=0,
must-revalidate, no-transform` header, following official Web Analytics documentation
(https://developers.cloudflare.com/web-analytics/get-started/), to preserve the
committed payload. No account-wide analytics, cache, or security setting changed.

Final production uses pushed source `7670358fd45472435eaea50c15e7d18e95d39c56`,
Worker version `d50ae62c-d4a3-4120-8870-2312ce17d3f6`, at 100% traffic with the
exact source SHA in its deployment message. An earlier deployment annotation had
a mistyped full SHA and was immediately corrected before final acceptance.

Verified named HTTPS with public IPv4 DNS: HTML, CSS, helper, SVG, and screenshot
all match the committed files exactly. The HTML SHA256 is
`334659b9e83c4020925f92b2f94a301300473cc8a9e24c8ce00c0a45055fe824`.
Public responses include `no-transform`, restrictive CSP, and HSTS, with only
the local copy helper in the HTML. HTTP preserves path/query through its HTTPS
redirect. Installer and update-manifest redirects returned the correct GitHub
assets; installer bytes match source and the manifest reports 0.2.0.

Reloaded the user's existing public browser tab and verified the new page,
navigation, release downloads, and copy-command success message. At the temporary
430px viewport, document width equals its 415px content viewport and the download
table fits its 345px container without horizontal overflow. Visually checked the
mobile release section, reset the viewport, and returned to the project overview.
The browser's only page script is `/site.js`. No OpenShell operation was performed.

## 2026-10-06: Ubuntu integration, system theme, and SSH transport

Reused the existing shield-and-terminal artwork for stable Ubuntu menu/dock
integration. The installer now installs the scalable icon and desktop metadata;
the release app repairs only the exact untouched legacy installer entry. Custom
entries and `--no-desktop` installs are preserved. No user favorites were changed.
Ten installer checks and six native migration tests passed. Physical GNOME dock
pinning/grouping remains a user-desktop acceptance step.

Added semantic light/dark palettes. The initial media preference is applied before
React renders, followed by native Tauri theme detection and change events, with
media-query fallback. No theme preference is saved. Six browser checks cover
light/dark rendering, live changes, native precedence, fallback, and stale initial
read races. The actual Ubuntu native WebKit window reported dark and rendered the
matching palette without changing system preferences.

Inspected NVIDIA/OpenShell v0.1.2 source and installed CLI: its SSH gateway
registration is metadata, not an active tunnel. The standard published gateway
port is 17670. ShellGuardian now owns temporary OpenSSH transport only, using the
existing OpenShell mTLS profile and verified native-generated loopback endpoint.
SSH alias key/user/port and jump-host configuration remain with OpenSSH. Strict
host-key checks, key/agent authentication, forwarding-only arguments, bounded
redacted diagnostics, and effective-config checks reject unrelated inherited
forwards. No authentication material or OpenShell config is copied or changed.

Session IDs scope all reads and mutations; a stale/dead ID cannot fall back to a
direct gateway. Normal disconnect waits for the entire active operation, then
kills/reaps and removes the session. App exit kills/reaps without waiting for
potentially long paginated reads; existing mutation guards protect close/update.
Native restart uses Tauri's event-loop restart request so exit cleanup runs.

Review found two UI recovery edges: failed scoped reads erased the profile picker,
and failed reconnect could visually select an unrelated direct gateway. Kept only
local profile discovery in memory independently of scoped data, added an explicit
unavailable SSH selection/default gateway choice, and prefilled reconnect settings.
Mutation review identifies the SSH destination as well as gateway/workspace.

Rust verification passed 38 bridge and 14 native tests, Clippy for both crates,
and a debug native build. The private SSH fixture uses temporary keys, a pinned
host key, restricted loopback forwards, and an extracted official Ubuntu sshd
package without system installation or changes to `~/.ssh`. Real forwarding,
changed-host-key and unauthorized-key rejection, forbidden-port rejection, and
the tunneled gateway TLS peer identity passed. Native read/disconnect, normal
window close, daemon-loss, full UI suite, and publication evidence follow below.

The complete native SSH acceptance passed against the real local OpenShell 0.1.2
gateway through the private SSH server: actual connect form, mTLS-authenticated
scoped snapshots, explicit disconnect listener closure, stale-ID rejection,
server-session death, no direct fallback, and normal native window-close cleanup.
The original direct gateway remained healthy and its active registration/state
was unchanged. Browser storage remained empty. Physical remote-host acceptance
was not performed because no remote destination was provided.

The test harness needed an actual X11 `WM_DELETE_WINDOW` message; WebDriver's
window-close endpoint closes only its browsing context. SSH daemon-loss testing
also needed to terminate fixture-owned session descendants: stopping the listener
alone intentionally leaves existing OpenSSH sessions alive. The fixture captures
only its own descendant PIDs/start times and does not match or stop unrelated
processes. All fixture keys/listeners and private display/driver processes were
cleaned up. The final full Chromium suite passed all 23 checks, including failed
initial reads, failed reconnect recovery, scoped mutation review, and both themes.

The v0.3.0 release workflow stopped before packaging on a Rustfmt difference in
one launcher-migration test assertion. Applied the pinned Rust 1.97 formatter and
checked the entire workspace. Kept the pushed tag immutable and advanced the
release to v0.3.1; no v0.3.0 binaries or update manifest were published.

Signed v0.3.1 was published from exact tag commit
`9ca9e26a325650cf28b40b925331d5c9931fe27b`. GitHub Actions run `37503180354`
passed the complete source checks and signed AppImage build in 10m38s. Its
85,322,232-byte AppImage has SHA256
`cfc0a648417facf19192aabdae2941c929b4be7f39d6e17b262e2454ea0e523e`.
All five advertised asset checksums and signed-version metadata matched.

Ran the public installer into isolated data/bin directories, keeping the real
OpenShell config read-only and untouched. The shipped AppImage passed the full
native SSH/mTLS lifecycle and current-dark-theme acceptance above. The live X11
WM_CLASS was `shellguardian`, `Shellguardian`; `_GTK_APPLICATION_ID` was
`bot.recurse.shellguardian`. Its installed icon/desktop entry validated, native
updater support remained enabled, and the installed binary hash was unchanged
after testing. Evidence and a screenshot are under
`.cache/public-release-0.3.1/`; the reusable verification script is checked in.
Physical GNOME pinning and a separate remote machine remain distinct acceptance
steps; no favorites or agent state were changed.

The static website release listing was deployed through the existing Cloudflare
Worker from pushed commit `20695c3a52d8625820761ee3209d277a2929dce9`, Worker version
`2e57527b-d4c0-4c1d-ae91-a0152daed857`. Used strict deployment conflict checking
and preserved the existing routes/configuration. Only the HTML asset changed;
the Tauri frontend was not deployed. All 18 distinct advertised project GitHub
URLs returned HTTP 200, including the versioned AppImage and verification files.

Live shellguardian.org HTML matches the committed bytes (SHA256
`def9abf4359e5b141a940dcbe7762a398a85820c25febeb809884dd169713d56`). HTTPS,
HSTS, restrictive CSP, `no-transform`, and HTTP-to-HTTPS path/query preservation
passed. The public installer and update-manifest redirects return bytes matching
the v0.3.1 release. The live browser renders v0.3.1, the new feature/release copy,
and 85.3 MB download information without horizontal overflow. Its only script is
the local copy helper. The temporary preview server and native test processes are
stopped. Cloudflare received only the static project page, never a gateway or app.

## 2026-10-06: actual Ubuntu Wayland icon failure

The user's screenshot showed a generic gear with the installed v0.3.1 app running
in their real Wayland session. The installed AppImage matched the published hash;
the desktop entry and SVG were present, and GTK could resolve and render the SVG.
The earlier X11/GTK metadata tests did not establish the native Wayland identity
or prove the dock's rendered icon. Keep the dock acceptance checkbox open.

A private-bus Wayland trace showed v0.3.1 announcing `shellguardian` through
`xdg_toplevel.set_app_id`, separately from its canonical GtkApplication ID
`bot.recurse.shellguardian`. GTK 3 uses the GLib program name for that protocol
field. GNOME has fallback matches, so the mismatch is not proof of the sole cause
of the generic icon; relying on those fallbacks left an avoidable integration gap.
Also found that Tauri creates configured windows before invoking the setup hook,
where the previous launcher repair had run.

Set the GLib program name to the canonical desktop ID before GTK initialization
and moved exact-managed-launcher repair ahead of window creation. Installer and
native migration now use an absolute SVG path, a canonical X11 match, and a hidden
legacy `shellguardian.desktop` alias. Existing custom aliases and symlinks remain
untouched. Independent review caught a possible installer hang when the alias was
a FIFO; comparisons now require a regular file, covered by FIFO/directory tests.

Applied the narrow local launcher repair to the user's existing install, retaining
the old v0.3.1 X11 class while that binary remains installed. Backed up the original
entry under `.cache/ubuntu-launcher-before-icon-fix.desktop`. The compatibility ID
now resolves through Gio to the real SVG, loads at 64x64, and is hidden from Show
Apps. Refreshed the per-user desktop database. Did not close the user's window,
change favorites, or interrupt their SSH tunnels. A close/reopen and rendered dock
confirmation remain with the user; Shell introspection denied access, and no
unsafe mode or introspection workaround was enabled.

The fixed debug build announced `bot.recurse.shellguardian` through both Wayland
and GTK on the actual display. Added a bounded reusable identity probe with
private D-Bus/XDG state and owned-process cleanup. The separate native X11 check
reported WM_CLASS `bot.recurse.shellguardian`, `Bot.recurse.shellguardian` and
matching GTK ID; SSH/mTLS lifecycle, current dark theme, unchanged OpenShell
selection, and empty browser storage also passed. Neither metadata check claims
visual dock acceptance. Signed patch-release verification follows below.
