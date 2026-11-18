//! Helpers shared by tests.

use std::path::Path;

/// Writes an executable script for a test to run.
///
/// The file is written by a child process, so this process never holds a
/// write descriptor to it. Tests run on many threads; if one forked while
/// another had the script open for writing, the forked child would inherit
/// that descriptor and running the script would fail with "text file busy".
#[cfg(unix)]
pub(crate) fn write_script(path: &Path, body: &str) {
    use std::io::Write;
    use std::process::{Command, Stdio};
    std::fs::create_dir_all(path.parent().expect("script path has a parent")).unwrap();
    let mut writer = Command::new("/bin/sh")
        .arg("-c")
        .arg("umask 077 && cat > \"$1\" && chmod 700 \"$1\"")
        .arg("sh")
        .arg(path)
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    writer
        .stdin
        .take()
        .unwrap()
        .write_all(body.as_bytes())
        .unwrap();
    assert!(writer.wait().unwrap().success(), "could not write {path:?}");
}
