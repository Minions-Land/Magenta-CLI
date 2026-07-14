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

# 校验数值型配置为正整数，避免 CHUNKS=0 导致并行循环永不前进、
# 或 TIMEOUT/TRIES 非法值导致 curl/循环行为异常。
require_positive_int() {
  local varname="$1" value="$2"
  case "$value" in
    ''|*[!0-9]*)
      echo "❌ $varname 必须是正整数，当前值: '$value'" >&2; exit 1 ;;
  esac
  [ "$value" -ge 1 ] 2>/dev/null || { echo "❌ $varname 必须 ≥ 1，当前值: '$value'" >&2; exit 1; }
}
require_positive_int "MAGENTA_CHUNKS" "$PARALLEL_CHUNKS"
require_positive_int "MAGENTA_TRY_TIMEOUT" "$PER_TRY_TIMEOUT"
require_positive_int "MAGENTA_MAX_TRIES" "$MAX_TRIES"

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

# 从 RELEASE_JSON 提取某资产的 API digest（sha256）。
# RELEASE_JSON 是直连 api.github.com 经 TLS 获取的，所以这个 digest 是可信校验根，
# 比从镜像下载 SHA256SUMS 更安全（镜像无法同时笡改资产和 api.github.com 的元数据）。
asset_digest() {
  local name="$1"
  printf '%s' "$RELEASE_JSON" | tr ',' '\n' | grep -E '"(name|digest)"' \
    | awk -v want="$name" '
        /"name"/ { matched = (index($0, "\"" want "\"") > 0) }
        /"digest"/ {
          if (matched) {
            match($0, /sha256:[0-9a-f]+/);
            if (RSTART > 0) { print substr($0, RSTART + 7, RLENGTH - 7); exit }
          }
        }'
}

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
# 加 -L 以跟随 302 重定向（github.com/releases/download 会 302 到 CDN）
probe_size() {
  local url="$1"
  curl -fsSL -m "$PER_TRY_TIMEOUT" -r 0-0 -D - -o /dev/null "$url" 2>/dev/null \
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

# ---------- aria2c 加速路径 ----------
have_aria2() { [ "${MAGENTA_NO_ARIA2:-0}" != "1" ] && command -v aria2c >/dev/null 2>&1; }

aria2_download() {
  local url="$1" out="$2" dir base tries
  # aria2 max-tries: 限制在合理范围，避免无限卡住（0=无限）
  tries=$(( MAX_TRIES > 10 ? 10 : MAX_TRIES ))
  dir=$(dirname "$out"); base=$(basename "$out")
  aria2c -x16 -s16 -k1M --continue=true --retry-wait=2 --max-tries="$tries" \
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
    curl -fsSL -m "$PER_TRY_TIMEOUT" -r "${rstart}-${end}" -o "${out}.part" "$url" 2>/dev/null || true
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
    curl -fsSL -m "$PER_TRY_TIMEOUT" -C - -o "$out" "$url" 2>/dev/null || true
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

# ---------- 下载单个资产（尝试所有候选，每个候选依次尝试 aria2/并行分片/单流）----------
download_asset() {
  local name="$1" out="$2"
  echo "📥 [$name] 准备下载..."
  build_candidates "$name"

  local url size host attempt=0
  for url in "${CANDIDATES[@]}"; do
    attempt=$(( attempt + 1 ))
    size=$(probe_size "$url" 2>/dev/null || true)
    if [ -z "$size" ] || [ "$size" -le 0 ] 2>/dev/null; then
      echo "   候选 $attempt: 探测失败，跳过" >&2
      continue
    fi
    host=$(printf '%s' "$url" | sed -E 's#^(https?://[^/]+).*#\1#')
    echo "   候选 $attempt: $host  大小: $(( size / 1024 / 1024 ))MB"

    # 1) aria2c
    if have_aria2; then
      echo "   尝试 aria2c 多连接加速..." >&2
      : > "$out"; rm -f "$out"
      if aria2_download "$url" "$out" && [ "$(filesize "$out")" = "$size" ]; then
        return 0
      fi
      echo "   aria2c 未完成" >&2
    fi

    # 2) 并行分片（不设 MAGENTA_NO_PARALLEL 时）
    if [ "${MAGENTA_NO_PARALLEL:-0}" != "1" ]; then
      echo "   尝试并行分片下载..." >&2
      : > "$out"
      if parallel_download "$url" "$size" "$out"; then
        return 0
      fi
      echo "   并行分片未完成" >&2
    fi

    # 3) 单流续传兜底
    echo "   尝试单流断点续传..." >&2
    : > "$out"
    if resume_download "$url" "$out" "$size" "$name"; then
      return 0
    fi
    echo "   ⚠️  候选 $attempt 所有策略失败，尝试下一个候选源..." >&2
  done

  echo "❌ [$name] 所有下载源均不可用。请设置镜像后重试: export MAGENTA_GITHUB_MIRROR=https://ghfast.top" >&2
  exit 1
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
# 优先级：1) API digest（直连 TLS 获取，最可信）  2) 可信来源的 SHA256SUMS
verify_sum() {
  local file="$1" name="$2" want got
  # 优先从 API digest 获取（已通过 TLS 直连 api.github.com，无法被镜像篡改）
  want=$(asset_digest "$name" 2>/dev/null || true)
  if [ -n "$want" ]; then
    echo "   使用 API digest 校验 [$name]..." >&2
  else
    # fallback: 从可信来源获取的 SHA256SUMS
    if [ ! -s "$SUMS_FILE" ]; then
      echo "❌ 无法获取 [$name] 的可信校验和（API digest 不可用且 SHA256SUMS 缺失），安装中止。" >&2
      echo "   受限网络可尝试从 Releases 页面手动下载并核对：" >&2
      echo "   https://github.com/${DIST_REPO}/releases/latest" >&2
      exit 1
    fi
    want=$(grep -E "[[:space:]]${name}\$" "$SUMS_FILE" | awk '{print $1}' | head -1)
    if [ -z "$want" ]; then
      echo "❌ SHA256SUMS 中缺少 [$name] 条目且 API digest 不可用，无法校验完整性，安装中止。" >&2
      exit 1
    fi
    echo "   使用 SHA256SUMS 校验 [$name]..." >&2
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

# ---------- 安装（先 staging 验证，再备份+交换，失败回滚）----------
echo ""
echo "📂 安装到: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

# 1) 解压前先审查 tar 内容，拒绝非常规文件、绝对路径、.. 跳出（防恶意资源包）
# 完整枚举到临时文件（避免 pipefail 下 grep 提前退出使 tar 收 SIGPIPE 而漏判）。
RES_TYPES="$TMP_DIR/res-types"   # tar -tv：含文件类型
RES_NAMES="$TMP_DIR/res-names"   # tar -t ：仅路径名
if ! tar -tvzf "$RES_FILE" > "$RES_TYPES" 2>/dev/null; then
  echo "❌ 资源包格式损坏或不可读，安装中止。" >&2
  exit 1
fi
if ! tar -tzf "$RES_FILE" > "$RES_NAMES" 2>/dev/null; then
  echo "❌ 资源包格式损坏或不可读，安装中止。" >&2
  exit 1
fi
# 只允许 regular file(-) 与 directory(d)；拒绝 symlink/hardlink/device/fifo 等
if grep -qE '^[^-d]' "$RES_TYPES"; then
  echo "❌ 资源包含非常规文件类型（symlink/device 等），拒绝安装。" >&2
  exit 1
fi
# 拒绝绝对路径与任何 '..' 路径段（含尾部 /..）
if grep -qE '^/|(^|/)\.\.(/|$)' "$RES_NAMES"; then
  echo "❌ 资源包含绝对路径或 .. 跳出，拒绝安装。" >&2
  exit 1
fi

# 2) 先在 staging 组装完整布局（二进制 + 资源）并验证，再动现有安装
STAGE_DIR="$TMP_DIR/stage"
mkdir -p "$STAGE_DIR"
if ! tar -xzf "$RES_FILE" -C "$STAGE_DIR" 2>/dev/null; then
  echo "❌ 资源包解压失败，安装中止（现有安装未被触碰）。" >&2
  exit 1
fi
if [ -z "$(ls -A "$STAGE_DIR" 2>/dev/null)" ]; then
  echo "❌ 资源包解压后为空，安装中止（现有安装未被触碰）。" >&2
  exit 1
fi
# 把二进制也放入 staging，形成完整布局
cp "$BIN_FILE" "$STAGE_DIR/magenta" || { echo "❌ 无法写入 staging，安装中止。" >&2; exit 1; }
chmod +x "$STAGE_DIR/magenta"
# 在 staging 验证 binary 可执行且能报告版本（动 live 前发现损坏）
if ! STAGED_VERSION=$("$STAGE_DIR/magenta" --version 2>/dev/null); then
  echo "❌ staged 二进制无法执行（--version 失败），安装中止（现有安装未被触碰）。" >&2
  exit 1
fi
# 验证 staged 版本与目标 tag 一致（防 binary/资源版本错配）
WANT_VERSION="${LATEST_TAG#v}"
STAGED_VERSION_CLEAN=$(printf '%s' "$STAGED_VERSION" | tr -d '[:space:]' | sed -E 's/^v//')
if [ -n "$WANT_VERSION" ] && [ "$STAGED_VERSION_CLEAN" != "$WANT_VERSION" ]; then
  echo "❌ staged 二进制版本 ($STAGED_VERSION_CLEAN) 与目标版本 ($WANT_VERSION) 不符，安装中止。" >&2
  exit 1
fi
# 若资源包含 magenta-release.json，校对其版本与目标一致（binary与资源同版）
if [ -f "$STAGE_DIR/magenta-release.json" ]; then
  RES_VERSION=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$STAGE_DIR/magenta-release.json" | head -1 | sed -E 's/.*"([^"]+)"$/\1/' | sed -E 's/^v//')
  if [ -n "$RES_VERSION" ] && [ -n "$WANT_VERSION" ] && [ "$RES_VERSION" != "$WANT_VERSION" ]; then
    echo "❌ 资源包版本 ($RES_VERSION) 与目标版本 ($WANT_VERSION) 不符，安装中止。" >&2
    exit 1
  fi
fi

# 3) 备份旧二进制（保留 binary 回滚能力）
BACKUP_BIN=""
if [ -f "$INSTALL_DIR/magenta" ]; then
  OLD_VERSION=$("$INSTALL_DIR/magenta" --version 2>/dev/null || echo "unknown")
  echo "📦 备份旧版本: $OLD_VERSION -> magenta.backup"
  BACKUP_BIN="$INSTALL_DIR/magenta.backup"
  mv "$INSTALL_DIR/magenta" "$BACKUP_BIN"
fi

# 4) 安装二进制与资源；二进制失败则回滚旧二进制
# 注：资源为原地拷贝，若在拷贝资源中途失败可能遗留半份资源，不是完全事务；
# 但 staging 已验证 + binary 已可执行，实际失败概率很低。
install_failed() {
  echo "❌ $1，正在回滚二进制..." >&2
  rm -f "$INSTALL_DIR/magenta"
  [ -n "$BACKUP_BIN" ] && [ -f "$BACKUP_BIN" ] && mv "$BACKUP_BIN" "$INSTALL_DIR/magenta"
  exit 1
}

cp "$STAGE_DIR/magenta" "$INSTALL_DIR/magenta" || install_failed "二进制安装失败"
chmod +x "$INSTALL_DIR/magenta" || install_failed "chmod 失败"

echo "📦 安装运行时资源..."
# 从 staging 拷资源到安装目录（排除已单独处理的 magenta 二进制）
for entry in "$STAGE_DIR"/*; do
  [ "$(basename "$entry")" = "magenta" ] && continue
  if ! cp -R "$entry" "$INSTALL_DIR/" 2>/dev/null; then
    install_failed "资源安装失败"
  fi
done

# 5) 成功，清理备份
if [ -n "$BACKUP_BIN" ] && [ -f "$BACKUP_BIN" ]; then
  rm -f "$BACKUP_BIN"
fi

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
