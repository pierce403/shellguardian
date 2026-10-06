//! Independent, read-only official release checking.
use crate::{model::UpdateInfo, Error, Result};
use semver::Version;
use serde::Deserialize;
use std::time::Duration;

pub fn compare_versions(installed: &str, latest: &str) -> Result<&'static str> {
    let installed = Version::parse(installed.trim_start_matches('v'))
        .map_err(|_| Error::new("Installed version is not a semantic version."))?;
    let latest = Version::parse(latest.trim_start_matches('v'))
        .map_err(|_| Error::new("Latest release is not a semantic version."))?;
    if !latest.pre.is_empty() {
        return Err(Error::new(
            "The latest release endpoint returned a prerelease.",
        ));
    }
    Ok(match installed.cmp(&latest) {
        std::cmp::Ordering::Less => "available",
        std::cmp::Ordering::Equal => "current",
        std::cmp::Ordering::Greater => "ahead",
    })
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    published_at: Option<String>,
    prerelease: bool,
    draft: bool,
}

pub async fn check_updates(installed: Option<String>) -> UpdateInfo {
    let result = async {
        let client = reqwest::Client::builder()
            .https_only(true)
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("ShellGuardian/0.1.0")
            .build()
            .map_err(|_| Error::new("Could not initialize the release check."))?;
        let response = client
            .get("https://api.github.com/repos/NVIDIA/OpenShell/releases/latest")
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|_| Error::new("The official release service could not be reached."))?
            .error_for_status()
            .map_err(|_| {
                Error::new("The official release service rejected the check. Try again later.")
            })?;
        if response
            .content_length()
            .is_some_and(|size| size > 256 * 1024)
        {
            return Err(Error::new("Release response exceeded the display limit."));
        }
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| Error::new("Could not read release metadata."))?
        {
            bytes.extend_from_slice(&chunk);
            if bytes.len() > 256 * 1024 {
                return Err(Error::new("Release response exceeded the display limit."));
            }
        }
        let release: Release = serde_json::from_slice(&bytes)
            .map_err(|_| Error::new("Release metadata format is unsupported."))?;
        if release.draft || release.prerelease {
            return Err(Error::new(
                "The release endpoint did not return a stable release.",
            ));
        }
        let latest = Version::parse(release.tag_name.trim_start_matches('v'))
            .map_err(|_| Error::new("Release version is unsupported."))?;
        let status = match &installed {
            Some(version) => compare_versions(version, &latest.to_string())?,
            None => "not-installed",
        };
        Ok(UpdateInfo {
            status: status.into(),
            installed_version: installed.clone(),
            latest_version: Some(latest.to_string()),
            release_url: Some(format!(
                "https://github.com/NVIDIA/OpenShell/releases/tag/{}",
                release.tag_name
            )),
            published_at: release.published_at,
            error: None,
        })
    }
    .await;
    result.unwrap_or_else(|error: Error| UpdateInfo {
        status: "unavailable".into(),
        installed_version: installed,
        latest_version: None,
        release_url: None,
        published_at: None,
        error: Some(error.message),
    })
}
