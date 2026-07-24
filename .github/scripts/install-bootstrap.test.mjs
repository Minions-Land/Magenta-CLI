import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		const binDirectory = join(root, "bin");
		const temporaryDirectory = join(root, "tmp");
		const metadataPath = join(root, "release.json");
		const curlLogPath = join(root, "curl.log");
		mkdirSync(binDirectory);
		mkdirSync(temporaryDirectory);
		writeFileSync(metadataPath, `${JSON.stringify({ tag_name: tag, assets: [] }, null, 2)}\n`, "utf8");
		writeFileSync(curlLogPath, "", "utf8");
		const fakeCurlPath = join(binDirectory, "curl");
		writeFileSync(
			fakeCurlPath,
			`#!/bin/sh
set -eu
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
`,
			"utf8",
		);
		chmodSync(fakeCurlPath, 0o755);

		const result = spawnSync("bash", [BOOTSTRAP], {
			cwd: REPOSITORY_ROOT,
			encoding: "utf8",
			env: {
				...process.env,
				FAKE_CURL_LOG: curlLogPath,
				FAKE_RELEASE_METADATA: metadataPath,
				MAGENTA_GITHUB_TOKEN: "",
				PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
				TMPDIR: temporaryDirectory,
			},
			timeout: 10_000,
		});
		return { ...result, curlCalls: readFileSync(curlLogPath, "utf8").trim().split("\n").filter(Boolean) };
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
