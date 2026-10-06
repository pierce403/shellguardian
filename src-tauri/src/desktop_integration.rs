//! Repair exact desktop entries emitted by the Linux installer.
//!
//! The application never creates a menu entry for a `--no-desktop` installation,
//! changes GNOME favorites, or replaces a customized launcher/icon. The stable
//! desktop ID also matches Tauri's GTK application ID for Wayland grouping.

use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// Shared desktop filename, GTK application ID, and native window identity.
pub const APP_ID: &str = "bot.recurse.shellguardian";
const ICON: &[u8] = include_bytes!("../../public/mark.svg");
const LAUNCHER_HEADER: &str = "#!/usr/bin/env bash\n# ShellGuardian managed launcher\n# Extraction avoids requiring FUSE; OpenShell stays untouched.\nexport APPIMAGE_EXTRACT_AND_RUN=1\n";

/// Align untouched per-user desktop integration after a self-update.
///
/// Development binaries and AppImages launched outside the managed install path
/// do nothing. Returns whether the desktop entry was repaired; a repair failure
/// should not prevent the application from starting.
pub fn repair_legacy_launcher() -> io::Result<bool> {
    if cfg!(debug_assertions) {
        return Ok(false);
    }
    let Some(appimage) = std::env::var_os("APPIMAGE").map(PathBuf::from) else {
        return Ok(false);
    };
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")));
    let Some(data_home) = data_home.filter(|path| path.is_absolute()) else {
        return Ok(false);
    };
    repair_at(&data_home, &appimage)
}

fn repair_at(data_home: &Path, appimage: &Path) -> io::Result<bool> {
    if !safe_installer_path(data_home)
        || appimage.file_name().and_then(|name| name.to_str()) != Some("ShellGuardian.AppImage")
        || !safe_installer_path(appimage)
        || !regular_file(appimage)?
    {
        return Ok(false);
    }
    let marker = appimage.parent().unwrap().join(".shellguardian-install");
    let Some(marker) = read_regular(&marker, 32)? else {
        return Ok(false);
    };
    let version = String::from_utf8_lossy(&marker);
    let components: Vec<_> = version.trim_end_matches('\n').split('.').collect();
    if components.len() != 3
        || components
            .iter()
            .any(|part| part.is_empty() || !part.bytes().all(|value| value.is_ascii_digit()))
    {
        return Ok(false);
    }

    let desktop_path = data_home.join(format!("applications/{APP_ID}.desktop"));
    let Some(bytes) = read_regular(&desktop_path, 16_384)? else {
        return Ok(false);
    };
    let Ok(desktop) = std::str::from_utf8(&bytes) else {
        return Ok(false);
    };
    let Some(launcher) = desktop
        .lines()
        .find_map(|line| line.strip_prefix("Exec=\"")?.strip_suffix('"'))
        .map(PathBuf::from)
    else {
        return Ok(false);
    };
    let icon_path = data_home.join(format!("icons/hicolor/scalable/apps/{APP_ID}.svg"));
    let absolute_icon = icon_path.to_str().unwrap();
    let managed = desktop == legacy_desktop(&launcher)
        || ["shellguardian", APP_ID].iter().any(|class| {
            [APP_ID, absolute_icon]
                .iter()
                .any(|icon| desktop == installed_desktop(&launcher, icon, class))
        });
    if !safe_installer_path(&launcher)
        || launcher.file_name().and_then(|name| name.to_str()) != Some("shellguardian")
        || !managed
    {
        return Ok(false);
    }
    let expected_launcher = format!(
        "{LAUNCHER_HEADER}exec {} \"$@\"\n",
        appimage.to_str().unwrap().replace(' ', "\\ ")
    );
    if read_regular(&launcher, 16_384)?.as_deref() != Some(expected_launcher.as_bytes()) {
        return Ok(false);
    }

    let mut changed = false;
    match fs::symlink_metadata(&icon_path) {
        Ok(metadata) => {
            if !metadata.is_file() || read_regular(&icon_path, 4096)?.as_deref() != Some(ICON) {
                return Ok(false);
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir_all(icon_path.parent().unwrap())?;
            atomic_write(&icon_path, ICON)?;
            changed = true;
        }
        Err(error) => return Err(error),
    }

    // Use an absolute icon path for this migration, so an existing
    // desktop icon cache cannot hide the newly installed asset until logout.
    let repaired = installed_desktop(&launcher, absolute_icon, APP_ID);
    // Preserve an entry edited while the icon was being installed.
    if read_regular(&desktop_path, 16_384)?.as_deref() != Some(bytes.as_slice()) {
        return Ok(false);
    }
    if desktop != repaired {
        atomic_write(&desktop_path, repaired.as_bytes())?;
        changed = true;
    }
    // Older already-running clients announce "shellguardian" on Wayland.
    // Keep their hidden compatibility identity without adding a second menu item.
    changed |= repair_compatibility_launcher(data_home, &launcher, absolute_icon)?;
    Ok(changed)
}

fn repair_compatibility_launcher(
    data_home: &Path,
    launcher: &Path,
    absolute_icon: &str,
) -> io::Result<bool> {
    let path = data_home.join("applications/shellguardian.desktop");
    let expected = compatibility_desktop(launcher, absolute_icon);
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.is_file() {
                return Ok(false);
            }
            let Some(bytes) = read_regular(&path, 16_384)? else {
                return Ok(false);
            };
            if bytes == expected.as_bytes() {
                return Ok(false);
            }
            if bytes != compatibility_desktop(launcher, APP_ID).as_bytes() {
                return Ok(false);
            }
            // Recheck the owned template before updating an existing alias.
            if read_regular(&path, 16_384)?.as_deref() != Some(bytes.as_slice()) {
                return Ok(false);
            }
            atomic_write(&path, expected.as_bytes())?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let temporary = temporary_file(&path, expected.as_bytes())?;
            match temporary.persist_noclobber(&path) {
                Ok(_) => {}
                Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
                    return Ok(false)
                }
                Err(error) => return Err(error.error),
            }
        }
        Err(error) => return Err(error),
    }
    Ok(true)
}

