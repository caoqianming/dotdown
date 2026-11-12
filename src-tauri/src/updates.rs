use reqwest::{Client, Url};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, AppHandle, Manager};

const REPO: &str = "caoqianming/dotdown";
const MAX_INSTALLER: u64 = 256 * 1024 * 1024;

#[derive(Clone, Copy)]
enum Mirror {
    Gitee,
    GitHub,
}

impl Mirror {
    fn api(self) -> &'static str {
        match self {
            Self::Gitee => "https://gitee.com/api/v5/repos/caoqianming/dotdown/releases/latest",
            Self::GitHub => "https://api.github.com/repos/caoqianming/dotdown/releases/latest",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Gitee => "Gitee",
            Self::GitHub => "GitHub",
        }
    }

    fn asset_url(self, raw: &str) -> Option<Url> {
        let url = Url::parse(raw).ok()?;
        let host = match self {
            Self::Gitee => "gitee.com",
            Self::GitHub => "github.com",
        };
        (url.scheme() == "https"
            && url.host_str() == Some(host)
            && url.path().starts_with(&format!("/{REPO}/"))
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none())
        .then_some(url)
    }
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    size: Option<u64>,
    digest: Option<String>,
}

#[derive(Serialize, Clone)]
pub(crate) struct Progress {
    version: String,
    source: &'static str,
    received: u64,
    total: Option<u64>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Outcome {
    Current,
    Downloaded { version: String, path: String },
    Unavailable { version: String },
}

fn installer_name(version: &Version) -> Option<String> {
    if !cfg!(target_os = "windows") {
        return None;
    }
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "x86",
        _ => return None,
    };
    Some(format!("Dotdown_{version}_{arch}-setup.exe"))
}

fn stable_version(tag: &str) -> Option<Version> {
    let version = Version::parse(tag.strip_prefix(['v', 'V']).unwrap_or(tag)).ok()?;
    version.pre.is_empty().then_some(version)
}

async fn latest(client: Client, mirror: Mirror) -> Result<(Mirror, Version, Release), String> {
    let release: Release = client
        .get(mirror.api())
        .timeout(Duration::from_secs(12))
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())?;
    let version = stable_version(&release.tag_name)
        .filter(|_| !release.draft && !release.prerelease)
        .ok_or_else(|| "没有找到正式发行版".to_string())?;
    Ok((mirror, version, release))
}

