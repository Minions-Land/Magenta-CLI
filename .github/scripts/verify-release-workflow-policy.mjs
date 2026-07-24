#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_PATH = resolve(REPOSITORY_ROOT, ".github/workflows/verify-release.yml");

function readJobBlock(workflow, jobName) {
	const startPattern = new RegExp(`^  ${jobName}:\\s*$`, "mu");
	const match = startPattern.exec(workflow);
	if (!match) throw new Error(`Release verification workflow is missing the ${jobName} job.`);
	const start = match.index;
	const remaining = workflow.slice(start + match[0].length);
	const nextJob = /^  [A-Za-z0-9_-]+:\s*$/mu.exec(remaining);
	return workflow.slice(start, nextJob ? start + match[0].length + nextJob.index : undefined);
}

function requirePattern(content, pattern, message) {
	if (!pattern.test(content)) throw new Error(message);
}

export function verifyReleaseWorkflowPolicy(workflow) {
	requirePattern(
		workflow,
		/^permissions:\s*\n  contents:\s*read\s*$/mu,
		"release verification workflow must default to read-only repository permissions.",
	);
	if (/MAGENTA_SOURCE_READ_TOKEN/u.test(workflow)) {
		throw new Error("release verification must use anonymous public-source verification without a legacy source token.");
	}
	const windowsJob = readJobBlock(workflow, "windows-runtime");
	requirePattern(
		windowsJob,
		/^    permissions:\s*\n      contents:\s*write\s*$/mu,
		"windows-runtime must scope draft-release access to the job that needs it.",
	);
	if (/^      (?:GH_TOKEN|GITHUB_TOKEN):\s*/mu.test(windowsJob)) {
		throw new Error("windows-runtime must not expose a GitHub token to repository verifier tests.");
	}
	requirePattern(
		windowsJob,
		/- name: Verify receipts, installer, and native runtime[\s\S]*?\n        shell: pwsh\s*\n        env:\s*\n          GH_TOKEN:\s*\$\{\{ github\.token \}\}/u,
		"windows-runtime must scope GH_TOKEN to the release-download step.",
	);
	requirePattern(
		windowsJob,
		/prepare-release-assets\.mjs[\s\S]*?Remove-Item Env:GH_TOKEN/u,
		"windows-runtime must use the bounded asset-ID downloader and scrub its release token.",
	);
	if (/Invoke-WebRequest[\s\S]*?releases\/assets/iu.test(windowsJob)) {
		throw new Error("windows-runtime must not download unbounded release assets directly in PowerShell.");
	}
	requirePattern(
		windowsJob,
		/- name: Verify receipts, installer, and native runtime[\s\S]*?node \(Join-Path \$env:GITHUB_WORKSPACE "\.github\/scripts\/verify-source-commit\.mjs"\)[\s\S]*?--repository "Minions-Land\/Magenta"/u,
		"windows-runtime must verify SOURCE_COMMIT against the fixed public source tag before asset execution.",
	);
	const macosJob = readJobBlock(workflow, "macos-signing");
	requirePattern(
		macosJob,
		/^    permissions:\s*\n      contents:\s*write\s*$/mu,
		"macos-signing must scope draft-release access to the job that needs it.",
	);
	requirePattern(
		macosJob,
		/matrix:\s*[\s\S]*?- architecture: arm64\s*\n\s+runner: macos-15\s*[\s\S]*?- architecture: x64\s*\n\s+runner: macos-15-intel/u,
		"macos-signing must verify helpers on native Apple Silicon and Intel runners.",
	);
	requirePattern(
		macosJob,
		/^    runs-on: \$\{\{ matrix\.runner \}\}\s*$/mu,
		"macos-signing must use its reviewed native macOS runner matrix.",
	);
	requirePattern(
		macosJob,
		/^        uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n        with:\n          persist-credentials: false\s*$/mu,
		"macos-signing checkout must be commit-pinned with persisted credentials disabled.",
	);
	requirePattern(
		macosJob,
		/GH_TOKEN:\s*\$\{\{ github\.token \}\}[\s\S]*?node \.github\/scripts\/verify-macos-published-release\.mjs/u,
		"macos-signing must invoke the tracked native macOS release verifier with a scoped release token.",
	);
	for (const argument of ["--allow-draft", "--native-architecture", "--release-dir", "--release-tag", "--repository"]) {
		if (!macosJob.includes(argument)) throw new Error(`macos-signing verifier invocation is missing ${argument}.`);
	}
	if (/continue-on-error:\s*true|^\s+(?:if):\s*(?:false|\$\{\{\s*false\s*\}\})\s*$/imu.test(macosJob)) {
		throw new Error("macos-signing must fail closed.");
	}
	return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 2) throw new Error("verify-release-workflow-policy.mjs does not accept arguments");
	verifyReleaseWorkflowPolicy(readFileSync(WORKFLOW_PATH, "utf8"));
	process.stdout.write("Release workflow retains the native macOS verification gate.\n");
}