fn safe_installer_path(path: &Path) -> bool {
    path.is_absolute()
        && path.to_str().is_some_and(|value| {
            value.bytes().all(|value| {
                value.is_ascii_alphanumeric() || matches!(value, b'/' | b'_' | b'.' | b' ' | b'-')
            })
        })
}

fn regular_file(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.is_file()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn read_regular(path: &Path, max_bytes: u64) -> io::Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && metadata.len() <= max_bytes => {
            fs::read(path).map(Some)
        }
        Ok(_) => Ok(None),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn temporary_file(path: &Path, bytes: &[u8]) -> io::Result<tempfile::NamedTempFile> {
    let mut temporary = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o644))?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    Ok(temporary)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temporary = temporary_file(path, bytes)?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

fn legacy_desktop(launcher: &Path) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName=ShellGuardian\nComment=Control room for NVIDIA OpenShell agents\nExec=\"{}\"\nTerminal=false\nCategories=Development;Utility;\n",
        launcher.display()
    )
}

fn installed_desktop(launcher: &Path, icon: &str, class: &str) -> String {
    legacy_desktop(launcher).replace(
        "Terminal=false\n",
        &format!("Icon={icon}\nStartupWMClass={class}\nStartupNotify=true\nTerminal=false\n"),
    )
}

