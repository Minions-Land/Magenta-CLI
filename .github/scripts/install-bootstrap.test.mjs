import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BOOTSTRAP = resolve(REPOSITORY_ROOT, "install.sh");

function runWithoutInstallerAsset(tag) {
	const root = mkdtempSync(join(tmpdir(), "magenta-bootstrap-test-"));
	try {
		const temporaryDirectory = join(root, "tmp");
		const metadataPath = join(root, "release.json");
		const curlLogPath = join(root, "curl.log");
		mkdirSync(temporaryDirectory);
		writeFileSync(metadataPath, `${JSON.stringify({ tag_name: tag, assets: [] }, null, 2)}\n`, "utf8");
		writeFileSync(curlLogPath, "", "utf8");
		const fakeCurlPath = join(root, "fake-curl.sh");
		writeFileSync(
			fakeCurlPath,
			`curl() {
printf '%s\\n' "$*" >> "$FAKE_CURL_LOG"
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    output="$1"
  fi
  shift
done
test -n "$output"
cp "$FAKE_RELEASE_METADATA" "$output"
}
`,
			"utf8",
		);

		const result = spawnSync("bash", [BOOTSTRAP], {
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
			env: {
				...process.env,
				BASH_ENV: fakeCurlPath.replaceAll("\\", "/"),
				FAKE_CURL_LOG: curlLogPath,
				FAKE_RELEASE_METADATA: metadataPath,
				MAGENTA_GITHUB_TOKEN: "",
				TMPDIR: temporaryDirectory,
			},
			timeout: 10_000,
		});
		return { ...result, curlCalls: readFileSync(curlLogPath, "utf8").trim().split("\n").filter(Boolean) };
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}

function runWithInstallerAsset({ compact, buildAssets = (digest) => [
	{
		name: "install.sh",
		digest: `sha256:${digest}`,
		uploader: { name: "nested-decoy", digest: `sha256:${"0".repeat(64)}` },
	},
] }) {
	const root = mkdtempSync(join(tmpdir(), "magenta-bootstrap-test-"));
	try {
		const temporaryDirectory = join(root, "tmp");
		const metadataPath = join(root, "release.json");
		const installerSourcePath = join(root, "install.sh");
		const installerLogPath = join(root, "installer.log");
		const curlLogPath = join(root, "curl.log");
		mkdirSync(temporaryDirectory);
		const installer = `#!/usr/bin/env bash
printf '%s\\n' "$MAGENTA_VERSION" > "$FAKE_INSTALLER_LOG"
if [ "\${MAGENTA_GITHUB_TOKEN+x}" = x ]; then printf 'set\\n' >> "$FAKE_INSTALLER_LOG"; else printf 'unset\\n' >> "$FAKE_INSTALLER_LOG"; fi
printf '%s\\n' "$@" >> "$FAKE_INSTALLER_LOG"
`;
		const digest = createHash("sha256").update(installer).digest("hex");
		const metadata = {
			tag_name: "v0.1.25",
			assets: buildAssets(digest),
		};
		writeFileSync(metadataPath, `${JSON.stringify(metadata, null, compact ? undefined : 2)}\n`, "utf8");
		writeFileSync(installerSourcePath, installer, "utf8");
		writeFileSync(installerLogPath, "", "utf8");
		writeFileSync(curlLogPath, "", "utf8");
		const fakeCurlPath = join(root, "fake-curl.sh");
		writeFileSync(
			fakeCurlPath,
			`curl() {
printf '%s\\n' "$*" >> "$FAKE_CURL_LOG"
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    shift
    output="$1"
  fi
  shift
done
case "$output" in
  */release.json) cp "$FAKE_RELEASE_METADATA" "$output" ;;
  */install.sh) cp "$FAKE_INSTALLER_SOURCE" "$output" ;;
  *) return 1 ;;
esac
}
`,
			"utf8",
		);

		const result = spawnSync("bash", [BOOTSTRAP, "--help"], {
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
			env: {
				...process.env,
				BASH_ENV: fakeCurlPath.replaceAll("\\", "/"),
				FAKE_CURL_LOG: curlLogPath,
				FAKE_INSTALLER_LOG: installerLogPath,
				FAKE_INSTALLER_SOURCE: installerSourcePath,
				FAKE_RELEASE_METADATA: metadataPath,
				MAGENTA_GITHUB_TOKEN: "bootstrap-test-token",
				TMPDIR: temporaryDirectory,
			},
			timeout: 10_000,
		});
		return {
			...result,
			curlCalls: readFileSync(curlLogPath, "utf8").trim().split("\n").filter(Boolean),
			installerLog: readFileSync(installerLogPath, "utf8"),
		};
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
}

test("v0.0.29 fails closed with the fixed-tag manual transition", () => {
	const result = runWithoutInstallerAsset("v0.0.29");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /v0\.0\.29 predates the release-bound Unix installer/u);
	assert.match(result.stderr, /will not execute an unbound fallback/u);
	assert.match(result.stderr, /#unix-v0-0-29-manual-transition/u);
	assert.equal(result.curlCalls.length, 1);
	assert.match(result.curlCalls[0], /releases\/latest/u);
	assert.doesNotMatch(result.curlCalls[0], /releases\/download/u);
});

test("other releases without install.sh retain the generic fail-closed error", () => {
	const result = runWithoutInstallerAsset("v0.1.0");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /does not contain exactly one install\.sh asset; refusing unbound fallback/u);
	assert.doesNotMatch(result.stderr, /v0\.0\.29 predates/u);
	assert.equal(result.curlCalls.length, 1);
	assert.doesNotMatch(result.curlCalls[0], /releases\/download/u);
});

test("accepts GitHub's compact release JSON while binding the direct installer name and digest", () => {
	const result = runWithInstallerAsset({ compact: true });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.curlCalls.length, 2);
	assert.match(result.curlCalls[0], /releases\/latest/u);
	assert.match(result.curlCalls[1], /releases\/download\/v0\.1\.25\/install\.sh/u);
	assert.equal(result.installerLog, "v0.1.25\nunset\n--help\n");
});

test("accepts pretty-printed release JSON and fields in API order", () => {
	const result = runWithInstallerAsset({
		compact: false,
		buildAssets: (digest) => [
			{
				digest: `sha256:${digest}`,
				label: "literal },{ decoy text",
				name: "install.sh",
			},
		],
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.installerLog, "v0.1.25\nunset\n--help\n");
});

test("does not bind nested uploader fields as a release asset", () => {
	const result = runWithInstallerAsset({
		compact: true,
		buildAssets: (digest) => [
			{
				name: "not-the-installer",
				uploader: { name: "install.sh", digest: `sha256:${digest}` },
			},
		],
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /does not contain exactly one install\.sh asset/u);
	assert.equal(result.curlCalls.length, 1);
	assert.equal(result.installerLog, "");
});

test("fails closed when more than one direct asset claims install.sh", () => {
	const result = runWithInstallerAsset({
		compact: true,
		buildAssets: (digest) => [
			{ name: "install.sh", digest: `sha256:${digest}` },
			{ name: "install.sh", digest: `sha256:${digest}` },
		],
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /does not contain exactly one install\.sh asset/u);
	assert.equal(result.curlCalls.length, 1);
	assert.equal(result.installerLog, "");
});
