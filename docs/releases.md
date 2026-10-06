# Installation and updates

The first distributable is a Linux x86_64 AppImage, built on Ubuntu 22.04. GTK 3,
WebKitGTK 4.1, and an existing working OpenShell CLI/gateway are required. The
installer does not provision OpenShell, install system packages, or request sudo.
macOS, Windows, and Linux ARM do not have published packages yet.

```bash
curl -fsSL https://github.com/pierce403/shellguardian/releases/latest/download/install.sh | bash
shellguardian
```

For inspection first:

```bash
curl -fsSL -o install.sh https://github.com/pierce403/shellguardian/releases/latest/download/install.sh
less install.sh
bash install.sh --version 0.2.0
```

On Ubuntu/Debian, GTK/WebKit runtime packages are `libgtk-3-0` (or
`libgtk-3-0t64` on newer distributions) and `libwebkit2gtk-4.1-0`. Installing
those system dependencies is the user's separate privileged action.

## Files and trust

Default application path: `$XDG_DATA_HOME/shellguardian/ShellGuardian.AppImage`,
or `$HOME/.local/share/shellguardian/ShellGuardian.AppImage`. The launcher lives at
`$HOME/.local/bin/shellguardian`; a desktop entry is added to the user's application
menu. The launcher uses `APPIMAGE_EXTRACT_AND_RUN=1`, avoiding a FUSE requirement.
Override paths with `SHELLGUARDIAN_INSTALL_DIR`, `SHELLGUARDIAN_BIN_DIR`, and
`XDG_DATA_HOME`; pass `--no-desktop` to skip menu integration.

The bootstrap script and checksum manifest are trusted through GitHub HTTPS.
SHA256 detects corrupted downloads, not a malicious publisher who can replace
both the artifact and its checksum. Inspect the script first if this bootstrap
trust is unsuitable. It refuses root installs, bad/duplicate checksums, symlink
targets, and unrelated existing launchers/apps. Re-running the installer retains
one prior AppImage for rollback before replacing the current file atomically.

## Automatic app updates

ShellGuardian's update switch defaults on. Checks run at launch and every six
hours while the app is open. Tauri verifies both the artifact signature and the
version in its signed trusted comment against the release manifest. Only stable
releases from this project's fixed GitHub channel are accepted. No unsigned
updates, downgrades, frontend-supplied endpoints, or silent OpenShell upgrades.

Verified bytes are staged in memory. On normal window close they are installed
before the app exits; the next launch uses the new version. “Restart to update”
applies them immediately. Force-killing the app discards the pending download.
An in-flight OpenShell lifecycle/provider/policy command blocks closing/restarting.
Installation errors leave the session open and are reported in app settings.

Turning the switch off cancels/discards pending automatic work. Manual checks,
downloads, and explicit restart remain available. `preferences.json` in Tauri's
app-config directory contains only `{"autoUpdate":false}` (or `true`); it is
atomically replaced and owner-only. Missing means enabled; corrupt/unreadable
means paused, with an error, to avoid accidentally overriding an opt-out. Normal
development builds and unbundled Linux executables cannot replace themselves.

No application database, copied credentials, policy archive, update daemon, or
browser storage is added. OpenShell continues to own all agent state/enforcement.

## Maintainer release path

The public verification key is committed in `src-tauri/tauri.conf.json`.
`TAURI_SIGNING_PRIVATE_KEY` is a repository Actions secret; an owner-only backup
is in the ignored local `.cache/signing/shellguardian.key`. Never print, commit,
or put the private key in a website. Preserve it outside disposable build caches
before cleaning the checkout; losing it prevents updates to existing installs.

Update the workspace, npm, and Tauri versions together, commit and push main,
then push an immutable `vX.Y.Z` tag. The pinned Actions workflow tests the exact
source, builds/signs an AppImage, and creates a GitHub Release with the AppImage,
signature, bootstrap script, `version.txt`, `SHA256SUMS`, and Tauri `latest.json`.
`scripts/prepare-release.mjs` refuses signatures without the signed release version.

Releases remain preview quality until live mutation, remote-host, and platform
acceptance gates in `FEATURES.md` are complete.