fn compatibility_desktop(launcher: &Path, icon: &str) -> String {
    installed_desktop(launcher, icon, "shellguardian").replace(
        "Terminal=false\n",
        "NoDisplay=true\nX-ShellGuardian-Compatibility=true\nTerminal=false\n",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    struct Installation {
        _root: tempfile::TempDir,
        data: PathBuf,
        appimage: PathBuf,
        launcher: PathBuf,
        desktop: PathBuf,
        icon: PathBuf,
    }

    impl Installation {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let data = root.path().join("user data");
            let app = data.join("shellguardian");
            let appimage = app.join("ShellGuardian.AppImage");
            let launcher = root.path().join("bin/shellguardian");
            let desktop = data.join(format!("applications/{APP_ID}.desktop"));
            let icon = data.join(format!("icons/hicolor/scalable/apps/{APP_ID}.svg"));
            fs::create_dir_all(&app).unwrap();
            fs::create_dir_all(launcher.parent().unwrap()).unwrap();
            fs::create_dir_all(desktop.parent().unwrap()).unwrap();
            fs::write(&appimage, "test AppImage").unwrap();
            fs::write(app.join(".shellguardian-install"), "0.2.0\n").unwrap();
            fs::write(
                &launcher,
                format!(
                    "{LAUNCHER_HEADER}exec {} \"$@\"\n",
                    appimage.to_str().unwrap().replace(' ', "\\ ")
                ),
            )
            .unwrap();
            fs::write(&desktop, legacy_desktop(&launcher)).unwrap();
            Self {
                _root: root,
                data,
                appimage,
                launcher,
                desktop,
                icon,
            }
        }

        fn repair(&self) -> bool {
            repair_at(&self.data, &self.appimage).unwrap()
        }
    }

    #[test]
    fn repairs_only_once_with_stable_icon_and_desktop_identity() {
        let install = Installation::new();
        assert!(install.repair());
        let desktop = fs::read_to_string(&install.desktop).unwrap();
        assert!(desktop.contains(&format!("Icon={}\n", install.icon.display())));
        assert!(desktop.contains(&format!("StartupWMClass={APP_ID}\nStartupNotify=true\n")));
        assert!(desktop.contains(&format!("Exec=\"{}\"\n", install.launcher.display())));
        assert_eq!(fs::read(&install.icon).unwrap(), ICON);
        assert_eq!(
            fs::read_to_string(install.data.join("applications/shellguardian.desktop")).unwrap(),
            compatibility_desktop(&install.launcher, install.icon.to_str().unwrap())
        );
        assert_eq!(
            fs::metadata(&install.icon).unwrap().permissions().mode() & 0o777,
            0o644
        );
        assert!(!install.repair());
        assert_eq!(fs::read_to_string(&install.desktop).unwrap(), desktop);
    }

    #[test]
    fn no_desktop_install_and_customized_entry_are_preserved() {
        let install = Installation::new();
        fs::remove_file(&install.desktop).unwrap();
        assert!(!install.repair());
        assert!(!install.icon.exists());
        assert!(!install
            .data
            .join("applications/shellguardian.desktop")
            .exists());
        let custom = format!("{}X-Custom=true\n", legacy_desktop(&install.launcher));
        fs::write(&install.desktop, &custom).unwrap();
        assert!(!install.repair());
        assert_eq!(fs::read_to_string(&install.desktop).unwrap(), custom);
        assert!(!install.icon.exists());
    }

    #[test]
    fn updates_current_named_and_absolute_icon_entries_to_canonical_identity() {
        for class in ["shellguardian", APP_ID] {
            for named_icon in [true, false] {
                let install = Installation::new();
                fs::write(
                    install
                        .appimage
                        .parent()
                        .unwrap()
                        .join(".shellguardian-install"),
                    "0.3.1\n",
                )
                .unwrap();
                let icon = if named_icon {
                    APP_ID
                } else {
                    install.icon.to_str().unwrap()
                };
                fs::write(
                    &install.desktop,
                    installed_desktop(&install.launcher, icon, class),
                )
                .unwrap();
                assert!(install.repair());
                assert_eq!(
                    fs::read_to_string(&install.desktop).unwrap(),
                    installed_desktop(&install.launcher, install.icon.to_str().unwrap(), APP_ID)
                );
                assert!(!install.repair());
            }
        }
    }

    #[test]
    fn customized_current_desktop_entry_is_preserved() {
        let install = Installation::new();
        let custom = format!(
            "{}X-Custom=true\n",
            installed_desktop(&install.launcher, APP_ID, "shellguardian")
        );
        fs::write(&install.desktop, &custom).unwrap();
        assert!(!install.repair());
        assert_eq!(fs::read_to_string(&install.desktop).unwrap(), custom);
        assert!(!install
            .data
            .join("applications/shellguardian.desktop")
            .exists());
    }

    #[test]
    fn updates_only_exact_owned_compatibility_entries() {
        let install = Installation::new();
        let path = install.data.join("applications/shellguardian.desktop");
        fs::write(&path, compatibility_desktop(&install.launcher, APP_ID)).unwrap();
        assert!(install.repair());
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            compatibility_desktop(&install.launcher, install.icon.to_str().unwrap())
        );
        let customized = format!("{}X-Custom=true\n", fs::read_to_string(&path).unwrap());
        fs::write(&path, &customized).unwrap();
        assert!(!install.repair());
        assert_eq!(fs::read_to_string(&path).unwrap(), customized);
    }

    #[test]
    fn custom_or_symlinked_compatibility_entries_do_not_block_canonical_repair() {
        for symbolic in [false, true] {
            let install = Installation::new();
            let path = install.data.join("applications/shellguardian.desktop");
            let custom = "[Desktop Entry]\nName=My custom ShellGuardian launcher\n";
            let saved = install.data.join("saved-compatibility.desktop");
            if symbolic {
                fs::write(&saved, custom).unwrap();
                symlink(&saved, &path).unwrap();
            } else {
                fs::write(&path, custom).unwrap();
            }
            assert!(install.repair());
            assert_eq!(fs::read_to_string(&path).unwrap(), custom);
            assert_eq!(
                fs::symlink_metadata(&path)
                    .unwrap()
                    .file_type()
                    .is_symlink(),
                symbolic
            );
            assert!(fs::read_to_string(&install.desktop)
                .unwrap()
                .contains(&format!("StartupWMClass={APP_ID}\n")));
        }
    }

    #[test]
    fn custom_launcher_and_other_appimage_install_are_preserved() {
        let install = Installation::new();
        fs::write(&install.launcher, "#!/bin/sh\n# a custom launcher\n").unwrap();
        assert!(!install.repair());
        assert!(!install.icon.exists());
        let other = install.data.join("Other.AppImage");
        fs::write(&other, "other install").unwrap();
        assert!(!repair_at(&install.data, &other).unwrap());
    }

    #[test]
    fn missing_install_marker_does_not_claim_unmanaged_files() {
        let install = Installation::new();
        fs::remove_file(
            install
                .appimage
                .parent()
                .unwrap()
                .join(".shellguardian-install"),
        )
        .unwrap();
        assert!(!install.repair());
        assert!(!install.icon.exists());
    }

    #[test]
    fn symlinked_desktop_launcher_appimage_or_icon_is_never_replaced() {
        for field in 0..4 {
            let install = Installation::new();
            let target = match field {
                0 => &install.desktop,
                1 => &install.launcher,
                2 => &install.appimage,
                _ => &install.icon,
            };
            let saved = install.data.join("saved-file");
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            if target.exists() {
                fs::rename(target, &saved).unwrap();
            } else {
                fs::write(&saved, ICON).unwrap();
            }
            let bytes = fs::read(&saved).unwrap();
            symlink(&saved, target).unwrap();
            assert!(!install.repair());
            assert!(fs::symlink_metadata(target)
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(fs::read(&saved).unwrap(), bytes);
        }
    }

    #[test]
    fn customized_icon_is_preserved() {
        let install = Installation::new();
        fs::create_dir_all(install.icon.parent().unwrap()).unwrap();
        fs::write(&install.icon, "custom icon").unwrap();
        assert!(!install.repair());
        assert_eq!(fs::read_to_string(&install.icon).unwrap(), "custom icon");
        assert_eq!(
            fs::read_to_string(&install.desktop).unwrap(),
            legacy_desktop(&install.launcher)
        );
    }
}
