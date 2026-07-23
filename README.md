# Magenta CLI

Magenta is an AI coding and research agent.

## 🚀 Installation

> **受限或慢速网络（如中国大陆）？** 先设置镜像加速，再运行安装命令：
>
> macOS / Linux (bash)：
> ```bash
> export MAGENTA_GITHUB_MIRROR=https://ghfast.top
> ```
> Windows (PowerShell)：
> ```powershell
> $env:MAGENTA_GITHUB_MIRROR = "https://ghfast.top"
> ```
> 镜像加速只作用于二进制/资源包下载；版本解析和校验根仍直连 GitHub。若 GitHub 元数据本身不可达（而非仅 payload 下载慢），需先恢复直连访问。

### Release-bound install (recommended)

**macOS / Linux:**

```bash
bootstrap="$(mktemp)"
curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/install.sh -o "$bootstrap"
bash "$bootstrap"
rm -f "$bootstrap"
```

**Windows x64 (PowerShell 5.1 or later):**

```powershell
$ErrorActionPreference = "Stop"
$repo = "Minions-Land/Magenta-CLI"
$release = Invoke-RestMethod "https://api.github.com/repos/Minions-Land/Magenta-CLI/releases/latest"
$tag = [string]$release.tag_name
if ($tag -cnotmatch '^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw "Invalid release tag: $tag" }
$assets = @($release.assets | Where-Object { $_.name -ceq "install.ps1" })
if ($assets.Count -ne 1 -or $assets[0].state -cne "uploaded") { throw "Release has no unique installer" }
$asset = $assets[0]
if ([int64]$asset.size -le 0 -or [int64]$asset.size -gt 16MB) { throw "Installer size is invalid" }
if ([string]$asset.digest -cnotmatch '^sha256:(?<hash>[0-9a-f]{64})$') { throw "Installer digest is invalid" }
$expectedHash = $Matches.hash
$installer = Join-Path ([IO.Path]::GetTempPath()) ("magenta-install-" + [guid]::NewGuid() + ".ps1")
try {
  Invoke-WebRequest -UseBasicParsing "https://github.com/$repo/releases/download/$tag/install.ps1" -OutFile $installer
  if ((Get-Item -LiteralPath $installer).Length -ne [int64]$asset.size) { throw "Installer size mismatch" }
  if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedHash) {
    throw "Installer digest mismatch"
  }
  & $installer -Version $tag
} finally {
  Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
}
```

Unix 下载的是仓库内的最小 bootstrap，而不是执行未绑定版本的安装器 URL。bootstrap 只负责从 GitHub API 解析唯一 latest tag、校验该 tag 的 installer API SHA-256 digest，并把精确 tag 传给正式 installer。Windows 命令执行相同的 tag、唯一资产、大小和 digest 绑定。正式 installer 会自动检测平台架构，下载二进制、资源包和校验清单，并在校验或 staged startup 失败时中止。

仓库根目录的 `install.sh` 只是兼容 bootstrap：它先从 GitHub API 解析唯一的 latest tag，校验该 tag 的 `install.sh` API SHA-256 digest，再执行临时文件。若目标 Release 尚未发布 `install.sh`（例如旧的 v0.0.29），脚本会明确失败，不会回退执行未绑定的脚本。

- **macOS / Linux**：默认安装到 `~/.local/lib/magenta`，再原子更新 `~/.local/bin/magenta` 链接；安装、修复、旧布局迁移和卸载共用事务日志与回滚。macOS 会在执行下载产物前验证固定 Apple Team ID、Developer ID 签名和公证。
- **Windows**：在用户目录中隔离 staging，校验并启动候选后再原子替换，失败时保留旧安装。
- **受限网络**：`MAGENTA_GITHUB_MIRROR` 仅用于二进制和资源 payload；校验清单及版本解析仍直接访问 GitHub。

### Manual download

从 [Releases 页面](https://github.com/Minions-Land/Magenta-CLI/releases) 选择一个精确 tag，并从同一个 tag 下载平台二进制、`magenta-resources-universal.tar.gz` 和 `SHA256SUMS`。`SHA256SUMS` 还覆盖同一 Release 的其他 payload，因此手工下载时只校验已下载的两项：

```bash
tag="<exact-release-tag>"
base="https://github.com/Minions-Land/Magenta-CLI/releases/download/$tag"
asset="magenta-linux-x64" # or magenta-macos-arm64, magenta-macos-x64, or magenta-windows-x64.exe
curl -fL "$base/$asset" -o "$asset"
curl -fL "$base/magenta-resources-universal.tar.gz" -o magenta-resources-universal.tar.gz
curl -fL "$base/SHA256SUMS" -o SHA256SUMS
awk -v target="$asset" '$2 == target || $2 == "magenta-resources-universal.tar.gz"' SHA256SUMS > SHA256SUMS.selected
test "$(wc -l < SHA256SUMS.selected | tr -d " ")" = 2
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c SHA256SUMS.selected
else
  shasum -a 256 -c SHA256SUMS.selected
fi
```

单独下载一个二进制是不完整且不受支持的安装方式。

## 🔄 Update

```bash
magenta --update
```

更新失败？（"Could not fetch latest release" 等）常见原因：
> - **下载慢/受限**：设置镜像后重试 `--update`，或用一键安装脚本重装。bash: `export MAGENTA_GITHUB_MIRROR=https://ghfast.top`；PowerShell: `$env:MAGENTA_GITHUB_MIRROR = "https://ghfast.top"`
> - **API 不可达**：版本元数据始终直连 api.github.com，镜像不会代理元数据；需先打通到 api.github.com 的网络。
> - **API 限流**（HTTP 403，60 次/小时）：等待错误里的重置时间，或设置 `MAGENTA_GITHUB_TOKEN`（公开仓库无需特殊权限）
> - **旧版本断层**：早期版本使用不同的发布格式，无法通过 `--update` 升级到当前的拆分资产格式（二进制 + 资源包 + 校验和），必须用上方的安装脚本重装。

## ✨ Features

- ✅ No GitHub Token required, anonymous downloads
- ✅ Precompiled binaries; no Node.js or package manager required
- ✅ Built-in auto-update
- ✅ 校验和、事务安装、故障回滚和版本化安装器
- ✅ macOS 固定 Developer ID Team、签名和公证验证
- ✅ 可选 payload 镜像加速

## 📦 Supported Platforms

- macOS (Apple Silicon / Intel)
- Linux (x64)
- Windows (x64)

## 🔐 Release verification (maintainers)

The `verify-release` workflow checks releases using the current source-bound
provenance contract before it runs any
downloaded native payload. Because the source repository is private, the
workflow requires a repository secret named `MAGENTA_SOURCE_READ_TOKEN`. Use a
fine-grained token with read-only Contents access to the fixed
`Minions-Land/Magenta` repository. The verifier peels the exact annotated tag
and compares its commit with the release `SOURCE_COMMIT`; a missing token,
unavailable source API, lightweight tag, or mismatch fails closed. The token is
injected only for this check and is removed before installer or native-runtime
execution. End users do not need this token.

## 📖 Documentation

- 受限网络：安装前设置镜像（bash: `export MAGENTA_GITHUB_MIRROR=https://ghfast.top`；PowerShell: `$env:MAGENTA_GITHUB_MIRROR = "https://ghfast.top"`）。镜像仅加速 payload，Release 元数据和校验根仍直连 GitHub。
