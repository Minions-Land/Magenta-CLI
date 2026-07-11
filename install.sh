#!/usr/bin/env bash
set -e

# 一键安装 Magenta - 从公开仓库匿名下载，无需 GitHub Token
# 用法:
#   curl -fsSL https://github.com/Minions-Land/Magenta-CLI/releases/latest/download/install.sh | bash
# 或:
#   curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/install.sh | bash

DIST_REPO="${MAGENTA_DIST_REPO:-Minions-Land/Magenta-CLI}"
INSTALL_DIR="${HOME}/.local/bin"

echo "📦 安装 Magenta..."
echo ""

# 检测平台
PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$PLATFORM" in
  darwin)
    case "$ARCH" in
      arm64|aarch64) BINARY_NAME="magenta-macos-arm64" ;;
      x86_64|amd64)  BINARY_NAME="magenta-macos-x64" ;;
      *) echo "❌ 不支持的 macOS 架构: $ARCH"; exit 1 ;;
    esac
    ;;
  linux)
    case "$ARCH" in
      x86_64|amd64) BINARY_NAME="magenta-linux-x64" ;;
      *) echo "❌ 不支持的 Linux 架构: $ARCH (目前仅支持 x64)"; exit 1 ;;
    esac
    ;;
  *) echo "❌ 不支持的平台: $PLATFORM (Windows 请用 PowerShell 下载 magenta-windows-x64.exe)"; exit 1 ;;
esac

echo "🔍 检测平台: $PLATFORM ($ARCH)"
echo "📥 从公开仓库下载最新版本 (~73MB)..."
echo ""

DOWNLOAD_URL="https://github.com/${DIST_REPO}/releases/latest/download/${BINARY_NAME}"

# 创建临时目录
TMP_DIR=$(mktemp -d)
TMP_FILE="$TMP_DIR/magenta"

# 匿名下载二进制（公开仓库无需认证）
if ! curl -fsSL -o "$TMP_FILE" "$DOWNLOAD_URL"; then
  echo "❌ 下载失败"
  echo "请检查网络，或确认 ${DIST_REPO} 已发布 ${BINARY_NAME}"
  rm -rf "$TMP_DIR"
  exit 1
fi

# 验证下载大小
FILE_SIZE=$(stat -f%z "$TMP_FILE" 2>/dev/null || stat -c%s "$TMP_FILE" 2>/dev/null)
if [ "$FILE_SIZE" -lt 1000000 ]; then
  echo "❌ 下载的文件太小 ($FILE_SIZE bytes)，可能下载失败"
  rm -rf "$TMP_DIR"
  exit 1
fi

echo "✅ 下载完成"
echo ""

# 安装
echo "📂 安装到: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

# 备份旧版本
if [ -f "$INSTALL_DIR/magenta" ]; then
  OLD_VERSION=$("$INSTALL_DIR/magenta" --version 2>/dev/null || echo "unknown")
  echo "📦 备份旧版本: $OLD_VERSION"
  mv "$INSTALL_DIR/magenta" "$INSTALL_DIR/magenta.backup"
fi

mv "$TMP_FILE" "$INSTALL_DIR/magenta"
chmod +x "$INSTALL_DIR/magenta"
rm -rf "$TMP_DIR"

echo "✅ 安装成功！"
echo ""

INSTALLED_VERSION=$("$INSTALL_DIR/magenta" --version 2>/dev/null || echo "unknown")
echo "🎉 Magenta $INSTALLED_VERSION 已就绪！"
echo ""

# 检查 PATH
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  echo "⚠️  $INSTALL_DIR 不在 PATH 中"
  echo ""
  if [ -n "$ZSH_VERSION" ]; then
    SHELL_CONFIG="~/.zshrc"
  elif [ -n "$BASH_VERSION" ]; then
    SHELL_CONFIG="~/.bashrc"
  else
    SHELL_CONFIG="~/.profile"
  fi
  echo "添加到 PATH:"
  echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> $SHELL_CONFIG"
  echo "  source $SHELL_CONFIG"
  echo ""
  echo "或者直接运行: $INSTALL_DIR/magenta"
else
  echo "快速开始:"
  echo "  magenta --help       # 查看帮助"
  echo "  magenta --update     # 检查更新"
  echo "  magenta              # 启动对话"
fi
