#!/usr/bin/env node

import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GITHUB_API_ROOT = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const OBJECT_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_TAG_DEPTH = 8;
const LEGACY_SOURCE_COMMIT_TAGS = new Set(["v0.0.27", "v0.0.29"]);

export const SOURCE_REPOSITORY = "Minions-Land/Magenta";

function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRepository(repository) {
	if (!REPOSITORY_PATTERN.test(repository ?? "") || repository !== SOURCE_REPOSITORY) {
		throw new Error(`Source repository must be the fixed ${SOURCE_REPOSITORY} repository.`);
	}
	return repository;
}

export function parseReleaseTag(tag) {
	const match = RELEASE_TAG_PATTERN.exec(tag ?? "");
	if (!match) throw new Error(`Release tag must be exact vMAJOR.MINOR.PATCH: ${tag ?? "(missing)"}`);
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
	};
}

export function requiresSourceCommitBinding(tag) {
	const { major, minor, patch } = parseReleaseTag(tag);
	if (major > 0 || minor > 0 || patch >= 30) return true;
	if (LEGACY_SOURCE_COMMIT_TAGS.has(tag)) return false;
	throw new Error(`Unsupported historical source-binding contract: ${tag}`);
}

function assertObjectSha(value, label) {
	if (typeof value !== "string" || !OBJECT_SHA_PATTERN.test(value)) {
		throw new Error(`${label} is not a full Git object ID.`);
	}
	return value.toLowerCase();
}

function assertRegularFile(path, label) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
}

function readSourceCommit(releaseDir) {
	const root = resolve(releaseDir);
	const path = join(root, "SOURCE_COMMIT");
	assertRegularFile(path, "SOURCE_COMMIT");
	const sourceCommit = readFileSync(path, "utf8").trim().toLowerCase();
	return assertObjectSha(sourceCommit, "SOURCE_COMMIT");
}

function sourceApiHeaders(token) {
	const headers = {
		Accept: "application/vnd.github+json",
		"User-Agent": "magenta-source-commit-verifier",
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
	};
	if (typeof token === "string" && token.length > 0) {
		headers.Authorization = `Bearer ${token}`;
	}
	return headers;
}

async function fetchJson(fetchImpl, url, token) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	let response;
	try {
		response = await fetchImpl(url, {
			headers: sourceApiHeaders(token),
			redirect: "manual",
			signal: controller.signal,
		});
		if (response.status >= 300 && response.status < 400) {
			throw new Error("Source repository API returned an unexpected redirect.");
		}
		if (!response.ok) {
			throw new Error(`Source repository API request failed (${response.status}).`);
		}
		if (!response.body) throw new Error("Source repository API returned no body.");
		const reader = response.body.getReader();
		const chunks = [];
		let total = 0;
		while (true) {
			const result = await reader.read();
			if (result.done) break;
			const chunk = result.value ?? new Uint8Array();
			total += chunk.byteLength;
			if (total > MAX_RESPONSE_BYTES) {
				await reader.cancel().catch(() => undefined);
				throw new Error("Source repository API response exceeds the size limit.");
			}
			chunks.push(Buffer.from(chunk));
		}
		let data;
		try {
			data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			throw new Error("Source repository API response is not valid JSON.");
		}
		if (!isObject(data)) throw new Error("Source repository API response has an unexpected shape.");
		return data;
	} catch (error) {
		if (controller.signal.aborted) throw new Error("Source repository API request timed out.");
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

function assertTagRef(ref, tag) {
	if (!isObject(ref) || ref.ref !== `refs/tags/${tag}` || !isObject(ref.object)) {
		throw new Error("Source repository tag ref has an unexpected shape.");
	}
	if (ref.object.type !== "tag") {
		throw new Error("Source repository tag must be an annotated tag; lightweight tags are rejected.");
	}
	return assertObjectSha(ref.object.sha, "Annotated source tag object");
}

function assertAnnotatedTag(tagObject, expectedTag, expectedSha, { root }) {
	if (!isObject(tagObject) || tagObject.sha !== expectedSha || !isObject(tagObject.object)) {
		throw new Error("Source repository annotated tag object has an unexpected shape.");
	}
	if (root && tagObject.tag !== expectedTag) {
		throw new Error("Source repository annotated tag name does not match the release tag.");
	}
	return tagObject.object;
}

/**
 * Prove that SOURCE_COMMIT is the commit peeled from the exact annotated tag.
 * The fixed source repository is public, so verification is anonymous unless
 * the caller explicitly supplies a token. No downloaded release code is
 * executed in this path.
 */
export async function verifySourceCommitBinding({
	fetchImpl = fetch,
	releaseDir,
	releaseTag,
	repository = SOURCE_REPOSITORY,
	token,
}) {
	parseReleaseTag(releaseTag);
	assertRepository(repository);
	if (!requiresSourceCommitBinding(releaseTag)) {
		return { releaseTag, sourceCommit: readSourceCommit(releaseDir), status: "not-required" };
	}

	const sourceCommit = readSourceCommit(releaseDir);
	const encodedTag = encodeURIComponent(releaseTag);
	const root = `${GITHUB_API_ROOT}/repos/${repository}`;
	const ref = await fetchJson(fetchImpl, `${root}/git/ref/tags/${encodedTag}`, token);
	let tagSha = assertTagRef(ref, releaseTag);
	const visited = new Set();
	let peeledCommit;
	for (let depth = 0; depth < MAX_TAG_DEPTH; depth += 1) {
		if (visited.has(tagSha)) throw new Error("Source repository annotated tag chain contains a loop.");
		visited.add(tagSha);
		const tagObject = await fetchJson(fetchImpl, `${root}/git/tags/${tagSha}`, token);
		const target = assertAnnotatedTag(tagObject, releaseTag, tagSha, { root: depth === 0 });
		if (target.type === "commit") {
			peeledCommit = assertObjectSha(target.sha, "Peeled source commit");
			break;
		}
		if (target.type !== "tag") {
			throw new Error("Source repository annotated tag points to an unsupported Git object.");
		}
		tagSha = assertObjectSha(target.sha, "Nested annotated tag object");
	}
	if (!peeledCommit) throw new Error("Source repository annotated tag chain is too deep.");
	if (peeledCommit !== sourceCommit) {
		throw new Error("SOURCE_COMMIT does not match the commit peeled from the source release tag.");
	}
	return { releaseTag, sourceCommit, peeledCommit, status: "verified" };
}

function parseArguments(args) {
	const values = new Map();
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		const value = args[index + 1];
		if (!flag?.startsWith("--") || value === undefined || values.has(flag)) {
			throw new Error(`Invalid or duplicate argument: ${flag ?? "(missing)"}`);
		}
		values.set(flag, value);
	}
	for (const flag of values.keys()) {
		if (!["--release-dir", "--release-tag", "--repository"].includes(flag)) {
			throw new Error(`Unknown argument: ${flag}`);
		}
	}
	for (const flag of ["--release-dir", "--release-tag", "--repository"]) {
		if (!values.get(flag)) throw new Error(`${flag} is required.`);
	}
	return {
		releaseDir: values.get("--release-dir"),
		releaseTag: values.get("--release-tag"),
		repository: values.get("--repository"),
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const options = parseArguments(process.argv.slice(2));
		const result = await verifySourceCommitBinding(options);
		process.stdout.write(`source_tag=${result.releaseTag}\nsource_commit=${result.sourceCommit}\n`);
		process.stdout.write(`source_binding=${result.status}\n`);
	} catch (error) {
		process.stderr.write(`Source commit verification failed: ${error.message}\n`);
		process.exitCode = 1;
	}
}
