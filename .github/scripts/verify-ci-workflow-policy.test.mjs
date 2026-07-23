import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyCiWorkflowPolicy } from "./verify-ci-workflow-policy.mjs";

const workflow = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../workflows/ci.yml"), "utf8");

test("current distribution CI runs the complete fail-closed verifier suite", () => {
	assert.equal(verifyCiWorkflowPolicy(workflow), true);
});

test("rejects credential persistence, missing tests, or soft failure", () => {
	assert.throws(
		() => verifyCiWorkflowPolicy(workflow.replace("persist-credentials: false", "persist-credentials: true")),
		/must not persist credentials/u,
	);
	assert.throws(
		() => verifyCiWorkflowPolicy(workflow.replace("node --test .github/scripts/*.test.mjs", "echo skipped")),
		/missing required command/u,
	);
	assert.throws(
		() => verifyCiWorkflowPolicy(workflow.replace("    runs-on: ubuntu-latest", "    continue-on-error: true\n    runs-on: ubuntu-latest")),
		/must fail closed/u,
	);
});
