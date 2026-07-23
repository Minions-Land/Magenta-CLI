#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CI_PATH = resolve(REPOSITORY_ROOT, ".github/workflows/ci.yml");

function requirePattern(content, pattern, message) {
	if (!pattern.test(content)) throw new Error(message);
}

export function verifyCiWorkflowPolicy(workflow) {
	requirePattern(workflow, /^\s*pull_request:\s*$/mu, "distribution CI must run for pull requests.");
	requirePattern(workflow, /^\s*push:\s*$/mu, "distribution CI must run for pushes.");
	requirePattern(
		workflow,
		/^permissions:\s*\n  contents: read\s*$/mu,
		"distribution CI must use read-only repository permissions.",
	);
	requirePattern(
		workflow,
		/uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n        with:\n          persist-credentials: false/u,
		"distribution CI checkout must be pinned and must not persist credentials.",
	);
	requirePattern(
		workflow,
		/uses: actions\/setup-node@[0-9a-f]{40}[^\n]*\n        with:\n          node-version: "22\.19\.0"/u,
		"distribution CI must use the reviewed Node.js version.",
	);
	for (const command of [
		"node --test .github/scripts/*.test.mjs",
		"node .github/scripts/verify-distribution-entrypoints.mjs",
		"node .github/scripts/verify-release-workflow-policy.mjs",
		"node .github/scripts/verify-ci-workflow-policy.mjs",
		"bash -n install.sh",
		"shellcheck -x install.sh",
		"git diff --check",
	]) {
		if (!workflow.includes(command)) throw new Error(`distribution CI is missing required command: ${command}`);
	}
	if (/continue-on-error:\s*true/iu.test(workflow)) throw new Error("distribution CI must fail closed.");
	return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.length !== 2) throw new Error("verify-ci-workflow-policy.mjs does not accept arguments");
	verifyCiWorkflowPolicy(readFileSync(CI_PATH, "utf8"));
	process.stdout.write("Distribution CI policy is intact.\n");
}
