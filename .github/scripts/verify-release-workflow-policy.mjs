#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_PATH = resolve(REPOSITORY_ROOT, ".github/workflows/verify-release.yml");
const SOURCE_SECRET_ACCESS_PATTERN =
	/\$\{\{\s*secrets\s*(?:\.\s*MAGENTA_SOURCE_READ_TOKEN|\[\s*["']MAGENTA_SOURCE_READ_TOKEN["']\s*\])\s*\}\}/gmu;
const SOURCE_TOKEN_ENV_DECLARATION_PATTERN = /^[ \t]+MAGENTA_SOURCE_READ_TOKEN\s*:/gmu;

function readJobBlock(workflow, jobName) {
	const startPattern = new RegExp(`^  ${jobName}:\\s*$`, "mu");
	const match = startPattern.exec(workflow);
	if (!match) throw new Error(`Release verification workflow is missing the ${jobName} job.`);
	const start = match.index;
	const remaining = workflow.slice(start + match[0].length);
	const nextJob = /^  [A-Za-z0-9_-]+:\s*$/mu.exec(remaining);
	return workflow.slice(start, nextJob ? start + match[0].length + nextJob.index : undefined);
}

function escapeRegularExpression(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function readNamedStepBlock(job, stepName, jobName) {
	const startPattern = new RegExp(`^      - name: ${escapeRegularExpression(stepName)}\\s*$`, "mu");
	const match = startPattern.exec(job);
	if (!match) throw new Error(`${jobName} is missing the ${stepName} step.`);
	const start = match.index;
	const remaining = job.slice(start + match[0].length);
	const nextStep = /^      - (?:name|uses):/mu.exec(remaining);
	return job.slice(start, nextStep ? start + match[0].length + nextStep.index : undefined);
}

function matchCount(content, pattern) {
	return content.match(pattern)?.length ?? 0;
}

function requireExclusiveSourceTokenStep(job, stepName, jobName) {
	const step = readNamedStepBlock(job, stepName, jobName);
	const exactDeclaration =
		/^          MAGENTA_SOURCE_READ_TOKEN:\s*\$\{\{\s*secrets\.MAGENTA_SOURCE_READ_TOKEN\s*\}\}\s*$/gmu;
	if (
		matchCount(job, SOURCE_SECRET_ACCESS_PATTERN) !== 1 ||
		matchCount(job, SOURCE_TOKEN_ENV_DECLARATION_PATTERN) !== 1 ||
		matchCount(step, exactDeclaration) !== 1
	) {
		throw new Error(`${jobName} must inject MAGENTA_SOURCE_READ_TOKEN exactly once and only in the ${stepName} step.`);
	}
	return step;
}

function requirePattern(content, pattern, message) {
	if (!pattern.test(content)) throw new Error(message);
}

export function verifyReleaseWorkflowPolicy(input) {
	const workflow = input.replace(/\r\n?/gu, "\n");
	requirePattern(
		workflow,
		/^permissions:\s*\n  contents:\s*read\s*$/mu,
		"release verification workflow must default to read-only repository permissions.",
	);
	if (/macos-signing-receipt|Developer ID signing|notarization/iu.test(workflow)) {
		throw new Error("release verification must not require the retired Apple signing contract.");
	}
	requirePattern(
		workflow,
		/\$requiresNineAssetContract = \(\[Version\]\$version -ge \[Version\]"0\.0\.30"\)/u,
		"release verification must start the current nine-asset contract at v0.0.30.",
	);
	requirePattern(
		workflow,
		/\$isLegacyEightAssetContract = \$tag -ceq "v0\.0\.27" -or \$tag -ceq "v0\.0\.29"[\s\S]*?if \(-not \$isLegacyEightAssetContract -and -not \$requiresNineAssetContract\) \{[\s\S]*?throw "Unsupported historical release asset contract: \$tag"/u,
		"release verification must limit the legacy eight-asset contract to v0.0.27 and v0.0.29.",
	);
	const windowsJob = readJobBlock(workflow, "windows-runtime");
	const macosJob = readJobBlock(workflow, "macos-runtime");
	const windowsVerificationStep = requireExclusiveSourceTokenStep(
		windowsJob,
		"Verify assets, installer, and native runtime",
		"windows-runtime",
	);
	const macosVerificationStep = requireExclusiveSourceTokenStep(
		macosJob,
		"Verify checksums, provenance, and native startup",
		"macos-runtime",
	);
	if (
		matchCount(workflow, SOURCE_SECRET_ACCESS_PATTERN) !== 2 ||
		matchCount(workflow, SOURCE_TOKEN_ENV_DECLARATION_PATTERN) !== 2
	) {
		throw new Error("release verification must inject the source-read token only in the two native verification steps.");
	}
	requirePattern(
		windowsJob,
		/^    if: github\.ref == 'refs\/heads\/main'\s*$/mu,
		"windows-runtime must run only from refs/heads/main.",
	);
	requirePattern(
		windowsJob,
		/^    environment:\s*\n      name: source-verification\s*$/mu,
		"windows-runtime must use the dedicated source-verification environment.",
	);
	requirePattern(
		windowsJob,
		/^    permissions:\s*\n      contents:\s*write\s*$/mu,
		"windows-runtime must scope draft-release access to the job that needs it.",
	);
	requirePattern(
		windowsJob,
		/^        uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n        with:\n          persist-credentials: false\n          ref: refs\/heads\/main\s*$/mu,
		"windows-runtime checkout must be commit-pinned, credential-free, and fixed to refs/heads/main.",
	);
	if (/^      (?:GH_TOKEN|GITHUB_TOKEN):\s*/mu.test(windowsJob)) {
		throw new Error("windows-runtime must not expose a GitHub token to repository verifier tests.");
	}
	requirePattern(
		windowsVerificationStep,
		/^      - name: Verify assets, installer, and native runtime\s*\n        shell: pwsh\s*\n        env:\s*\n          GH_TOKEN:\s*\$\{\{ github\.token \}\}/mu,
		"windows-runtime must scope GH_TOKEN to the release-download step.",
	);
	requirePattern(
		windowsVerificationStep,
		/run:\s*\|\s*\n          \$ErrorActionPreference = "Stop"\s*\n          if \(\[string\]::IsNullOrWhiteSpace\(\$env:MAGENTA_SOURCE_READ_TOKEN\)\) \{\s*\n            throw "MAGENTA_SOURCE_READ_TOKEN is required for private source verification"\s*\n          \}/mu,
		"windows-runtime must fail closed before work begins when the source-read token is missing.",
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
		windowsVerificationStep,
		/- name: Verify assets, installer, and native runtime[\s\S]*?try \{[\s\S]*?node \(Join-Path \$env:GITHUB_WORKSPACE "\.github\/scripts\/verify-source-commit\.mjs"\)[\s\S]*?--repository "Minions-Land\/Magenta"[\s\S]*?finally \{[\s\S]*?Remove-Item Env:MAGENTA_SOURCE_READ_TOKEN/u,
		"windows-runtime must verify SOURCE_COMMIT against the source tag and scrub the read token before asset execution.",
	);
	if (!windowsVerificationStep.includes("--require-main true")) {
		throw new Error("windows-runtime must verify that the source commit is on main history.");
	}
	requirePattern(
		windowsJob,
		/function Assert-MagentaPlainTree\(\[string\]\$Root\)[\s\S]*?Get-Item -LiteralPath \$Root -Force -ErrorAction Stop[\s\S]*?FileAttributes\]::ReparsePoint[\s\S]*?Get-ChildItem -LiteralPath \$directory -Force -ErrorAction Stop[\s\S]*?isolated tree contains a reparse point/u,
		"windows-runtime must reject reparse points throughout its isolated tree.",
	);
	requirePattern(
		windowsJob,
		/function Assert-MagentaRunnerTempChild\(\[string\]\$Path\)[\s\S]*?GetFullPath\(\$env:RUNNER_TEMP\)[\s\S]*?GetFullPath\(\$Path\)[\s\S]*?StartsWith\(\$runnerTempPrefix, \[StringComparison\]::OrdinalIgnoreCase\)[\s\S]*?outside RUNNER_TEMP/u,
		"windows-runtime cleanup must prove its isolated root remains under RUNNER_TEMP.",
	);
	requirePattern(
		windowsJob,
		/\$isolatedConfigRoot = Join-Path \$env:RUNNER_TEMP "magenta-config-\$\(\[Guid\]::NewGuid\(\)\.ToString\('N'\)\)"[\s\S]*?\$isolatedHome = Join-Path \$isolatedConfigRoot "home"[\s\S]*?New-Item -ItemType Directory -Path \$isolatedConfigRoot -ErrorAction Stop \| Out-Null[\s\S]*?Assert-MagentaPlainTree \$isolatedConfigRoot[\s\S]*?\$isolatedEnvironment = \[ordered\]@\{[\s\S]*?"APPDATA" = \$isolatedAppData[\s\S]*?"HOME" = \$isolatedHome[\s\S]*?"LOCALAPPDATA" = \$isolatedLocalAppData[\s\S]*?"MAGENTA_CODING_AGENT_DIR" = \$codingAgentDirectory[\s\S]*?"MAGENTA_PEER_MESSAGE_DB" = \(Join-Path \$isolatedConfigRoot "messages\.db"\)[\s\S]*?"TEMP" = \$isolatedTemp[\s\S]*?"TMP" = \$isolatedTemp[\s\S]*?"USERPROFILE" = \$isolatedHome[\s\S]*?\$originalEnvironment = @\{\}[\s\S]*?\$originalEnvironment\[\$name\] = \[Environment\]::GetEnvironmentVariable\(\$name, "Process"\)[\s\S]*?\[Environment\]::SetEnvironmentVariable\(\$name, \$isolatedEnvironment\[\$name\], "Process"\)[\s\S]*?& \(Join-Path \$downloadDirectory "install\.ps1"\)/u,
		"windows-runtime must isolate installer and binary startup under a fresh RUNNER_TEMP-owned user and config environment.",
	);
	if (/\$env:(?:HOME|USERPROFILE)|\[Environment\]::GetFolderPath/iu.test(windowsJob)) {
		throw new Error("windows-runtime helper verification must not derive paths from the runner user profile.");
	}
	requirePattern(
		windowsJob,
		/if \(\$requiresNineAssetContract\) \{[\s\S]*?& \$binary --help --offline smoke[\s\S]*?Assert-MagentaPlainTree \$isolatedConfigRoot[\s\S]*?\$processToolsCache = Join-Path \$isolatedConfigRoot "cache\/process-tools"/u,
		"windows-runtime must materialize current helpers through the isolated non-pure smoke path.",
	);
	requirePattern(
		windowsJob,
		/\$processToolsRootItem = Get-Item -LiteralPath \$processToolsCache -Force -ErrorAction Stop[\s\S]*?\$processToolsRootItem\.PSIsContainer[\s\S]*?FileAttributes\]::ReparsePoint[\s\S]*?Get-ChildItem -LiteralPath \$processToolsCache -Force -ErrorAction Stop[\s\S]*?\$entry\.Name -cnotmatch '\^\[0-9a-f\]\{64\}\$'[\s\S]*?continue[\s\S]*?\$entry\.PSIsContainer[\s\S]*?FileAttributes\]::ReparsePoint[\s\S]*?\$processToolsGenerations\.Count -ne 1/u,
		"windows-runtime must count only plain SHA-256 process-tools generations while allowing maintenance entries.",
	);
	requirePattern(
		windowsJob,
		/\$processTools = Join-Path \$processToolsGeneration\.FullName "magenta-process-tools\.exe"[\s\S]*?\$processToolsItem = Get-Item -LiteralPath \$processTools -Force -ErrorAction Stop[\s\S]*?\$processToolsItem\.PSIsContainer[\s\S]*?FileAttributes\]::ReparsePoint[\s\S]*?Get-FileHash -LiteralPath \$processTools -Algorithm SHA256[\s\S]*?\$processToolsHash -cne \$processToolsGeneration\.Name[\s\S]*?& \$processTools --help/u,
		"windows-runtime must verify a plain cached process-tools file, digest binding, and startup.",
	);
	requirePattern(
		windowsJob,
		/\} else \{[\s\S]*?& \$binary --help[\s\S]*?\$processTools = Join-Path \$installDirectory "_magenta\/process-tools\/target\/release\/magenta-process-tools\.exe"[\s\S]*?Get-Item -LiteralPath \$processTools -Force -ErrorAction Stop[\s\S]*?\$processToolsItem\.PSIsContainer[\s\S]*?FileAttributes\]::ReparsePoint[\s\S]*?& \$processTools --help/u,
		"windows-runtime must retain native helper verification for the two legacy installer contracts.",
	);
	requirePattern(
		windowsJob,
		/finally \{[\s\S]*?SetEnvironmentVariable\(\$name, \$originalEnvironment\[\$name\], "Process"\)[\s\S]*?Assert-MagentaRunnerTempChild \$isolatedConfigRoot\s*Assert-MagentaPlainTree \$isolatedConfigRoot\s*Remove-Item -LiteralPath \$isolatedConfigRoot -Recurse -Force -ErrorAction Stop[\s\S]*?Write-Warning "Preserving unsafe Magenta runner temp state[\s\S]*?throw/u,
		"windows-runtime must restore its environment and fail closed before recursively cleaning only a verified plain RUNNER_TEMP child.",
	);
	requirePattern(
		macosJob,
		/^    if: github\.ref == 'refs\/heads\/main'\s*$/mu,
		"macos-runtime must run only from refs/heads/main.",
	);
	requirePattern(
		macosJob,
		/^    environment:\s*\n      name: source-verification\s*$/mu,
		"macos-runtime must use the dedicated source-verification environment.",
	);
	requirePattern(
		macosJob,
		/^    permissions:\s*\n      contents:\s*write\s*$/mu,
		"macos-runtime must scope draft-release access to the job that needs it.",
	);
	requirePattern(
		macosJob,
		/matrix:\s*[\s\S]*?- architecture: arm64\s*\n\s+runner: macos-15\s*[\s\S]*?- architecture: x64\s*\n\s+runner: macos-15-intel/u,
		"macos-runtime must verify helpers on native Apple Silicon and Intel runners.",
	);
	requirePattern(
		macosJob,
		/^    runs-on: \$\{\{ matrix\.runner \}\}\s*$/mu,
		"macos-runtime must use its reviewed native macOS runner matrix.",
	);
	requirePattern(
		macosJob,
		/^        uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n        with:\n          persist-credentials: false\n          ref: refs\/heads\/main\s*$/mu,
		"macos-runtime checkout must be commit-pinned, credential-free, and fixed to refs/heads/main.",
	);
	requirePattern(
		macosVerificationStep,
		/GH_TOKEN:\s*\$\{\{ github\.token \}\}\s*\n\s+MAGENTA_SOURCE_READ_TOKEN:\s*\$\{\{ secrets\.MAGENTA_SOURCE_READ_TOKEN \}\}[\s\S]*?set -euo pipefail\s*\n\s+trap 'unset GH_TOKEN GITHUB_TOKEN MAGENTA_SOURCE_READ_TOKEN' EXIT\s*\n\s+if \[ -z "\$\{MAGENTA_SOURCE_READ_TOKEN:-\}" \]; then[\s\S]*?exit 1\s*\n\s+fi/u,
		"macos-runtime must scope release and source-read tokens and scrub them before payload inspection.",
	);
	requirePattern(
		macosJob,
		/node \.github\/scripts\/verify-macos-published-release\.mjs/u,
		"macos-runtime must invoke the tracked native macOS release verifier.",
	);
	if (!macosJob.includes("--require-main true")) {
		throw new Error("macos-runtime must verify that the source commit is on main history.");
	}
	for (const argument of ["--allow-draft", "--native-architecture", "--release-dir", "--release-tag", "--repository"]) {
		if (!macosJob.includes(argument)) throw new Error(`macos-runtime verifier invocation is missing ${argument}.`);
	}
	if (/continue-on-error:\s*true|^\s+(?:if):\s*(?:false|\$\{\{\s*false\s*\}\})\s*$/imu.test(macosJob)) {
		throw new Error("macos-runtime must fail closed.");
	}
	return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 2) throw new Error("verify-release-workflow-policy.mjs does not accept arguments");
	verifyReleaseWorkflowPolicy(readFileSync(WORKFLOW_PATH, "utf8"));
	process.stdout.write("Release workflow retains the native macOS runtime gate.\n");
}
