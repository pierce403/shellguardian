//! Bounded, noninteractive subprocess execution. No shell is involved.

use crate::{Error, Result};
use regex::Regex;
use std::{ffi::OsString, future::Future, process::Stdio, sync::LazyLock, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

pub trait Runner: Send + Sync {
    fn run(
        &self,
        args: &[String],
        timeout: Duration,
    ) -> impl Future<Output = Result<String>> + Send;
}

#[derive(Clone)]
pub struct ProcessRunner {
    executable: OsString,
}

impl Default for ProcessRunner {
    fn default() -> Self {
        Self {
            executable: "openshell".into(),
        }
    }
}

async fn read_bounded(mut stream: impl AsyncRead + Unpin, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    (&mut stream)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| Error::new("Could not read OpenShell output."))?;
    if bytes.len() as u64 > limit {
        return Err(Error::new(
            "OpenShell output exceeded the safe display limit.",
        ));
    }
    Ok(bytes)
}

impl Runner for ProcessRunner {
    async fn run(&self, args: &[String], timeout: Duration) -> Result<String> {
        let mut command = Command::new(&self.executable);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env("NO_COLOR", "1")
            .env("OPENSHELL_COLOR", "never")
            .env_remove("OPENSHELL_GATEWAY_ENDPOINT")
            .env_remove("OPENSHELL_GATEWAY_INSECURE")
            .env_remove("OPENSHELL_GATEWAY")
            .env_remove("OPENSHELL_WORKSPACE");
        // Suppress the extra console window for GUI applications on Windows.
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Error::new("OpenShell was not found on PATH. Install the NVIDIA OpenShell CLI, then reopen ShellGuardian.")
            } else { Error::new("Could not launch the installed OpenShell CLI.") }
        })?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::new("OpenShell stdout was unavailable."))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| Error::new("OpenShell stderr was unavailable."))?;
        let execution = async {
            let (stdout, stderr, status) = tokio::try_join!(
                read_bounded(stdout, 2 * 1024 * 1024),
                read_bounded(stderr, 128 * 1024),
                async {
                    child
                        .wait()
                        .await
                        .map_err(|_| Error::new("Could not wait for OpenShell."))
                }
            )?;
            if !status.success() {
                let safe_error = redact(&String::from_utf8_lossy(&stderr));
                return Err(Error::new(if safe_error.trim().is_empty() {
                    "OpenShell did not complete the operation.".into()
                } else {
                    safe_error.chars().take(3000).collect::<String>()
                }));
            }
            String::from_utf8(stdout).map_err(|_| Error::new("OpenShell returned invalid UTF-8."))
        };
        tokio::time::timeout(timeout, execution).await.map_err(|_| {
            Error::new("OpenShell timed out. A requested change may already be saved; refresh its status before retrying.")
        })?
    }
}

/// Best-effort display redaction for logs/errors, not a replacement for upstream
/// secret hygiene. Never retrieve credential payloads in the first place.
pub fn redact(input: &str) -> String {
    static PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
        vec![
        Regex::new(r"(?i)(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s\x22,}]+").unwrap(),
        Regex::new(r"(?i)((?:[a-z0-9_]*(?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|password|secret(?:_access_key)?)[a-z0-9_]*)[\x22']?\s*[:=]\s*[\x22']?)[^\s\x22',}]+").unwrap(),
        Regex::new(r"\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{15,}|github_pat_[A-Za-z0-9_]{15,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b").unwrap(),
        Regex::new(r"(?s)-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----.*?-----END (?:[A-Z ]*PRIVATE KEY)-----").unwrap(),
        Regex::new(r"(https?://)[^\s/@:]+:[^\s/@]+@").unwrap(),
    ]
    });
    let mut safe = input.to_string();
    for (index, pattern) in PATTERNS.iter().enumerate() {
        safe = pattern
            .replace_all(
                &safe,
                if matches!(index, 0 | 1 | 4) {
                    "${1}[redacted]"
                } else {
                    "[redacted]"
                },
            )
            .into_owned();
    }
    safe
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn oversized_stream_is_rejected() {
        assert!(read_bounded(&b"12345"[..], 4).await.is_err());
        assert_eq!(read_bounded(&b"1234"[..], 4).await.unwrap(), b"1234");
    }

    #[tokio::test]
    async fn missing_executable_has_actionable_error() {
        let runner = ProcessRunner {
            executable: "/nonexistent-shellguardian-test-binary".into(),
        };
        assert!(runner
            .run(&[], Duration::from_secs(1))
            .await
            .unwrap_err()
            .message
            .contains("not found on PATH"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_returns_without_waiting_for_long_running_process() {
        let runner = ProcessRunner {
            executable: "/bin/sleep".into(),
        };
        let started = std::time::Instant::now();
        let error = runner
            .run(&["5".into()], Duration::from_millis(25))
            .await
            .unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(error.message.contains("may already be saved"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn invalid_utf8_is_rejected_at_process_boundary() {
        let runner = ProcessRunner {
            executable: "/usr/bin/printf".into(),
        };
        assert!(runner
            .run(&["\\377".into()], Duration::from_secs(1))
            .await
            .unwrap_err()
            .message
            .contains("UTF-8"));
    }
}
