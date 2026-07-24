import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
	SOURCE_REPOSITORY,
	parseReleaseTag,
	requiresSourceCommitBinding,
	verifySourceCommitBinding,
} from "./verify-source-commit.mjs";

const TAG = "v0.1.0";
const COMMIT = "a".repeat(40);
const TAG_OBJECT = "b".repeat(40);

function fixture(sourceCommit = COMMIT) {
	const root = mkdtempSync(join(tmpdir(), "magenta-source-binding-"));
	const bytes = `${sourceCommit}\n`;
	writeFileSync(join(root, "SOURCE_COMMIT"), bytes, { mode: 0o600 });
	writeFileSync(
		join(root, "SHA256SUMS"),
		`${createHash("sha256").update(bytes).digest("hex")}  SOURCE_COMMIT\n`,
		{ mode: 0o600 },
	);
	return root;
}

function response(value, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function routedFetch(routes, seen = []) {
	return async (url, options) => {
		seen.push({ options, url });
		const route = routes.find(({ suffix }) => url.endsWith(suffix));
		if (!route) throw new Error(`Unexpected request: ${url}`);
		return typeof route.value === "function" ? route.value(url, options) : response(route.value, route.status);
	};
}

test("parses strict release tags and gates the current contract from v0.0.30", () => {
	assert.deepEqual(parseReleaseTag(TAG), { major: 0, minor: 1, patch: 0 });
	assert.throws(() => requiresSourceCommitBinding("v0.0.24"), /Unsupported historical source-binding contract/u);
	assert.equal(requiresSourceCommitBinding("v0.0.27"), false);
	assert.equal(requiresSourceCommitBinding("v0.0.29"), false);
	assert.throws(() => requiresSourceCommitBinding("v0.0.28"), /Unsupported historical source-binding contract/u);
	assert.equal(requiresSourceCommitBinding("v0.0.30"), true);
	assert.equal(requiresSourceCommitBinding(TAG), true);
	assert.equal(requiresSourceCommitBinding("v1.0.0"), true);
	assert.throws(() => parseReleaseTag("v0.01.0"), /exact/u);
});

test("peels an annotated source tag anonymously and matches SOURCE_COMMIT", async () => {
	const root = fixture();
	const seen = [];
	try {
		const result = await verifySourceCommitBinding({
			fetchImpl: routedFetch(
				[
					{
						suffix: `/repos/${SOURCE_REPOSITORY}/git/ref/tags/${TAG}`,
						value: { ref: `refs/tags/${TAG}`, object: { sha: TAG_OBJECT, type: "tag" } },
					},
					{
						suffix: `/repos/${SOURCE_REPOSITORY}/git/tags/${TAG_OBJECT}`,
						value: { sha: TAG_OBJECT, tag: TAG, object: { sha: COMMIT, type: "commit" } },
					},
				],
				seen,
			),
			releaseDir: root,
			releaseTag: TAG,
			repository: SOURCE_REPOSITORY,
		});
		assert.deepEqual(result, {
			peeledCommit: COMMIT,
			releaseTag: TAG,
			sourceCommit: COMMIT,
			status: "verified",
		});
		assert.equal(seen.length, 2);
		for (const request of seen) {
			assert.equal(Object.hasOwn(request.options.headers, "Authorization"), false);
			assert.equal(request.options.redirect, "manual");
		}
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("uses an optional source token only when explicitly supplied", async () => {
	const root = fixture();
	const seen = [];
	try {
		await verifySourceCommitBinding({
			fetchImpl: routedFetch(
				[
					{
						suffix: `/git/ref/tags/${TAG}`,
						value: { ref: `refs/tags/${TAG}`, object: { sha: TAG_OBJECT, type: "tag" } },
					},
					{
						suffix: `/git/tags/${TAG_OBJECT}`,
						value: { sha: TAG_OBJECT, tag: TAG, object: { sha: COMMIT, type: "commit" } },
					},
				],
				seen,
			),
			releaseDir: root,
			releaseTag: TAG,
			repository: SOURCE_REPOSITORY,
			token: "read-only-test-token",
		});
		assert.equal(seen.length, 2);
		for (const request of seen) {
			assert.equal(request.options.headers.Authorization, "Bearer read-only-test-token");
		}
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("supports a bounded nested annotated-tag chain", async () => {
	const root = fixture();
	const nested = "c".repeat(40);
	try {
		const result = await verifySourceCommitBinding({
			fetchImpl: routedFetch([
				{
					suffix: `/git/ref/tags/${TAG}`,
					value: { ref: `refs/tags/${TAG}`, object: { sha: TAG_OBJECT, type: "tag" } },
				},
				{
					suffix: `/git/tags/${TAG_OBJECT}`,
					value: { sha: TAG_OBJECT, tag: TAG, object: { sha: nested, type: "tag" } },
				},
				{
					suffix: `/git/tags/${nested}`,
					value: { sha: nested, tag: "nested", object: { sha: COMMIT, type: "commit" } },
				},
			]),
			releaseDir: root,
			releaseTag: TAG,
			repository: SOURCE_REPOSITORY,
			token: "token",
		});
		assert.equal(result.status, "verified");
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("rejects lightweight tags, wrong tags, and mismatches", async () => {
	const root = fixture();
	try {
		const common = (refObject, tagObject = undefined) =>
			verifySourceCommitBinding({
				fetchImpl: routedFetch([
					{
						suffix: `/git/ref/tags/${TAG}`,
						value: refObject,
					},
					...(tagObject
						? [{ suffix: `/git/tags/${TAG_OBJECT}`, value: tagObject }]
						: []),
				]),
				releaseDir: root,
				releaseTag: TAG,
				repository: SOURCE_REPOSITORY,
				token: "token",
			});
		await assert.rejects(
			() => common({ ref: `refs/tags/${TAG}`, object: { sha: COMMIT, type: "commit" } }),
			/lightweight/u,
		);
		await assert.rejects(
			() => common({ ref: "refs/tags/v0.0.31", object: { sha: TAG_OBJECT, type: "tag" } }),
			/unexpected shape/u,
		);
		await assert.rejects(
			() =>
				common(
					{ ref: `refs/tags/${TAG}`, object: { sha: TAG_OBJECT, type: "tag" } },
					{ sha: TAG_OBJECT, tag: TAG, object: { sha: "d".repeat(40), type: "commit" } },
				),
			/SOURCE_COMMIT does not match/u,
		);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("fails closed on API 404, ambiguous responses, unsupported objects, and loops", async () => {
	const root = fixture();
	try {
		const base = {
			releaseDir: root,
			releaseTag: TAG,
			repository: SOURCE_REPOSITORY,
			token: "token",
		};
		await assert.rejects(
			() =>
				verifySourceCommitBinding({
					...base,
					fetchImpl: routedFetch([{ suffix: `/git/ref/tags/${TAG}`, value: {}, status: 404 }]),
				}),
			/Source repository API request failed \(404\)/u,
		);
		await assert.rejects(
			() =>
				verifySourceCommitBinding({
					...base,
					fetchImpl: routedFetch([
						{ suffix: `/git/ref/tags/${TAG}`, value: [{ ref: `refs/tags/${TAG}` }] },
					]),
				}),
			/unexpected shape/u,
		);
		await assert.rejects(
			() =>
				verifySourceCommitBinding({
					...base,
					fetchImpl: routedFetch([
						{
							suffix: `/git/ref/tags/${TAG}`,
							value: { ref: `refs/tags/${TAG}`, object: { sha: TAG_OBJECT, type: "tag" } },
						},
						{
							suffix: `/git/tags/${TAG_OBJECT}`,
							value: { sha: TAG_OBJECT, tag: TAG, object: { sha: "d".repeat(40), type: "tree" } },
						},
					]),
				}),
			/unsupported Git object/u,
		);
		await assert.rejects(
			() =>
				verifySourceCommitBinding({
					...base,
					fetchImpl: routedFetch([
						{
							suffix: `/git/ref/tags/${TAG}`,
							value: { ref: `refs/tags/${TAG}`, object: { sha: TAG_OBJECT, type: "tag" } },
						},
						{
							suffix: `/git/tags/${TAG_OBJECT}`,
							value: { sha: TAG_OBJECT, tag: TAG, object: { sha: TAG_OBJECT, type: "tag" } },
						},
					]),
				}),
			/contains a loop/u,
		);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("legacy releases skip source-tag API verification", async () => {
	const root = fixture();
	try {
		const result = await verifySourceCommitBinding({
			releaseDir: root,
			releaseTag: "v0.0.29",
			repository: SOURCE_REPOSITORY,
		});
		assert.deepEqual(result, { releaseTag: "v0.0.29", sourceCommit: COMMIT, status: "not-required" });
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("does not allow callers to redirect the source provenance check", async () => {
	const root = fixture();
	try {
		await assert.rejects(
			() =>
				verifySourceCommitBinding({
					releaseDir: root,
				releaseTag: TAG,
				repository: "attacker/example",
				token: "token",
			}),
			/fixed Minions-Land\/Magenta/u,
		);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});
