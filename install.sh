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
  # GitHub may serialize the same response as compact or pretty-printed JSON.
  # Parse just the root assets array with POSIX awk so fresh macOS/Linux hosts
  # do not need jq, Python, or Node. Only direct fields of each asset object are
  # considered; nested uploader fields cannot bind a digest to the wrong name.
  awk -v wanted="$wanted" '
    function skip_space(text, position,    limit, character) {
      limit = length(text)
      while (position <= limit) {
        character = substr(text, position, 1)
        if (character !~ /[[:space:]]/) break
        position++
      }
      return position
    }

    function parse_string(text, start,    limit, position, character, value, escaped) {
      JSON_STRING_OK = 0
      JSON_STRING_END = 0
      JSON_STRING_VALUE = ""
      JSON_STRING_ESCAPED = 0
      limit = length(text)
      if (substr(text, start, 1) != "\"") return
      value = ""
      escaped = 0
      for (position = start + 1; position <= limit; position++) {
        character = substr(text, position, 1)
        if (character == "\\") {
          escaped = 1
          position++
          if (position > limit) return
          value = value "\\" substr(text, position, 1)
        } else if (character == "\"") {
          JSON_STRING_OK = 1
          JSON_STRING_END = position
          JSON_STRING_VALUE = value
          JSON_STRING_ESCAPED = escaped
          return
        } else {
          value = value character
        }
      }
    }

    function object_end(text, start,    limit, position, character, depth) {
      limit = length(text)
      depth = 0
      for (position = start; position <= limit; position++) {
        character = substr(text, position, 1)
        if (character == "\"") {
          parse_string(text, position)
          if (!JSON_STRING_OK) return 0
          position = JSON_STRING_END
        } else if (character == "{") {
          depth++
        } else if (character == "}") {
          depth--
          if (depth == 0) return position
          if (depth < 0) return 0
        }
      }
      return 0
    }

    function emit_asset(object,    limit, position, character, object_depth, array_depth, key, key_escaped, next_position, value, value_escaped, name, name_count, digest, digest_count) {
      limit = length(object)
      object_depth = 0
      array_depth = 0
      name = ""
      digest = ""
      name_count = 0
      digest_count = 0
      for (position = 1; position <= limit; position++) {
        character = substr(object, position, 1)
        if (character == "\"") {
          parse_string(object, position)
          if (!JSON_STRING_OK) return 0
          key = JSON_STRING_VALUE
          key_escaped = JSON_STRING_ESCAPED
          next_position = skip_space(object, JSON_STRING_END + 1)
          if (object_depth == 1 && array_depth == 0 && !key_escaped && substr(object, next_position, 1) == ":") {
            next_position = skip_space(object, next_position + 1)
            if (substr(object, next_position, 1) == "\"") {
              parse_string(object, next_position)
              if (!JSON_STRING_OK) return 0
              value = JSON_STRING_VALUE
              value_escaped = JSON_STRING_ESCAPED
              if (!value_escaped && key == "name") {
                name = value
                name_count++
              } else if (!value_escaped && key == "digest") {
                digest = value
                digest_count++
              }
              position = JSON_STRING_END
            } else {
              position = next_position - 1
            }
          } else {
            position = JSON_STRING_END
          }
        } else if (character == "{") {
          object_depth++
        } else if (character == "}") {
          object_depth--
          if (object_depth < 0) return 0
        } else if (character == "[") {
          array_depth++
        } else if (character == "]") {
          array_depth--
          if (array_depth < 0) return 0
        }
      }
      if (object_depth != 0 || array_depth != 0) return 0
      if (name_count == 1 && digest_count == 1 && name == wanted) {
        sub(/^sha256:/, "", digest)
        print digest
      }
      return 1
    }

    function parse_assets(text, start,    limit, position, character, finish, object) {
      limit = length(text)
      position = skip_space(text, start + 1)
      if (substr(text, position, 1) == "]") {
        ASSETS_END = position
        return 1
      }
      while (position <= limit) {
        if (substr(text, position, 1) != "{") return 0
        finish = object_end(text, position)
        if (finish == 0) return 0
        object = substr(text, position, finish - position + 1)
        if (!emit_asset(object)) return 0
        position = skip_space(text, finish + 1)
        character = substr(text, position, 1)
        if (character == ",") {
          position = skip_space(text, position + 1)
        } else if (character == "]") {
          ASSETS_END = position
          return 1
        } else {
          return 0
        }
      }
      return 0
    }

    { json = json $0 "\n" }

    END {
      limit = length(json)
      object_depth = 0
      array_depth = 0
      assets_count = 0
      failed = 0
      for (position = 1; position <= limit; position++) {
        character = substr(json, position, 1)
        if (character == "\"") {
          parse_string(json, position)
          if (!JSON_STRING_OK) {
            failed = 1
            break
          }
          key = JSON_STRING_VALUE
          key_escaped = JSON_STRING_ESCAPED
          next_position = skip_space(json, JSON_STRING_END + 1)
          if (object_depth == 1 && array_depth == 0 && !key_escaped && key == "assets" && substr(json, next_position, 1) == ":") {
            next_position = skip_space(json, next_position + 1)
            if (substr(json, next_position, 1) != "[") {
              failed = 1
              break
            }
            assets_count++
            if (!parse_assets(json, next_position)) {
              failed = 1
              break
            }
            position = ASSETS_END
          } else {
            position = JSON_STRING_END
          }
        } else if (character == "{") {
          object_depth++
        } else if (character == "}") {
          object_depth--
          if (object_depth < 0) {
            failed = 1
            break
          }
        } else if (character == "[") {
          array_depth++
        } else if (character == "]") {
          array_depth--
          if (array_depth < 0) {
            failed = 1
            break
          }
        }
      }
      if (failed || object_depth != 0 || array_depth != 0 || assets_count != 1) exit 2
    }
  ' "$METADATA_PATH"
}

INSTALL_ASSET_COUNT=$(asset_digests install.sh | wc -l | tr -d ' ')
if [ "$INSTALL_ASSET_COUNT" -ne 1 ]; then
  if [ "$LATEST_TAG" = "v0.0.29" ]; then
    echo "Release v0.0.29 predates the release-bound Unix installer." >&2
    echo "This bootstrap will not execute an unbound fallback." >&2
    echo "Use the fixed-tag manual Unix procedure at https://github.com/${DIST_REPO}#unix-v0-0-29-manual-transition" >&2
  else
    echo "Release ${LATEST_TAG} does not contain exactly one install.sh asset; refusing unbound fallback." >&2
  fi
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
