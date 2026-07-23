#!/usr/bin/env bash
set -euo pipefail

# Stable source-owned bootstrap. The maintained installer is a versioned
# Release asset; resolve its exact tag and API-published digest before running
# any downloaded shell code. In particular, never execute latest/download
# directly: the mutable latest pointer is only used to discover the tag.
DIST_REPO="${MAGENTA_DIST_REPO:-Minions-Land/Magenta-CLI}"
case "$DIST_REPO" in
  */*) ;;
  *) echo "Magenta repository must be OWNER/REPOSITORY: $DIST_REPO" >&2; exit 1 ;;
esac
DIST_OWNER="${DIST_REPO%%/*}"
DIST_NAME="${DIST_REPO#*/}"
case "$DIST_OWNER" in
  ''|.|..|*[!A-Za-z0-9_.-]*) echo "Magenta repository owner is invalid: $DIST_OWNER" >&2; exit 1 ;;
esac
case "$DIST_NAME" in
  ''|.|..|*[!A-Za-z0-9_.-]*) echo "Magenta repository name is invalid: $DIST_NAME" >&2; exit 1 ;;
esac
if [ "$DIST_REPO" != "$DIST_OWNER/$DIST_NAME" ]; then
  echo "Magenta repository must contain exactly one slash: $DIST_REPO" >&2
  exit 1
fi

umask 077
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/magenta-bootstrap.XXXXXXXX")
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

API_URL="https://api.github.com/repos/${DIST_REPO}/releases/latest"
API_HEADERS=( -H "Accept: application/vnd.github+json" -H "User-Agent: Magenta-bootstrap" )
if [ -n "${MAGENTA_GITHUB_TOKEN:-}" ]; then
  API_HEADERS+=( -H "Authorization: Bearer ${MAGENTA_GITHUB_TOKEN}" )
fi

METADATA_PATH="$TMP_DIR/release.json"
if ! curl -fsSL --retry 3 --connect-timeout 15 --max-time 60 \
  --speed-time 30 --speed-limit 1024 "${API_HEADERS[@]}" -o "$METADATA_PATH" "$API_URL"; then
  echo "Unable to fetch the latest Magenta Release metadata from api.github.com." >&2
  exit 1
fi

# The API response is trusted JSON from GitHub. Keep the parser deliberately
# narrow: require one exact tag and one exact asset object, then validate every
# value before constructing the tag-bound download URL.
LATEST_TAG=$(sed -E -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"(v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*))".*/\1/p' "$METADATA_PATH" | head -1)
if [ -z "$LATEST_TAG" ]; then
  echo "Latest Magenta Release metadata has no exact semver tag." >&2
  exit 1
fi

asset_digests() {
  local wanted="$1"
  # GitHub's JSON response is pretty-printed with release asset objects at four
  # spaces and their direct fields at six spaces. Nested uploader objects are
  # deliberately ignored, so a similarly named nested field cannot bind the
  # digest to the wrong asset.
  awk -v wanted="$wanted" '
    /^    \{/ { in_asset=1; name=""; digest=""; next }
    in_asset && /^      "name"[[:space:]]*:/ {
      line=$0; sub(/^      "name"[[:space:]]*:[[:space:]]*"/, "", line); sub(/".*$/, "", line); name=line; next
    }
    in_asset && /^      "digest"[[:space:]]*:/ {
      line=$0; sub(/^      "digest"[[:space:]]*:[[:space:]]*"sha256:/, "", line); sub(/".*$/, "", line); digest=line; next
    }
    in_asset && /^    \}/ { if (name == wanted && digest != "") print digest; in_asset=0 }
  ' "$METADATA_PATH"
}

INSTALL_ASSET_COUNT=$(asset_digests install.sh | wc -l | tr -d ' ')
if [ "$INSTALL_ASSET_COUNT" -ne 1 ]; then
  echo "Release ${LATEST_TAG} does not contain exactly one install.sh asset; refusing unbound fallback." >&2
  exit 1
fi
EXPECTED_DIGEST=$(asset_digests install.sh | head -1 | tr '[:upper:]' '[:lower:]')
if ! printf '%s\n' "$EXPECTED_DIGEST" | grep -Eq '^[0-9a-f]{64}$'; then
  echo "Release ${LATEST_TAG} does not publish a valid install.sh SHA-256 digest." >&2
  exit 1
fi

INSTALLER_PATH="$TMP_DIR/install.sh"
INSTALLER_URL="https://github.com/${DIST_REPO}/releases/download/${LATEST_TAG}/install.sh"
if ! curl -fL --retry 3 --connect-timeout 15 --max-time 300 \
  --speed-time 30 --speed-limit 1024 -o "$INSTALLER_PATH" "$INSTALLER_URL"; then
  echo "Unable to download the tag-bound Magenta installer (${LATEST_TAG})." >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_DIGEST=$(sha256sum "$INSTALLER_PATH" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_DIGEST=$(shasum -a 256 "$INSTALLER_PATH" | awk '{print $1}')
else
  echo "Neither sha256sum nor shasum is available; refusing to execute the installer." >&2
  exit 1
fi
if [ "$ACTUAL_DIGEST" != "$EXPECTED_DIGEST" ]; then
  echo "Downloaded Magenta installer digest does not match GitHub Release metadata." >&2
  exit 1
fi

# The token is only an API metadata credential. Never expose it to the
# downloaded installer or to any child process it starts.
unset MAGENTA_GITHUB_TOKEN
MAGENTA_VERSION="$LATEST_TAG" bash "$INSTALLER_PATH" "$@"