fn expected_hash(asset: &Asset) -> Option<&str> {
    asset
        .digest
        .as_deref()
        .and_then(|digest| digest.strip_prefix("sha256:"))
        .filter(|hex| hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn valid_cached(path: &Path, size: Option<u64>, digest: Option<&str>) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let Ok(metadata) = file.metadata() else {
        return false;
    };
    let length = metadata.len();
    if !metadata.is_file()
        || length < 2
        || length > MAX_INSTALLER
        || size.is_some_and(|size| length != size)
    {
        return false;
    }
    let mut magic = [0; 2];
    if file.read_exact(&mut magic).is_err() || &magic != b"MZ" {
        return false;
    }
    match digest {
        Some(digest) => {
            let mut hash = Sha256::new();
            hash.update(magic);
            std::io::copy(&mut file.take(MAX_INSTALLER), &mut hash).is_ok()
                && format!("{:x}", hash.finalize()).eq_ignore_ascii_case(digest)
        }
        None => size.is_some(),
    }
}

async fn fetch_installer(
    client: &Client,
    url: Url,
    digest: Option<&str>,
    destination: &Path,
    mut progress: Progress,
    channel: &Channel<Progress>,
) -> Result<(), String> {
    let size = progress.total;
    if valid_cached(destination, size, digest) {
        return Ok(());
    }

    let _ = channel.send(progress.clone());
    let mut response = client
        .get(url)
        .timeout(Duration::from_secs(240))
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|error| error.to_string())?;
    let total = response.content_length();
    if size
        .zip(total)
        .is_some_and(|(expected, actual)| expected != actual)
    {
        return Err("安装包大小与发行版记录不符".into());
    }
    progress.total = size.or(total);
    if progress
        .total
        .is_some_and(|length| !(2..=MAX_INSTALLER).contains(&length))
    {
        return Err("安装包大小异常".into());
    }
    let folder = destination.parent().ok_or("更新目录无效")?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(folder).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    let mut magic = Vec::<u8>::with_capacity(2);
    let mut last_update = Instant::now();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        progress.received += chunk.len() as u64;
        if progress.received > progress.total.unwrap_or(MAX_INSTALLER) {
            return Err("安装包超过预期大小".into());
        }
        if magic.len() < 2 {
            magic.extend_from_slice(&chunk[..chunk.len().min(2 - magic.len())]);
            if magic.len() == 2 && magic != b"MZ" {
                return Err("下载内容不是 Windows 安装包".into());
            }
        }
        if digest.is_some() {
            hash.update(&chunk);
        }
        temporary
            .write_all(&chunk)
            .map_err(|error| error.to_string())?;
        if last_update.elapsed() >= Duration::from_millis(160) {
            let _ = channel.send(progress.clone());
            last_update = Instant::now();
        }
    }
    if magic != b"MZ"
        || progress
            .total
            .is_some_and(|total| progress.received != total)
    {
        return Err("安装包下载不完整".into());
    }
    if digest
        .is_some_and(|expected| !format!("{:x}", hash.finalize()).eq_ignore_ascii_case(expected))
    {
        return Err("安装包 SHA-256 校验失败".into());
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temporary
        .persist(destination)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    on_progress: Channel<Progress>,
) -> Result<Outcome, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let current = app.package_info().version.clone();
    let client = Client::builder()
        .https_only(true)
        .user_agent(format!("Dotdown/{current}"))
        .connect_timeout(Duration::from_secs(8))
        .build()
        .map_err(|error| error.to_string())?;
    let gitee = tauri::async_runtime::spawn(latest(client.clone(), Mirror::Gitee));
    let github = tauri::async_runtime::spawn(latest(client.clone(), Mirror::GitHub));
    let releases: Vec<_> = [gitee.await, github.await]
        .into_iter()
        .filter_map(|result| result.ok()?.ok())
        .collect();
    let version = releases
        .iter()
        .map(|(_, version, _)| version)
        .max()
        .ok_or("无法连接到 Gitee 或 GitHub 的发行服务")?;
    if version <= &current {
        return Ok(Outcome::Current);
    }
    let display = format!("v{version}");
    let Some(name) = installer_name(version) else {
        return Ok(Outcome::Unavailable { version: display });
    };
    let folder = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("updates");
    fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
    let destination = folder.join(&name);
    // 双端发布相同的安装包，GitHub 的摘要也可用于校验 Gitee 镜像。
    let github_asset = releases
        .iter()
        .find(|(mirror, candidate, _)| matches!(mirror, Mirror::GitHub) && candidate == version)
        .and_then(|(_, _, release)| {
            release
                .assets
                .iter()
                .find(|asset| asset.name.eq_ignore_ascii_case(&name))
        });
    let mut error = None;
    for (mirror, candidate, release) in &releases {
        if candidate != version {
            continue;
        }
        let Some(asset) = release
            .assets
            .iter()
            .find(|asset| asset.name.eq_ignore_ascii_case(&name))
        else {
            continue;
        };
        let Some(url) = mirror.asset_url(&asset.browser_download_url) else {
            continue;
        };
        let progress = Progress {
            version: display.clone(),
            source: mirror.name(),
            received: 0,
            total: github_asset
                .and_then(|asset| asset.size)
                .or(asset.size)
                .filter(|&size| size != 0),
        };
        let digest = github_asset
            .and_then(expected_hash)
            .or_else(|| expected_hash(asset));
        match fetch_installer(&client, url, digest, &destination, progress, &on_progress).await {
            Ok(()) => {
                return Ok(Outcome::Downloaded {
                    version: display,
                    path: destination.to_string_lossy().into_owned(),
                })
            }
            Err(reason) => error = Some(format!("{}：{reason}", mirror.name())),
        }
    }
    match error {
        Some(error) => Err(error),
        None => Ok(Outcome::Unavailable { version: display }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_accepts_stable_versions_and_repository_https_assets() {
        assert_eq!(stable_version("v0.5.0"), Some(Version::new(0, 5, 0)));
        assert!(stable_version("v0.6.0-rc.1").is_none());
        let mirror = Mirror::GitHub;
        assert!(mirror.asset_url("https://github.com/caoqianming/dotdown/releases/download/v0.5.0/Dotdown_0.5.0_x64-setup.exe").is_some());
        assert!(mirror
            .asset_url("https://github.com/caoqianming/other/releases/download/v0.5.0/a.exe")
            .is_none());
        assert!(mirror
            .asset_url("http://github.com/caoqianming/dotdown/releases/download/a.exe")
            .is_none());
    }

    #[test]
    fn rejects_partial_or_modified_cached_installers() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("setup.exe");
        let bytes = b"MZtest";
        let hash = format!("{:x}", Sha256::digest(bytes));
        fs::write(&path, bytes).unwrap();
        assert!(valid_cached(&path, Some(6), Some(&hash)));
        assert!(!valid_cached(&path, Some(7), Some(&hash)));
        fs::write(&path, b"MZfake").unwrap();
        assert!(!valid_cached(&path, Some(6), Some(&hash)));
    }
}
