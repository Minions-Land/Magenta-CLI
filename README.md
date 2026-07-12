# Magenta CLI

Magenta is an AI coding and research agent.

## 🚀 Installation

### One-line install (recommended)

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/install.sh | bash
```

The script will automatically detect your system and architecture, then download the appropriate binary.

**Windows x64 (PowerShell 5.1 or later):**

```powershell
irm https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/install.ps1 | iex
```

The Windows installer downloads the executable and required runtime resources, verifies their SHA-256 checksums, and checks startup before replacing an existing installation.

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

Or download manually from the [Releases page](https://github.com/Minions-Land/Magenta-CLI/releases/latest).

## 🔄 Update

```bash
magenta --update
```

## ✨ Features

- ✅ No GitHub Token required, anonymous downloads
- ✅ Precompiled binaries; no Node.js or package manager required
- ✅ Built-in auto-update

## 📦 Supported Platforms

- macOS (Apple Silicon / Intel)
- Linux (x64)
- Windows (x64)
