import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyReleaseWorkflowPolicy } from "./verify-release-workflow-policy.mjs";

const workflowPath = resolve(dirname(fileURLToPath(import.meta.url)), "../workflows/verify-release.yml");
const workflow = readFileSync(workflowPath, "utf8");

test("current release workflow retains the native macOS verification gate", () => {
	assert.equal(verifyReleaseWorkflowPolicy(workflow), true);
});

test("rejects removal or soft failure of the macOS signing job", () => {
	const withoutJob = workflow.replace(/\n  macos-signing:[\s\S]*$/u, "\n");
	assert.throws(() => verifyReleaseWorkflowPolicy(withoutJob), /missing the macos-signing job/u);

	const softFailure = workflow.replace(
		"    runs-on: ${{ matrix.runner }}",
		"    continue-on-error: true\n    runs-on: ${{ matrix.runner }}",
	);
	assert.throws(() => verifyReleaseWorkflowPolicy(softFailure), /must fail closed/u);
	const disabled = workflow.replace(
		"    runs-on: ${{ matrix.runner }}",
		"    if: false\n    runs-on: ${{ matrix.runner }}",
	);
	assert.throws(() => verifyReleaseWorkflowPolicy(disabled), /must fail closed/u);
});

test("rejects an incomplete native macOS matrix or credential-persisting checkout", () => {
	assert.throws(
		() => verifyReleaseWorkflowPolicy(workflow.replace("          - architecture: x64", "          - architecture: arm64")),
		/native Apple Silicon and Intel/u,
	);
	assert.throws(
		() => verifyReleaseWorkflowPolicy(workflow.replace("    runs-on: ${{ matrix.runner }}", "    runs-on: macos-latest")),
		/reviewed native macOS runner matrix/u,
	);
	assert.throws(
		() =>
			verifyReleaseWorkflowPolicy(
				workflow.replaceAll("          persist-credentials: false", "          persist-credentials: true"),
			),
		/persisted credentials disabled/u,
	);
});

test("does not expose the GitHub token to Windows repository tests", () => {
	const jobLevelToken = workflow.replace(
		"    env:\n      RELEASE_TAG: ${{ inputs.release_tag }}",
		"    env:\n      GH_TOKEN: ${{ github.token }}\n      RELEASE_TAG: ${{ inputs.release_tag }}",
	);
	assert.throws(() => verifyReleaseWorkflowPolicy(jobLevelToken), /expose a GitHub token/u);
	assert.throws(
		() =>
			verifyReleaseWorkflowPolicy(
				workflow.replace(
					"    env:\n      RELEASE_TAG: ${{ inputs.release_tag }}",
					"    env:\n      GITHUB_TOKEN: ${{ github.token }}\n      RELEASE_TAG: ${{ inputs.release_tag }}",
				),
			),
		/expose a GitHub token/u,
	);

	const wrongStepToken = workflow.replace(
		"          GH_TOKEN: ${{ github.token }}",
		"          GH_TOKEN: ${{ secrets.MAGENTA_CLI_RELEASE_TOKEN }}",
	);
	assert.throws(() => verifyReleaseWorkflowPolicy(wrongStepToken), /scope GH_TOKEN/u);
});

test("keeps Windows release downloads bounded and asset-ID pinned", () => {
	assert.throws(
		() =>
			verifyReleaseWorkflowPolicy(
				workflow.replace("prepare-release-assets.mjs", "unbounded-release-download.mjs"),
			),
		/bounded asset-ID downloader/u,
	);
	const directDownload = workflow.replace(
		"          try {",
		'          Invoke-WebRequest "https://api.github.com/repos/Minions-Land/Magenta-CLI/releases/assets/1" -OutFile asset\n          try {',
	);
	assert.throws(() => verifyReleaseWorkflowPolicy(directDownload), /must not download unbounded release assets/u);
});

test("keeps repository permissions read-only by default and requires source binding", () => {
	assert.throws(
		() => verifyReleaseWorkflowPolicy(workflow.replace("  contents: read", "  contents: write")),
		/read-only repository permissions/u,
	);
	assert.throws(
		() =>
			verifyReleaseWorkflowPolicy(
				workflow.replace(
					"    permissions:\n      contents: write",
					"    permissions:\n      contents: read",
				),
			),
		/scope draft-release access/u,
	);
	assert.throws(
		() => verifyReleaseWorkflowPolicy(workflow.replace("MAGENTA_SOURCE_READ_TOKEN: ${{ secrets.MAGENTA_SOURCE_READ_TOKEN }}", "MAGENTA_SOURCE_READ_TOKEN: ${{ secrets.OTHER_TOKEN }}")),
		/source tag/u,
	);
});

test("rejects removal of the tracked native verifier invocation", () => {
	assert.throws(
		() =>
			verifyReleaseWorkflowPolicy(
				workflow.replace(
					"node .github/scripts/verify-macos-published-release.mjs",
					"node .github/scripts/verify-macos-signing-receipt.mjs",
				),
			),
		/tracked native macOS release verifier/u,
	);
});
