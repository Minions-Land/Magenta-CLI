# Magenta CLI

Magenta is an AI coding and research agent.

## 🚀 Installation

### One-line install (recommended, macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/install.sh | bash
```

The script will automatically detect your system and architecture, then download the appropriate binary.

### Manual download

**macOS (Apple Silicon):**
```bash
curl -fsSL https://github.com/Minions-Land/Magenta/releases/latest/download/magenta-macos-arm64 -o magenta && chmod +x magenta
```

**macOS (Intel):**
```bash
curl -fsSL https://github.com/Minions-Land/Magenta/releases/latest/download/magenta-macos-x64 -o magenta && chmod +x magenta
```

**Linux (x64):**
```bash
curl -fsSL https://github.com/Minions-Land/Magenta/releases/latest/download/magenta-linux-x64 -o magenta && chmod +x magenta
```

**Windows (x64):**
```powershell
Invoke-WebRequest -Uri "https://github.com/Minions-Land/Magenta/releases/latest/download/magenta-windows-x64.exe" -OutFile "magenta.exe"
```

Or download manually from the [Releases page](https://github.com/Minions-Land/Magenta/releases/latest).

## 🔄 Update

```bash
magenta --update
```

## ✨ Features

- ✅ No GitHub Token required, anonymous downloads
- ✅ Single binary, no Node.js or other dependencies needed
- ✅ Built-in auto-update

## 📦 Supported Platforms

- macOS (Apple Silicon / Intel)
- Linux (x64)
- Windows (x64)
