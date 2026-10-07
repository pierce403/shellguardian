# Installation and updates

The first distributable is a Linux x86_64 AppImage, built on Ubuntu 22.04. GTK 3,
WebKitGTK 4.1, and an existing working OpenShell CLI/gateway are required. The
installer does not provision OpenShell, install system packages, or request sudo.
macOS, Windows, and Linux ARM do not have published packages yet.

```bash
curl -fsSL https://shellguardian.org/install.sh | bash
shellguardian
```

For inspection first:

```bash
curl -fsSL -o install.sh https://github.com/pierce403/shellguardian/releases/latest/download/install.sh
less install.sh
bash install.sh --version 0.4.0
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

## Ubuntu launcher and dock icon

The installer adds ShellGuardian to Show Apps with its green shield/terminal icon.
Open it there, then right-click its Ubuntu dock icon and choose **Pin to Dash**
(**Add to Favorites** on some Ubuntu versions). The application does not change
your favorites automatically.

The desktop entry is `applications/bot.recurse.shellguardian.desktop` under your
user data directory. Its GTK application ID, Wayland app ID, and
`StartupWMClass=bot.recurse.shellguardian` match that filename. GTK 3 takes its
Wayland ID from the GLib program name, which the app sets before creating windows.
The desktop entry uses an absolute icon path to avoid stale theme-cache lookups.
The scalable icon lives at
`icons/hicolor/scalable/apps/bot.recurse.shellguardian.svg` in that same data
directory. These paths remain stable when an update replaces the AppImage.

Before opening its window, the first launch after upgrading an older installation
repairs its unchanged installer-created desktop entry and adds the icon. A hidden
`shellguardian.desktop` compatibility entry supports the old Wayland ID without
adding another app-menu item. Customized entries,
launchers, and icons are preserved. Installations made with `--no-desktop` remain
without a menu entry; rerun the installer without that flag to add one. Re-running
the installer also refreshes the menu entry and icon without changing your pins.
If an already-open window still shows a generic gear after repair, close and reopen
ShellGuardian so GNOME can associate the new window with the corrected launcher.

The source artwork is `public/mark.svg`; Tauri's generated PNG/ICO/ICNS assets in
`src-tauri/icons` use the same mark. Regenerate those assets with
`npm run tauri -- icon public/mark.svg` after changing the artwork. Keep the
installer's embedded SVG identical to the source; installer checks enforce this.

## Download verification

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
is in the owner-only ignored `.release-keys/updater.key`. Never print, commit,
or put the private key in a website. Preserve it outside disposable build caches
before removing the checkout; losing it prevents updates to existing installs.

Update the workspace, npm, and Tauri versions together, commit and push main,
then push an immutable `vX.Y.Z` tag. The pinned Actions workflow tests the exact
source, builds/signs an AppImage, and creates a GitHub Release with the AppImage,
signature, bootstrap script, `version.txt`, `SHA256SUMS`, and Tauri `latest.json`.
`scripts/prepare-release.mjs` refuses signatures without the signed release version.

Releases remain preview quality until live mutation, remote-host, and platform
acceptance gates in `FEATURES.md` are complete.
