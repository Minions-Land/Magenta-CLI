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

function response(value, status = 200, headers = {}) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json", ...headers },
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

test("peels an annotated source tag without a token when the source API allows it", async () => {
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

test("can require the peeled commit to be on the private source main history", async () => {
	const root = fixture();
	const seen = [];
	try {
		const result = await verifySourceCommitBinding({
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
					{
						suffix: `/compare/${COMMIT}...main`,
						value: { status: "ahead" },
					},
				],
				seen,
			),
			releaseDir: root,
			releaseTag: TAG,
			repository: SOURCE_REPOSITORY,
			requireMainHistory: true,
			token: "read-only-test-token",
		});
		assert.equal(result.mainStatus, "ahead");
		assert.equal(seen.length, 3);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("fails closed when the peeled commit is not on main", async () => {
	const root = fixture();
	try {
		await assert.rejects(
			() =>
				verifySourceCommitBinding({
					fetchImpl: routedFetch([
						{
							suffix: `/git/ref/tags/${TAG}`,
							value: { ref: `refs/tags/${TAG}`, object: { sha: TAG_OBJECT, type: "tag" } },
						},
						{
							suffix: `/git/tags/${TAG_OBJECT}`,
							value: { sha: TAG_OBJECT, tag: TAG, object: { sha: COMMIT, type: "commit" } },
						},
						{ suffix: `/compare/${COMMIT}...main`, value: { status: "diverged" } },
					]),
					releaseDir: root,
					releaseTag: TAG,
					repository: SOURCE_REPOSITORY,
					requireMainHistory: true,
				}),
			/ not on the main branch history/u,
		);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("retries a signaled source API rate limit and then succeeds", async () => {
	const root = fixture();
	const seen = [];
	const sleeps = [];
	const now = 1_000_000;
	const limited = response(
		{ message: "rate limited response body must not enter diagnostics" },
		403,
		{
			"x-ratelimit-remaining": "0",
			"x-ratelimit-reset": String((now + 4_000) / 1_000),
		},
	);
	let refAttempts = 0;
	try {
		const result = await verifySourceCommitBinding({
			fetchImpl: routedFetch(
				[
					{
						suffix: `/git/ref/tags/${TAG}`,
						value: () => {
							refAttempts += 1;
							return refAttempts === 1
								? limited
								: response({ ref: `refs/tags/${TAG}`, object: { sha: TAG_OBJECT, type: "tag" } });
						},
					},
					{
						suffix: `/git/tags/${TAG_OBJECT}`,
						value: { sha: TAG_OBJECT, tag: TAG, object: { sha: COMMIT, type: "commit" } },
					},
				],
				seen,
			),
			nowImpl: () => now,
			releaseDir: root,
			releaseTag: TAG,
			repository: SOURCE_REPOSITORY,
			sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
		});
		assert.equal(result.status, "verified");
		assert.deepEqual(sleeps, [5_000]);
		assert.equal(seen.length, 3);
		assert.equal(limited.bodyUsed, true);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("accepts only a strict IMF-fixdate Retry-After value on 403", async () => {
	const root = fixture();
	const now = Date.UTC(2026, 7, 6, 12, 0, 0);
	const sleeps = [];
	let attempts = 0;
	try {
		const result = await verifySourceCommitBinding({
			fetchImpl: routedFetch([
				{
					suffix: `/git/ref/tags/${TAG}`,
					value: () => {
						attempts += 1;
						return attempts === 1
							? response({ message: "wait" }, 403, {
									"retry-after": "Thu, 06 Aug 2026 12:00:02 GMT",
								})
							: response({ ref: `refs/tags/${TAG}`, object: { sha: TAG_OBJECT, type: "tag" } });
					},
				},
				{
					suffix: `/git/tags/${TAG_OBJECT}`,
					value: { sha: TAG_OBJECT, tag: TAG, object: { sha: COMMIT, type: "commit" } },
				},
			]),
			nowImpl: () => now,
			releaseDir: root,
			releaseTag: TAG,
			repository: SOURCE_REPOSITORY,
			sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
		});
		assert.equal(result.status, "verified");
		assert.deepEqual(sleeps, [2_000]);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("rejects malformed or combined Retry-After values on an otherwise unproven 403", async () => {
	const root = fixture();
	try {
		for (const retryAfter of ["5, 10", "-1", "+1", "1.5", "2026-08-06"]) {
			const sleeps = [];
			await assert.rejects(
				() =>
					verifySourceCommitBinding({
						fetchImpl: async () => response({ message: "denied" }, 403, { "retry-after": retryAfter }),
						releaseDir: root,
						releaseTag: TAG,
						repository: SOURCE_REPOSITORY,
						sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
					}),
				/Source repository API request failed \(403\)/u,
			);
			assert.deepEqual(sleeps, []);
		}
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("does not retry an unproven 403 response", async () => {
	const root = fixture();
	const seen = [];
	const sleeps = [];
	const denied = response({ message: "sensitive denial detail" }, 403);
	try {
		await assert.rejects(
			() =>
				verifySourceCommitBinding({
					fetchImpl: routedFetch([{ suffix: `/git/ref/tags/${TAG}`, value: () => denied }], seen),
					releaseDir: root,
					releaseTag: TAG,
					repository: SOURCE_REPOSITORY,
					sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
					token: "sensitive source token",
				}),
			(error) => {
				assert.match(error.message, /Source repository API request failed \(403\)/u);
				assert.doesNotMatch(error.message, /sensitive denial detail/u);
				assert.doesNotMatch(error.message, /sensitive source token/u);
				return true;
			},
		);
		assert.equal(seen.length, 1);
		assert.deepEqual(sleeps, []);
		assert.equal(denied.bodyUsed, true);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("cancels an oversized failed response body without retrying", async () => {
	const root = fixture();
	let cancelled = false;
	const denied = new Response(
		new ReadableStream({
			cancel() {
				cancelled = true;
			},
			pull(controller) {
				controller.enqueue(new Uint8Array(600 * 1024));
			},
		}),
		{ status: 403 },
	);
	try {
		await assert.rejects(
			() =>
				verifySourceCommitBinding({
					fetchImpl: routedFetch([{ suffix: `/git/ref/tags/${TAG}`, value: () => denied }]),
					releaseDir: root,
					releaseTag: TAG,
					repository: SOURCE_REPOSITORY,
				}),
			/Source repository API request failed \(403\)/u,
		);
		assert.equal(cancelled, true);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("preserves the per-request timeout while draining a failed response body", async () => {
	const root = fixture();
	const sleeps = [];
	let cancelled = false;
	let released = false;
	let requestSignal;
	try {
		await assert.rejects(
			() =>
				verifySourceCommitBinding({
					fetchImpl: async (_url, options) => {
						requestSignal = options.signal;
						return {
							body: {
								getReader: () => ({
									cancel: async () => {
										cancelled = true;
									},
									read: () =>
										new Promise((_resolve, reject) => {
											options.signal.addEventListener("abort", () => reject(new Error("body aborted")), {
												once: true,
											});
										}),
									releaseLock: () => {
										released = true;
									},
								}),
							},
							headers: new Headers(),
							ok: false,
							status: 429,
						};
					},
					releaseDir: root,
					releaseTag: TAG,
					repository: SOURCE_REPOSITORY,
					requestTimeoutMs: 1,
					sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
				}),
			/Source repository API request timed out/u,
		);
		assert.equal(requestSignal.aborted, true);
		assert.equal(cancelled, true);
		assert.equal(released, true);
		assert.deepEqual(sleeps, []);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("stops after the shared source API rate limit retry budget is exhausted", async () => {
	const root = fixture();
	const seen = [];
	const sleeps = [];
	const limitedResponses = [];
	let refAttempts = 0;
	try {
		await assert.rejects(
			() =>
				verifySourceCommitBinding({
					fetchImpl: routedFetch(
						[
							{
								suffix: `/git/ref/tags/${TAG}`,
								value: () => {
									refAttempts += 1;
									if (refAttempts > 1) {
										return response({ ref: `refs/tags/${TAG}`, object: { sha: TAG_OBJECT, type: "tag" } });
									}
									const limited = response({ message: "slow down" }, 429);
									limitedResponses.push(limited);
									return limited;
								},
							},
							{
								suffix: `/git/tags/${TAG_OBJECT}`,
								value: () => {
									const limited = response({ message: "slow down again" }, 429);
									limitedResponses.push(limited);
									return limited;
								},
							},
						],
						seen,
					),
					releaseDir: root,
					releaseTag: TAG,
					repository: SOURCE_REPOSITORY,
					sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
				}),
			/Source repository API rate limit retry budget exhausted \(429\)/u,
		);
		assert.equal(seen.length, 4);
		assert.deepEqual(sleeps, [1_000, 2_000]);
		assert.equal(limitedResponses.every((limited) => limited.bodyUsed), true);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("does not retry before a Retry-After value beyond the remaining total wait budget", async () => {
	const root = fixture();
	const seen = [];
	const sleeps = [];
	let refAttempts = 0;
	try {
		await assert.rejects(
			() =>
				verifySourceCommitBinding({
					fetchImpl: routedFetch(
						[
							{
								suffix: `/git/ref/tags/${TAG}`,
								value: () => {
									refAttempts += 1;
									return refAttempts === 1
										? response({ message: "wait" }, 429, { "retry-after": "40" })
										: response({ ref: `refs/tags/${TAG}`, object: { sha: TAG_OBJECT, type: "tag" } });
								},
							},
							{
								suffix: `/git/tags/${TAG_OBJECT}`,
								value: () => response({ message: "wait longer" }, 403, { "retry-after": "21" }),
							},
						],
						seen,
					),
					releaseDir: root,
					releaseTag: TAG,
					repository: SOURCE_REPOSITORY,
					sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
				}),
			/Source repository API rate limit retry budget exhausted \(403\)/u,
		);
		assert.equal(seen.length, 3);
		assert.deepEqual(sleeps, [40_000]);
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
