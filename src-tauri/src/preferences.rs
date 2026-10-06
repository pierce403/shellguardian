//! Only the app-update preference is persisted. OpenShell remains the state owner.
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::Path};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub auto_update: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self { auto_update: true }
    }
}

pub fn load(path: &Path) -> Result<Preferences, &'static str> {
    match fs::read(path) {
        Ok(bytes) if bytes.len() <= 1024 => serde_json::from_slice(&bytes)
            .map_err(|_| "Update preferences are unreadable. Automatic updates are paused."),
        Ok(_) => Err("Update preferences are too large. Automatic updates are paused."),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Preferences::default()),
        Err(_) => Err("Could not read update preferences. Automatic updates are paused."),
    }
}

pub fn save(path: &Path, preferences: &Preferences) -> Result<(), &'static str> {
    let parent = path
        .parent()
        .ok_or("Could not locate the preferences directory.")?;
    fs::create_dir_all(parent).map_err(|_| "Could not create the preferences directory.")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Could not save update preferences.")?;
    serde_json::to_writer(&mut temporary, preferences)
        .map_err(|_| "Could not save update preferences.")?;
    temporary
        .flush()
        .map_err(|_| "Could not save update preferences.")?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "Could not save update preferences.")?;
    temporary
        .persist(path)
        .map_err(|_| "Could not replace update preferences.")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_launch_defaults_to_on_without_creating_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preferences.json");
        assert!(load(&path).unwrap().auto_update);
        assert!(!path.exists());
    }

    #[test]
    fn opt_out_survives_restart_and_can_be_reenabled() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/preferences.json");
        for enabled in [false, true, false] {
            save(
                &path,
                &Preferences {
                    auto_update: enabled,
                },
            )
            .unwrap();
            assert_eq!(load(&path).unwrap().auto_update, enabled);
        }
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn corrupt_or_unknown_preferences_do_not_silently_reenable_updates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preferences.json");
        for bytes in [
            "",
            "{}",
            "{\"autoUpdate\":\"false\"}",
            "{\"autoUpdate\":false,\"token\":1}",
        ] {
            fs::write(&path, bytes).unwrap();
            assert!(load(&path).is_err());
        }
        fs::write(&path, vec![b' '; 1025]).unwrap();
        assert!(load(&path).is_err());
    }

    #[test]
    fn failed_save_preserves_previous_opt_out() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preferences.json");
        save(&path, &Preferences { auto_update: false }).unwrap();
        assert!(save(&path.join("invalid"), &Preferences::default()).is_err());
        assert!(!load(&path).unwrap().auto_update);
    }
}
