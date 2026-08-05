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

export function verifyReleaseWorkflowPolicy(input) {
	const workflow = input.replace(/\r\n?/gu, "\n");
	requirePattern(
		workflow,
		/^permissions:\s*\n  contents:\s*read\s*$/mu,
		"release verification workflow must default to read-only repository permissions.",
	);
	if (/MAGENTA_SOURCE_READ_TOKEN/u.test(workflow)) {
		throw new Error("release verification must use anonymous public-source verification without a legacy source token.");
	}
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
	requirePattern(
		windowsJob,
		/^    permissions:\s*\n      contents:\s*write\s*$/mu,
		"windows-runtime must scope draft-release access to the job that needs it.",
	);
	requirePattern(
		windowsJob,
		/^        uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n        with:\n          persist-credentials: false\s*$/mu,
		"windows-runtime checkout must be commit-pinned with persisted credentials disabled.",
	);
	if (/^      (?:GH_TOKEN|GITHUB_TOKEN):\s*/mu.test(windowsJob)) {
		throw new Error("windows-runtime must not expose a GitHub token to repository verifier tests.");
	}
	requirePattern(
		windowsJob,
		/- name: Verify assets, installer, and native runtime[\s\S]*?\n        shell: pwsh\s*\n        env:\s*\n          GH_TOKEN:\s*\$\{\{ github\.token \}\}/u,
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
		/- name: Verify assets, installer, and native runtime[\s\S]*?node \(Join-Path \$env:GITHUB_WORKSPACE "\.github\/scripts\/verify-source-commit\.mjs"\)[\s\S]*?--repository "Minions-Land\/Magenta"/u,
		"windows-runtime must verify SOURCE_COMMIT against the fixed public source tag before asset execution.",
	);
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
	const macosJob = readJobBlock(workflow, "macos-runtime");
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
		/^        uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n        with:\n          persist-credentials: false\s*$/mu,
		"macos-runtime checkout must be commit-pinned with persisted credentials disabled.",
	);
	requirePattern(
		macosJob,
		/GH_TOKEN:\s*\$\{\{ github\.token \}\}[\s\S]*?node \.github\/scripts\/verify-macos-published-release\.mjs/u,
		"macos-runtime must invoke the tracked native macOS release verifier with a scoped release token.",
	);
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
