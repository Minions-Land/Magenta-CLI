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
> 镜像加速作用于二进制/资源包下载；版本元数据始终直连 api.github.com。若 API 本身不可达（而非仅下载慢），需先打通到 api.github.com 的网络。

### One-line install (recommended)

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/install.sh | bash
```

**Windows x64 (PowerShell 5.1 or later):**

```powershell
$installer = Join-Path $env:TEMP "magenta-install.ps1"
Invoke-WebRequest "https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/install.ps1" -OutFile $installer
& $installer
```

安装脚本会自动检测平台架构，下载二进制 + 资源包 + 校验和三件套，并校验 SHA-256 完整性（校验失败则中止）。受限/慢速网络下：

- **macOS / Linux** (`install.sh`)：镜像加速 + 多源自动轮换 + （有 aria2c 时）多连接/并行分片 + 断点续传。
- **Windows** (`install.ps1`)：镜像加速 + 基于 BITS 的断点续传（无并行分片）。

### Manual download

**macOS (Apple Silicon):**
```bash
curl -fsSL https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/magenta-macos-arm64 -o magenta && chmod +x magenta
```

**macOS (Intel):**
```bash
curl -fsSL https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/magenta-macos-x64 -o magenta && chmod +x magenta
```

**Linux (x64):**
```bash
curl -fsSL https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/magenta-linux-x64 -o magenta && chmod +x magenta
```

> ⚠️ 手动下载单个二进制**不完整**！还需要下载 `magenta-resources-universal.tar.gz` 资源包并解压到同目录。推荐用上方的一键安装脚本。

或从 [Releases 页面](https://github.com/Minions-Land/Magenta-CLI/releases/latest) 手动下载。

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
- ✅ 镜像加速 + 多源轮换 + 断点续传（受限网络友好；Unix 额外支持并行分片）

## 📦 Supported Platforms

- macOS (Apple Silicon / Intel)
- Linux (x64)
- Windows (x64)

## 📖 Documentation

- 受限网络：安装前设置镜像（bash: `export MAGENTA_GITHUB_MIRROR=https://ghfast.top`；PowerShell: `$env:MAGENTA_GITHUB_MIRROR = "https://ghfast.top"`）。macOS/Linux 会自动镜像加速、多源轮换、（有 aria2c 时）并行分片和断点续传；Windows 用 BITS 断点续传。
