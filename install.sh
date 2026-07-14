#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# 一键安装 Magenta - 从公开仓库匿名下载，无需 GitHub Token
#
#   curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/install.sh | bash
#
# 受限/慢速网络（如中国大陆）强烈建议先设镜像，安装会走镜像加速：
#   export MAGENTA_GITHUB_MIRROR=https://ghfast.top
#   curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/install.sh | bash
#
# 可选环境变量:
#   MAGENTA_GITHUB_MIRROR  GitHub 下载镜像前缀 (受限网络首选，见文档)
#   MAGENTA_DIST_REPO      分发仓库 (默认 Minions-Land/Magenta-CLI)
#   MAGENTA_INSTALL_DIR    安装目录 (默认 ~/.local/bin)
#   MAGENTA_GITHUB_TOKEN   GitHub token (API 限流 403 时使用)
#   MAGENTA_CHUNKS         并行分片数 (默认 8)
#   MAGENTA_NO_PARALLEL    设为 1 强制单流下载
#   MAGENTA_NO_ARIA2       设为 1 禁用 aria2c 加速
# ============================================================================

DIST_REPO="${MAGENTA_DIST_REPO:-Minions-Land/Magenta-CLI}"
INSTALL_DIR="${MAGENTA_INSTALL_DIR:-${HOME}/.local/bin}"
PARALLEL_CHUNKS="${MAGENTA_CHUNKS:-8}"
CHUNK_SIZE=$((8 * 1024 * 1024))          # 8MB 每片
PER_TRY_TIMEOUT="${MAGENTA_TRY_TIMEOUT:-30}"
MAX_TRIES="${MAGENTA_MAX_TRIES:-40}"

# 内置镜像候选（用户可用 MAGENTA_GITHUB_MIRROR 覆盖为首选）。镜像会失效，脚本自动逐个尝试。
BUILTIN_MIRRORS=(
  "https://ghfast.top"
  "https://ghproxy.net"
  "https://gh.ddlc.top"
  "https://github.moeyy.xyz"
)

echo "📦 安装 Magenta..."
echo ""

# ---------- 平台检测 ----------
PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$PLATFORM" in
  darwin)
    case "$ARCH" in
      arm64|aarch64) BINARY_NAME="magenta-macos-arm64" ;;
      x86_64|amd64)  BINARY_NAME="magenta-macos-x64" ;;
      *) echo "❌ 不支持的 macOS 架构: $ARCH"; exit 1 ;;
    esac ;;
  linux)
    case "$ARCH" in
      x86_64|amd64) BINARY_NAME="magenta-linux-x64" ;;
      *) echo "❌ 不支持的 Linux 架构: $ARCH (目前仅支持 x64)"; exit 1 ;;
    esac ;;
  *) echo "❌ 不支持的平台: $PLATFORM (Windows 请用 PowerShell 运行 install.ps1)"; exit 1 ;;
esac

RESOURCES_NAME="magenta-resources-universal.tar.gz"
API_BASE="https://api.github.com/repos/${DIST_REPO}"

echo "🔍 检测平台: $PLATFORM ($ARCH)"

# ---------- 工具函数 ----------
filesize() { stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || echo 0; }

curl_api() {
  # 带可选 token 的 API 请求
  local url="$1"
  if [ -n "${MAGENTA_GITHUB_TOKEN:-}" ]; then
    curl -fsSL -m "$PER_TRY_TIMEOUT" -H "Authorization: Bearer ${MAGENTA_GITHUB_TOKEN}" "$url"
  else
    curl -fsSL -m "$PER_TRY_TIMEOUT" "$url"
  fi
}

# ---------- 获取 release 元数据（API 请求小，一般即使慢速网络也可达）----------
echo "📡 查询最新版本..."
RELEASE_JSON=""
if RELEASE_JSON=$(curl_api "${API_BASE}/releases/latest" 2>/dev/null) && [ -n "$RELEASE_JSON" ]; then
  :
else
  echo "❌ 无法访问 GitHub API 获取版本信息。"
  echo "   请先自检可达性:  curl -I -m 20 ${API_BASE}/releases/latest"
  echo "   - 不可达 → 设置镜像:   export MAGENTA_GITHUB_MIRROR=https://ghfast.top"
  echo "   - 返回 403 限流 → 设置: export MAGENTA_GITHUB_TOKEN=<你的 token>"
  exit 1
fi

