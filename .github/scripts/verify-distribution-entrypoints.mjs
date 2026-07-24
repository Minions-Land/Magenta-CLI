#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const UNIX_BOOTSTRAP = "https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/install.sh";
const RELEASE_API_ROOT = "https://api.github.com/repos/Minions-Land/Magenta-CLI/releases/latest";
const LEGACY_UNIX_ANCHOR = "unix-v0-0-29-manual-transition";
const V0_0_29_MANIFEST_SHA256 = "f61d38f8d9c7838a77b9e79d3c33d322fc328cb22c713a304614797f5e986d21";

export function verifyDistributionEntrypoints({ readme, rootInstaller }) {
	if (!readme.includes(UNIX_BOOTSTRAP)) throw new Error("README is missing the verified Unix bootstrap entrypoint.");
	for (const required of [
		RELEASE_API_ROOT,
		"https://github.com/$repo/releases/download/$tag/install.ps1",
		"Get-FileHash",
		"$installer -Version $tag",
	]) {
		if (!readme.includes(required)) throw new Error(`README is missing Windows installer verification: ${required}`);
	}
	if (/releases\/latest\/download\//iu.test(readme)) {
		throw new Error("README must not execute or recommend mutable latest/download assets.");
	}
	if (/curl[^\n|]*\|\s*(?:ba)?sh\b/iu.test(readme)) {
		throw new Error("README must download the Unix bootstrap to a reviewable file before execution.");
	}
	if (/aria2|多源自动轮换|并行分片/iu.test(readme)) {
		throw new Error("README contains capabilities from the retired repository-root installer.");
	}
	if (!/macOS \/ Linux \(`v0\.1\.0\+`\)/u.test(readme)) {
		throw new Error("README must scope the release-bound Unix bootstrap to v0.1.0 and later.");
	}
	for (const required of [
		`id="${LEGACY_UNIX_ANCHOR}"`,
		'tag="v0.0.29"',
		V0_0_29_MANIFEST_SHA256,
		'test "$version" = "0.0.29"',
	]) {
		if (!readme.includes(required)) throw new Error(`README is missing the fixed v0.0.29 Unix transition: ${required}`);
	}
	if (typeof rootInstaller !== "string") {
		throw new Error("Repository-root install.sh compatibility entrypoint is missing.");
	}
	if (!/MAGENTA_VERSION="\$LATEST_TAG"\s+bash "\$INSTALLER_PATH" "\$@"/u.test(rootInstaller)) {
		throw new Error(
			"Repository-root install.sh must execute only its verified temporary installer with the resolved tag pinned.",
		);
	}
	if (
		!new RegExp(
			`https://api\\.github\\.com/repos/(?:\\$\\{DIST_REPO\\}|${RELEASE_API_ROOT.split("/repos/")[1].replace("/releases/latest", "")})/releases/latest`,
		).test(rootInstaller)
	) {
		throw new Error("Repository-root install.sh must resolve the latest tag from the trusted GitHub API.");
	}
	for (const [pattern, message] of [
		[/DIST_OWNER="\$\{DIST_REPO%%\/\*\}"/u, "split the repository owner from the first slash"],
		[/DIST_NAME="\$\{DIST_REPO#\*\/\}"/u, "split the repository name from the first slash"],
		[/\*\[!A-Za-z0-9_.-\]\*/u, "reject non GitHub-safe repository characters"],
		[/DIST_REPO"\s*!=\s*"\$DIST_OWNER\/\$DIST_NAME"/u, "reject repository paths with extra segments"],
	]) {
		if (!pattern.test(rootInstaller)) throw new Error(`Repository-root install.sh must ${message}.`);
	}
	if (!/releases\/download\/\$\{LATEST_TAG\}\/install\.sh/u.test(rootInstaller)) {
		throw new Error("Repository-root install.sh must construct an exact tag-bound installer URL.");
	}
	if (!/sha256sum|shasum\s+-a\s+256/iu.test(rootInstaller)) {
		throw new Error("Repository-root install.sh must verify the downloaded installer digest before execution.");
	}
	if (!/unset\s+MAGENTA_GITHUB_TOKEN/u.test(rootInstaller)) {
		throw new Error("Repository-root install.sh must scrub the API token before executing downloaded code.");
	}
	if (/releases\/latest\/download\/install\.sh/iu.test(rootInstaller)) {
		throw new Error("Repository-root install.sh must not execute the mutable latest/download installer URL.");
	}
	if (/raw\.githubusercontent|aria2|tar\s/iu.test(rootInstaller)) {
		throw new Error("Repository-root install.sh contains retired installation or asset-selection logic.");
	}
	if (!rootInstaller.includes(`#${LEGACY_UNIX_ANCHOR}`)) {
		throw new Error("Repository-root install.sh must direct v0.0.29 users to the fixed-tag manual transition.");
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 2) throw new Error("verify-distribution-entrypoints.mjs does not accept arguments");
	verifyDistributionEntrypoints({
		readme: readFileSync(resolve(REPOSITORY_ROOT, "README.md"), "utf8"),
		rootInstaller: existsSync(resolve(REPOSITORY_ROOT, "install.sh"))
			? readFileSync(resolve(REPOSITORY_ROOT, "install.sh"), "utf8")
			: undefined,
	});
	process.stdout.write("Distribution installation entrypoints are release-bound.\n");
}
