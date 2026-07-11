# Magenta CLI

Magenta 是一个 AI 编码与研究智能体。

## 🚀 安装

### 一键安装（推荐，macOS / Linux）

```bash
curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/install.sh | bash
```

脚本会自动检测你的系统和架构，下载对应的二进制。

### 手动下载

**macOS (Apple Silicon)：**
```bash
curl -fsSL https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/magenta-macos-arm64 -o magenta && chmod +x magenta
```

**macOS (Intel)：**
```bash
curl -fsSL https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/magenta-macos-x64 -o magenta && chmod +x magenta
```

**Linux (x64)：**
```bash
curl -fsSL https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/magenta-linux-x64 -o magenta && chmod +x magenta
```

**Windows (x64)：**
```powershell
Invoke-WebRequest -Uri "https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/magenta-windows-x64.exe" -OutFile "magenta.exe"
```

或在 [Releases 页面](https://github.com/Minions-Land/Magenta-CLI/releases/latest) 手动下载。

## 🔄 更新

```bash
magenta --update
```

## ✨ 特性

- ✅ 无需 GitHub Token，匿名下载
- ✅ 单文件二进制，无需安装 Node.js 等依赖
- ✅ 内置自动更新

## 📦 支持平台

- macOS (Apple Silicon / Intel)
- Linux (x64)
- Windows (x64)