LATEST_TAG=$(printf '%s' "$RELEASE_JSON" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')
[ -n "$LATEST_TAG" ] || { echo "❌ 未能解析版本号"; exit 1; }
echo "📦 最新版本: $LATEST_TAG"

DL_PATH="${DIST_REPO}/releases/download/${LATEST_TAG}"
DIRECT_BASE="https://github.com/${DL_PATH}"

# 从 release JSON 解析某资产的 API url（走 api.github.com asset 端点，可拿签名 CDN 直链）
asset_api_url() {
  local name="$1"
  printf '%s' "$RELEASE_JSON" | tr ',' '\n' | grep -E '"(url|name)"' \
    | awk -v want="$name" '
        /"url".*\/releases\/assets\// {
          match($0, /https:\/\/api\.github\.com\/repos\/[^"]+\/releases\/assets\/[0-9]+/);
          url = substr($0, RSTART, RLENGTH);
        }
        /"name"/ { if (index($0, "\"" want "\"") > 0) { print url; exit } }'
}

# 解析 asset API url 的第一跳 302 签名 CDN 直链（不加 -L，用 -D - 取 location，去掉 \r）
resolve_cdn_url() {
  local api_url="$1" hdr=()
  [ -n "${MAGENTA_GITHUB_TOKEN:-}" ] && hdr=(-H "Authorization: Bearer ${MAGENTA_GITHUB_TOKEN}")
  curl -fsS -m "$PER_TRY_TIMEOUT" -D - -o /dev/null \
    "${hdr[@]}" -H "Accept: application/octet-stream" "$api_url" 2>/dev/null \
    | grep -i '^location:' | head -1 | awk '{print $2}' | tr -d '\r'
}

# 用带 Range 的请求探测某 URL 的资产总大小(content-range)，顺带验证该 URL 可用且支持分片
probe_size() {
  local url="$1"
  curl -fsS -m "$PER_TRY_TIMEOUT" -r 0-0 -D - -o /dev/null "$url" 2>/dev/null \
    | grep -i '^content-range:' | sed -E 's#.*/([0-9]+).*#\1#' | tr -d '\r' | head -1
}

# 为某资产按优先级生成候选下载 base URL 列表:
#   1) 用户指定镜像  2) 内置镜像  3) 直连 github.com  4) API 签名 CDN 直链
# 输出到全局数组 CANDIDATES
build_candidates() {
  local name="$1"
  CANDIDATES=()
  local direct="https://github.com/${DL_PATH}/${name}"
  if [ -n "${MAGENTA_GITHUB_MIRROR:-}" ]; then
    CANDIDATES+=("${MAGENTA_GITHUB_MIRROR%/}/${direct}")
  fi
  local m
  for m in "${BUILTIN_MIRRORS[@]}"; do
    CANDIDATES+=("${m%/}/${direct}")
  done
  CANDIDATES+=("$direct")
  local cdn
  cdn=$(resolve_cdn_url "$(asset_api_url "$name")" 2>/dev/null || true)
  [ -n "$cdn" ] && CANDIDATES+=("$cdn")
  return 0
}

# 从候选里挑第一个能在超时内返回 size 的 URL。输出: "url<TAB>size"
select_source() {
  local url size
  for url in "${CANDIDATES[@]}"; do
    size=$(probe_size "$url" 2>/dev/null || true)
    if [ -n "$size" ] && [ "$size" -gt 0 ] 2>/dev/null; then
      printf '%s\t%s\n' "$url" "$size"
      return 0
    fi
  done
  return 1
}

# ---------- aria2c 加速路径 ----------
have_aria2() { [ "${MAGENTA_NO_ARIA2:-0}" != "1" ] && command -v aria2c >/dev/null 2>&1; }

aria2_download() {
  local url="$1" out="$2" dir base
  dir=$(dirname "$out"); base=$(basename "$out")
  aria2c -x16 -s16 -k1M --continue=true --retry-wait=2 --max-tries=0 \
    --timeout="$PER_TRY_TIMEOUT" --connect-timeout=15 --summary-interval=0 \
    --console-log-level=warn -d "$dir" -o "$base" "$url" >&2
}

# ---------- 单个分片下载（带续传：每次超时也保留已下字节）----------
download_chunk() {
  local url="$1" start="$2" end="$3" out="$4"
  local want=$(( end - start + 1 )) try=0 have
  : > "$out"
  while :; do
    have=$(filesize "$out")
    [ "$have" -ge "$want" ] && return 0
    try=$(( try + 1 ))
    [ "$try" -gt "$MAX_TRIES" ] && return 1
    local rstart=$(( start + have ))
    curl -fsS -m "$PER_TRY_TIMEOUT" -r "${rstart}-${end}" -o "${out}.part" "$url" 2>/dev/null || true
    [ -s "${out}.part" ] && cat "${out}.part" >> "$out"
    rm -f "${out}.part"
  done
}

# ---------- 并行 Range 分片下载 ----------
parallel_download() {
  local url="$1" size="$2" out="$3"
  local nchunks i start end pids=() ok=1
  nchunks=$(( (size + CHUNK_SIZE - 1) / CHUNK_SIZE ))
  local cdir="$TMP_DIR/chunks"; rm -rf "$cdir"; mkdir -p "$cdir"
  i=0
  while [ "$i" -lt "$nchunks" ]; do
    pids=(); local batch=0
    while [ "$batch" -lt "$PARALLEL_CHUNKS" ] && [ "$i" -lt "$nchunks" ]; do
      start=$(( i * CHUNK_SIZE )); end=$(( start + CHUNK_SIZE - 1 ))
      [ "$end" -ge "$size" ] && end=$(( size - 1 ))
      download_chunk "$url" "$start" "$end" "${cdir}/part_$(printf '%05d' "$i")" &
      pids+=($!); i=$(( i + 1 )); batch=$(( batch + 1 ))
    done
    for p in "${pids[@]}"; do wait "$p" || ok=0; done
    printf '\r  分片进度: %d/%d   ' "$i" "$nchunks" >&2
    [ "$ok" -eq 1 ] || { printf '\n' >&2; return 1; }
  done
  printf '\n' >&2
  cat "${cdir}"/part_* > "$out"; rm -rf "$cdir"
  [ "$(filesize "$out")" = "$size" ]
}

# ---------- 单流断点续传兜底 ----------
resume_download() {
  local url="$1" out="$2" target="$3" name="$4" try=0 have prev
  while :; do
    have=$(filesize "$out")
    [ -n "$target" ] && [ "$target" -gt 0 ] 2>/dev/null && [ "$have" -ge "$target" ] && return 0
    try=$(( try + 1 )); [ "$try" -gt "$MAX_TRIES" ] && { echo "" >&2; return 1; }
    prev=$have
    curl -fsS -m "$PER_TRY_TIMEOUT" -C - -o "$out" "$url" 2>/dev/null || true
    have=$(filesize "$out")
    if [ -n "$target" ] && [ "$target" -gt 0 ] 2>/dev/null; then
      printf '\r  [%s] %d/%d bytes (第%d次续传)   ' "$name" "$have" "$target" "$try" >&2
      [ "$have" -ge "$target" ] && { printf '\n' >&2; return 0; }
    else
      printf '\r  [%s] %d bytes (第%d次)   ' "$name" "$have" "$try" >&2
      [ "$have" = "$prev" ] && [ "$have" -gt 0 ] && { printf '\n' >&2; return 0; }
    fi
  done
}

# ---------- 下载单个资产（组合上述策略）----------
download_asset() {
  local name="$1" out="$2"
  echo "📥 [$name] 准备下载..."
  build_candidates "$name"
  local sel url size
  if sel=$(select_source); then
    url="${sel%%$'\t'*}"; size="${sel##*$'\t'}"
    local host; host=$(printf '%s' "$url" | sed -E 's#^(https?://[^/]+).*#\1#')
    echo "   源: $host  大小: $(( size / 1024 / 1024 ))MB"
  else
    echo "❌ [$name] 所有下载源均不可用。请设置镜像后重试: export MAGENTA_GITHUB_MIRROR=https://ghfast.top"
    exit 1
  fi

  # 1) aria2c
  if have_aria2; then
    echo "   使用 aria2c 多连接加速..."
    : > "$out"; rm -f "$out"
    if aria2_download "$url" "$out" && [ "$(filesize "$out")" = "$size" ]; then
      return 0
    fi
    echo "⚠️  aria2c 未完成，改用并行分片..." >&2
  fi

  # 2) 并行分片（不设 MAGENTA_NO_PARALLEL 时）
  if [ "${MAGENTA_NO_PARALLEL:-0}" != "1" ]; then
    : > "$out"
    if parallel_download "$url" "$size" "$out"; then
      return 0
    fi
    echo "⚠️  分片下载未完成，改用单流断点续传..." >&2
  fi

  # 3) 单流续传兜底
  : > "$out"
  resume_download "$url" "$out" "$size" "$name"
}

# ---------- 执行 ----------
TMP_DIR=$(mktemp -d)
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

BIN_FILE="$TMP_DIR/magenta"
RES_FILE="$TMP_DIR/$RESOURCES_NAME"
SUMS_FILE="$TMP_DIR/SHA256SUMS"

download_asset "$BINARY_NAME" "$BIN_FILE"
download_asset "$RESOURCES_NAME" "$RES_FILE"

# SHA256SUMS 是信任根：必须来自可信来源，绝不走第三方镜像。
# 否则镜像可同时替换资产和校验文件，使校验形同虚设。
# 优先级：直连 github.com → API 签名 CDN 直链（都不经镜像）。
build_trusted_sums_candidates() {
  local name="SHA256SUMS"
  CANDIDATES=()
  CANDIDATES+=("https://github.com/${DL_PATH}/${name}")
  local cdn
  cdn=$(resolve_cdn_url "$(asset_api_url "$name")" 2>/dev/null || true)
  [ -n "$cdn" ] && CANDIDATES+=("$cdn")
  return 0
}

# SHA256SUMS 很小：只从可信来源（直连/API CDN）获取，不走镜像
build_trusted_sums_candidates
for u in "${CANDIDATES[@]}"; do
  if curl -fsSL -m "$PER_TRY_TIMEOUT" -o "$SUMS_FILE" "$u" 2>/dev/null && [ -s "$SUMS_FILE" ]; then break; fi
done

# ---------- 校验（fail-closed：拿不到有效校验就中止，绝不跳过）----------
verify_sum() {
  local file="$1" name="$2" want got
  if [ ! -s "$SUMS_FILE" ]; then
    echo "❌ 无法从可信来源获取 SHA256SUMS，无法校验 [$name] 完整性，安装中止。" >&2
    echo "   受限网络请设置镜像后重试，或从 Releases 页面手动下载并核对校验和：" >&2
    echo "   https://github.com/${DIST_REPO}/releases/latest" >&2
    exit 1
  fi
  want=$(grep -E "[[:space:]]${name}\$" "$SUMS_FILE" | awk '{print $1}' | head -1)
  if [ -z "$want" ]; then
    echo "❌ SHA256SUMS 中缺少 [$name] 条目，无法校验完整性，安装中止。" >&2
    exit 1
  fi
  if command -v shasum >/dev/null 2>&1; then got=$(shasum -a 256 "$file" | awk '{print $1}')
  else got=$(sha256sum "$file" | awk '{print $1}'); fi
  if [ "$got" != "$want" ]; then
    echo "❌ [$name] 校验失败: 期望 $want 实际 $got"
    echo "   （若你是从早期版本升级，请直接用本安装脚本重装。）"
    exit 1
  fi
  echo "✅ [$name] 校验通过"
}

verify_sum "$BIN_FILE" "$BINARY_NAME"
verify_sum "$RES_FILE" "$RESOURCES_NAME"

FILE_SIZE=$(filesize "$BIN_FILE")
if [ "$FILE_SIZE" -lt 1000000 ]; then
  echo "❌ 下载的二进制太小 ($FILE_SIZE bytes)，安装中止"
  exit 1
fi

# ---------- 安装 ----------
echo ""
echo "📂 安装到: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
if [ -f "$INSTALL_DIR/magenta" ]; then
  OLD_VERSION=$("$INSTALL_DIR/magenta" --version 2>/dev/null || echo "unknown")
  echo "📦 备份旧版本: $OLD_VERSION -> magenta.backup"
  mv "$INSTALL_DIR/magenta" "$INSTALL_DIR/magenta.backup"
fi
mv "$BIN_FILE" "$INSTALL_DIR/magenta"
chmod +x "$INSTALL_DIR/magenta"

echo "📦 安装运行时资源..."
tar -xzf "$RES_FILE" -C "$INSTALL_DIR/" || { echo "❌ 资源包解压失败"; exit 1; }

echo "✅ 安装成功！"
echo ""
INSTALLED_VERSION=$("$INSTALL_DIR/magenta" --version 2>/dev/null || echo "unknown")
echo "🎉 Magenta $INSTALLED_VERSION 已就绪！"
echo ""

# ---------- PATH 检查 ----------
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  echo "⚠️  $INSTALL_DIR 不在 PATH 中"
  if [ -n "${ZSH_VERSION:-}" ]; then SHELL_CONFIG="~/.zshrc"
  elif [ -n "${BASH_VERSION:-}" ]; then SHELL_CONFIG="~/.bashrc"
  else SHELL_CONFIG="~/.profile"; fi
  echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> $SHELL_CONFIG && source $SHELL_CONFIG"
  echo "  或直接运行: $INSTALL_DIR/magenta"
else
  echo "快速开始:"
  echo "  magenta --help       # 查看帮助"
  echo "  magenta --update     # 检查更新"
  echo "  magenta              # 启动对话"
fi
