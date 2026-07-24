import assert from "node:assert/strict";
import test from "node:test";
import { verifyDistributionEntrypoints } from "./verify-distribution-entrypoints.mjs";

const releaseBoundReadme = `
**macOS / Linux (\`v0.1.0+\`):**
curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/install.sh -o "$bootstrap"
bash "$bootstrap"
Invoke-RestMethod "https://api.github.com/repos/Minions-Land/Magenta-CLI/releases/latest"
Invoke-WebRequest "https://github.com/$repo/releases/download/$tag/install.ps1" -OutFile $installer
Get-FileHash $installer
$installer -Version $tag
<a id="unix-v0-0-29-manual-transition"></a>
tag="v0.0.29"
manifest_sha256="f61d38f8d9c7838a77b9e79d3c33d322fc328cb22c713a304614797f5e986d21"
test "$version" = "0.0.29"
`;
const compatibilityInstaller = `
RELEASE_API_ROOT="https://api.github.com/repos/Minions-Land/Magenta-CLI/releases/latest"
DIST_REPO="\${MAGENTA_DIST_REPO:-Minions-Land/Magenta-CLI}"
DIST_OWNER="\${DIST_REPO%%/*}"
DIST_NAME="\${DIST_REPO#*/}"
case "\$DIST_OWNER" in ''|.|..|*[!A-Za-z0-9_.-]*) exit 1 ;; esac
case "\$DIST_NAME" in ''|.|..|*[!A-Za-z0-9_.-]*) exit 1 ;; esac
if [ "\$DIST_REPO" != "\$DIST_OWNER/\$DIST_NAME" ]; then exit 1; fi
LATEST_TAG="v0.1.0"
EXPECTED_DIGEST="${"a".repeat(64)}"
INSTALLER_URL="https://github.com/Minions-Land/Magenta-CLI/releases/download/\${LATEST_TAG}/install.sh"
INSTALLER_PATH="$TMP_DIR/install.sh"
sha256sum "$INSTALLER_PATH"
echo "https://github.com/Minions-Land/Magenta-CLI#unix-v0-0-29-manual-transition"
unset MAGENTA_GITHUB_TOKEN
MAGENTA_VERSION="$LATEST_TAG" bash "$INSTALLER_PATH" "$@"
`;

test("accepts digest-bound Unix and Windows installer documentation", () => {
	assert.doesNotThrow(() =>
		verifyDistributionEntrypoints({ readme: releaseBoundReadme, rootInstaller: compatibilityInstaller }),
	);
});

test("rejects a missing compatibility entrypoint and pipe-to-shell documentation", () => {
	assert.throws(
		() => verifyDistributionEntrypoints({ readme: releaseBoundReadme, rootInstaller: undefined }),
		/compatibility entrypoint is missing/iu,
	);
	assert.throws(
		() =>
			verifyDistributionEntrypoints({
				readme:
					"curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/install.sh | bash\n" +
					releaseBoundReadme,
				rootInstaller: compatibilityInstaller,
			}),
		/reviewable file/iu,
	);
});

test("rejects README commands that execute mutable latest/download assets", () => {
	assert.throws(
		() =>
			verifyDistributionEntrypoints({
				readme: `${releaseBoundReadme}\nhttps://github.com/Minions-Land/Magenta-CLI/releases/latest/download/install.sh`,
				rootInstaller: compatibilityInstaller,
			}),
		/mutable latest\/download/u,
	);
});

test("rejects stale capability claims from the retired installer", () => {
	assert.throws(
		() =>
			verifyDistributionEntrypoints({
				readme: `${releaseBoundReadme}\naria2 parallel download`,
				rootInstaller: compatibilityInstaller,
			}),
		/retired repository-root installer/iu,
	);
});

test("rejects repository-root installation logic instead of a thin Release delegate", () => {
	assert.throws(
		() =>
			verifyDistributionEntrypoints({
				readme: releaseBoundReadme,
				rootInstaller: `${compatibilityInstaller}\ntar -xzf magenta-resources-universal.tar.gz`,
			}),
		/retired installation or asset-selection logic/iu,
	);
});

test("rejects a mutable latest installer URL or a missing digest gate", () => {
	assert.throws(
		() =>
			verifyDistributionEntrypoints({
				readme: releaseBoundReadme,
				rootInstaller: `${compatibilityInstaller}\nhttps://github.com/Minions-Land/Magenta-CLI/releases/latest/download/install.sh`,
			}),
		/mutable latest\/download/u,
	);
	assert.throws(
		() =>
			verifyDistributionEntrypoints({
				readme: releaseBoundReadme,
				rootInstaller: compatibilityInstaller.replace("sha256sum \"$INSTALLER_PATH\"", ""),
			}),
		/digest/u,
	);
	assert.throws(
		() =>
			verifyDistributionEntrypoints({
				readme: releaseBoundReadme,
				rootInstaller: compatibilityInstaller.replace('MAGENTA_VERSION="$LATEST_TAG" ', ""),
			}),
		/resolved tag pinned/u,
	);
});

test("rejects a bootstrap repository parser that accepts extra path segments", () => {
	assert.throws(
		() =>
			verifyDistributionEntrypoints({
				readme: releaseBoundReadme,
				rootInstaller: compatibilityInstaller.replace('if [ "$DIST_REPO" != "$DIST_OWNER/$DIST_NAME" ]; then exit 1; fi', ""),
			}),
		/extra segments/u,
	);
});

test("rejects documentation that presents the bootstrap as valid for v0.0.29", () => {
	assert.throws(
		() =>
			verifyDistributionEntrypoints({
				readme: releaseBoundReadme.replace("**macOS / Linux (`v0.1.0+`):**", "**macOS / Linux:**"),
				rootInstaller: compatibilityInstaller,
			}),
		/v0\.1\.0 and later/iu,
	);
});

test("rejects a missing fixed v0.0.29 transition or bootstrap handoff", () => {
	assert.throws(
		() =>
			verifyDistributionEntrypoints({
				readme: releaseBoundReadme.replace('tag="v0.0.29"', ""),
				rootInstaller: compatibilityInstaller,
			}),
		/fixed v0\.0\.29 Unix transition/iu,
	);
	assert.throws(
		() =>
			verifyDistributionEntrypoints({
				readme: releaseBoundReadme,
				rootInstaller: compatibilityInstaller.replace(
					'echo "https://github.com/Minions-Land/Magenta-CLI#unix-v0-0-29-manual-transition"',
					"",
				),
			}),
		/fixed-tag manual transition/iu,
	);
});
