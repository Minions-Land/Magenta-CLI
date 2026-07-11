# Magenta CLI

Magenta 是一个 AI 编码与研究智能体。这个仓库存放编译好的二进制文件，供匿名下载。

> 源代码在私有仓库，此仓库只包含发布产物。

## 🚀 安装

### 一键安装（推荐）

**macOS / Linux：**
```bash
curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/install.sh | bash
```

### 手动下载

**macOS：**
```bash
curl -fsSL https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/magenta-macos -o magenta && chmod +x magenta
```

**Linux：**
```bash
curl -fsSL https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/magenta-linux -o magenta && chmod +x magenta
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

- macOS (Apple Silicon)
- Linux (构建中)
