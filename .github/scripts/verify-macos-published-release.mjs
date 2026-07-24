#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	createReadStream,
	createWriteStream,
	lstatSync,
	mkdtempSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifySourceCommitBinding } from "./verify-source-commit.mjs";

const GITHUB_API_ROOT = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA256_DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/u;
const METADATA_WALL_TIMEOUT_MS = 60_000;
const METADATA_INACTIVITY_TIMEOUT_MS = 30_000;
const ASSET_WALL_TIMEOUT_MS = 15 * 60_000;
const ASSET_INACTIVITY_TIMEOUT_MS = 120_000;
const MAX_ASSET_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const SYSTEM_COMMAND_TIMEOUT_MS = 5 * 60_000;
const HELPER_PROOF_TIMEOUT_MS = 60_000;
const HELPER_PROOF_SCHEMA = "magenta.release-embedded-helper-proof.v1";
const LEGACY_EIGHT_ASSET_TAGS = new Set(["v0.0.27", "v0.0.29"]);

export const CHECKSUMMED_ASSETS_CURRENT = Object.freeze([
	"magenta-macos-arm64",
	"magenta-macos-x64",
	"magenta-linux-x64",
	"magenta-windows-x64.exe",
	"magenta-resources-universal.tar.gz",
	"install.sh",
	"install.ps1",
	"SOURCE_COMMIT",
]);
export const EXPECTED_RELEASE_ASSETS_CURRENT = Object.freeze([...CHECKSUMMED_ASSETS_CURRENT, "SHA256SUMS"].sort());
export const EXPECTED_RELEASE_ASSETS_LEGACY_EIGHT = Object.freeze(
	[
		"SHA256SUMS",
		"SOURCE_COMMIT",
		"install.ps1",
		"magenta-linux-x64",
		"magenta-macos-arm64",
		"magenta-macos-x64",
		"magenta-resources-universal.tar.gz",
		"magenta-windows-x64.exe",
	].sort(),
);

export const MACOS_OUTER_BINARIES = Object.freeze([
	{ architecture: "arm64", name: "magenta-macos-arm64" },
	{ architecture: "x64", name: "magenta-macos-x64" },
]);
export const MACOS_CLIPBOARD_PAYLOAD = Object.freeze({
	architectures: Object.freeze(["arm64", "x86_64"]),
	resourcePath:
		"runtime/node_modules/@mariozechner/clipboard-darwin-universal/clipboard.darwin-universal.node",
});
export const MACOS_EMBEDDED_PAYLOADS = Object.freeze([
	{ architecture: "arm64", kind: "process-tools" },
	{ architecture: "arm64", kind: "fd" },
	{ architecture: "arm64", kind: "rg" },
	{ architecture: "x64", kind: "process-tools" },
	{ architecture: "x64", kind: "fd" },
	{ architecture: "x64", kind: "rg" },
]);

function arraysEqual(left, right) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sha256File(path) {
	return new Promise((resolveHash, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolveHash(hash.digest("hex")));
	});
}

function sha256FileSync(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertRegularFile(path, label) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
}

export async function verifyReleaseChecksumManifest({ releaseDir }) {
	const root = resolve(releaseDir);
	const actualNames = readdirSync(root).sort();
	if (!arraysEqual(actualNames, EXPECTED_RELEASE_ASSETS_CURRENT)) {
		throw new Error("Downloaded asset set does not exactly match the current release contract.");
	}

	const manifestPath = join(root, "SHA256SUMS");
	assertRegularFile(manifestPath, "SHA256SUMS");
	const entries = new Map();
	for (const [index, line] of readFileSync(manifestPath, "utf8").split(/\r?\n/u).entries()) {
		if (!line) continue;
		const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(line);
		if (!match) throw new Error(`Invalid SHA256SUMS line ${index + 1}.`);
		const [, hash, name] = match;
		if (entries.has(name)) throw new Error(`Duplicate SHA256SUMS entry: ${name}`);
		entries.set(name, hash);
	}
	const actualEntries = [...entries.keys()].sort();
	const expectedEntries = [...CHECKSUMMED_ASSETS_CURRENT].sort();
	if (!arraysEqual(actualEntries, expectedEntries)) {
		throw new Error("SHA256SUMS does not cover the exact current release payload.");
	}
	for (const name of expectedEntries) {
		const path = join(root, name);
		assertRegularFile(path, `Release asset ${name}`);
		if ((await sha256File(path)) !== entries.get(name)) throw new Error(`SHA256SUMS asset hash mismatch: ${name}`);
	}
	const sourceCommit = readFileSync(join(root, "SOURCE_COMMIT"), "utf8").trim().toLowerCase();
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(sourceCommit)) {
		throw new Error("SOURCE_COMMIT is not a full Git object ID.");
	}
	return { manifestSha256: await sha256File(manifestPath), sourceCommit };
}

export function parseReleaseTag(tag) {
	const match = RELEASE_TAG_PATTERN.exec(tag ?? "");
	if (!match) throw new Error(`Release tag must be exact vMAJOR.MINOR.PATCH: ${tag ?? "(missing)"}`);
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		version: tag.slice(1),
	};
}

export function requiresNineAssetContract(tag) {
	const { major, minor, patch } = parseReleaseTag(tag);
	return major > 0 || minor > 0 || patch >= 30;
}

export function releaseAssetContractForTag(tag) {
	if (requiresNineAssetContract(tag)) return "current-nine";
	if (LEGACY_EIGHT_ASSET_TAGS.has(tag)) return "legacy-eight";
	throw new Error(`Unsupported historical release asset contract: ${tag}`);
}

function assertRepository(repository) {
	if (!REPOSITORY_PATTERN.test(repository ?? "")) {
		throw new Error("Repository must be exact OWNER/REPOSITORY.");
	}
	return repository;
}

function apiHeaders(token, accept = "application/vnd.github+json") {
	return {
		Accept: accept,
		Authorization: `Bearer ${token}`,
		"User-Agent": "magenta-public-release-verifier",
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
	};
}

function timeoutError(label, kind, timeoutMs) {
	return new Error(`${label} ${kind} timeout after ${timeoutMs}ms`);
}

async function fetchWithTimeout(fetchImpl, url, options, { label, wallTimeoutMs = METADATA_WALL_TIMEOUT_MS } = {}) {
	const controller = new AbortController();
	let timeout;
	let raceTimeout;
	const deadline = new Promise((_, reject) => {
		raceTimeout = setTimeout(() => reject(timeoutError(label ?? "GitHub request", "wall", wallTimeoutMs)), wallTimeoutMs);
	});
	timeout = setTimeout(() => controller.abort(timeoutError(label ?? "GitHub request", "wall", wallTimeoutMs)), wallTimeoutMs);
	try {
		return await Promise.race([
			fetchImpl(url, { ...options, signal: controller.signal }),
			deadline,
		]);
	} finally {
		clearTimeout(timeout);
		clearTimeout(raceTimeout);
	}
}

async function readResponseText(
	response,
	{ label, maxBytes = MAX_METADATA_BYTES, wallTimeoutMs = METADATA_WALL_TIMEOUT_MS, inactivityTimeoutMs = METADATA_INACTIVITY_TIMEOUT_MS } = {},
) {
	if (!response.body) throw new Error(`${label ?? "GitHub response"} returned no body.`);
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	let idleTimer;
	let wallTimer;
	let settled = false;
	const wallPromise = new Promise((_, reject) => {
		wallTimer = setTimeout(() => reject(timeoutError(label ?? "GitHub response", "wall", wallTimeoutMs)), wallTimeoutMs);
	});
	const readWithIdleTimeout = async () => {
		while (true) {
			const result = await Promise.race([
				reader.read(),
				new Promise((_, reject) => {
					idleTimer = setTimeout(
						() => reject(timeoutError(label ?? "GitHub response", "idle", inactivityTimeoutMs)),
						inactivityTimeoutMs,
					);
				}),
			]);
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = undefined;
			if (result.done) break;
			const value = result.value ?? new Uint8Array();
			total += value.byteLength;
			if (total > maxBytes) throw new Error(`${label ?? "GitHub response"} exceeds the ${maxBytes}-byte limit.`);
			chunks.push(Buffer.from(value));
		}
		return Buffer.concat(chunks).toString("utf8");
	};
	try {
		settled = true;
		return await Promise.race([readWithIdleTimeout(), wallPromise]);
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		if (idleTimer) clearTimeout(idleTimer);
		if (wallTimer) clearTimeout(wallTimer);
		if (!settled) await reader.cancel().catch(() => undefined);
	}
}

async function fetchJson(url, token, fetchImpl, timeoutOptions = {}) {
	const response = await fetchWithTimeout(fetchImpl, url, { headers: apiHeaders(token) }, {
		label: "GitHub metadata",
		...timeoutOptions,
	});
	if (!response.ok) throw new Error(`GitHub API request failed (${response.status}): ${new URL(url).pathname}`);
	const body = await readResponseText(response, { label: "GitHub metadata", ...timeoutOptions });
	let data;
	try {
		data = JSON.parse(body);
	} catch {
		throw new Error("GitHub metadata response is not valid JSON.");
	}
	return { data, next: parseNextLink(response.headers.get("link")) };
}

function parseNextLink(value) {
	if (!value) return undefined;
	for (const entry of value.split(",")) {
		const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/u.exec(entry);
		if (match?.[2] === "next") return match[1];
	}
	return undefined;
}

function assertTrustedApiPage(url, repository, repositoryId) {
	const parsed = new URL(url);
	const expectedNamedPath = `/repos/${repository}/releases`;
	const expectedNumericPath = `/repositories/${repositoryId}/releases`;
	if (
		parsed.protocol !== "https:" ||
		parsed.hostname !== "api.github.com" ||
		(![expectedNamedPath, `${expectedNamedPath}/`, expectedNumericPath, `${expectedNumericPath}/`].includes(parsed.pathname))
	) {
		throw new Error("GitHub API pagination left the expected repository release endpoint.");
	}
}

export async function fetchReleaseMetadata({
	allowDraft,
	fetchImpl = fetch,
	repository,
	tag,
	token,
	wallTimeoutMs = METADATA_WALL_TIMEOUT_MS,
	inactivityTimeoutMs = METADATA_INACTIVITY_TIMEOUT_MS,
}) {
	assertRepository(repository);
	parseReleaseTag(tag);
	if (!token) throw new Error("GH_TOKEN is required to download release assets by API ID.");

	let release;
	if (allowDraft) {
		const timeoutOptions = { wallTimeoutMs, inactivityTimeoutMs };
		const repositoryResponse = await fetchJson(
			`${GITHUB_API_ROOT}/repos/${repository}`,
			token,
			fetchImpl,
			timeoutOptions,
		);
		const repositoryId = repositoryResponse.data?.id;
		if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
			throw new Error("GitHub repository metadata has no valid numeric ID.");
		}
		const matches = [];
		const visited = new Set();
		let next = `${GITHUB_API_ROOT}/repos/${repository}/releases?per_page=100`;
		while (next) {
			assertTrustedApiPage(next, repository, repositoryId);
			if (visited.has(next)) throw new Error("GitHub API release pagination contains a loop.");
			visited.add(next);
			const page = await fetchJson(next, token, fetchImpl, timeoutOptions);
			if (!Array.isArray(page.data)) throw new Error("GitHub release listing is not an array.");
			for (const candidate of page.data) if (candidate?.tag_name === tag) matches.push(candidate);
			next = page.next;
		}
		if (matches.length !== 1) {
			throw new Error(`Expected exactly one release metadata record for ${tag}, found ${matches.length}.`);
		}
		[release] = matches;
	} else {
		const encodedTag = encodeURIComponent(tag);
		const response = await fetchJson(
			`${GITHUB_API_ROOT}/repos/${repository}/releases/tags/${encodedTag}`,
			token,
			fetchImpl,
			{ wallTimeoutMs, inactivityTimeoutMs },
		);
		release = response.data;
	}

	if (!release || typeof release !== "object" || Array.isArray(release) || release.tag_name !== tag) {
		throw new Error("GitHub returned release metadata for the wrong tag.");
	}
	if (release.prerelease !== false) throw new Error("Release must not be a prerelease.");
	if (release.draft === true && !allowDraft) {
		throw new Error("Draft release verification requires allow_draft=true.");
	}
	if (typeof release.draft !== "boolean") throw new Error("Release draft state is missing.");
	return release;
}

export function expectedReleaseAssetsForTag(tag) {
	return releaseAssetContractForTag(tag) === "current-nine"
		? EXPECTED_RELEASE_ASSETS_CURRENT
		: EXPECTED_RELEASE_ASSETS_LEGACY_EIGHT;
}

export function indexExpectedReleaseAssets(release, expectedAssetNames = EXPECTED_RELEASE_ASSETS_CURRENT) {
	if (!Array.isArray(release?.assets)) throw new Error("Release asset metadata is missing.");
	const expectedNames = [...expectedAssetNames].sort();
	const assets = new Map();
	for (const asset of release.assets) {
		const name = asset?.name;
		if (typeof name !== "string" || assets.has(name)) {
			throw new Error(`Duplicate or invalid release asset metadata: ${String(name)}`);
		}
		if (!expectedNames.includes(name)) {
			throw new Error(`Unexpected release asset: ${name}`);
		}
		if (!Number.isSafeInteger(asset.id) || asset.id <= 0) throw new Error(`Invalid GitHub asset ID: ${name}`);
		if (!Number.isSafeInteger(asset.size) || asset.size < 0 || asset.size > MAX_ASSET_BYTES) {
			throw new Error(`Invalid or oversized GitHub asset: ${name}`);
		}
		if (asset.state !== "uploaded") throw new Error(`Release asset is not uploaded: ${name}`);
		if (!SHA256_DIGEST_PATTERN.test(asset.digest ?? "")) {
			throw new Error(`Asset lacks a valid GitHub SHA-256 digest: ${name}`);
		}
		assets.set(name, asset);
	}
	const actualNames = [...assets.keys()].sort();
	if (!arraysEqual(actualNames, expectedNames)) {
		throw new Error("Release metadata asset set does not exactly match the requested contract.");
	}
	return assets;
}

function isRedirect(status) {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function assertTrustedUnsignedDownload(url) {
	const parsed = new URL(url);
	const trustedHost = parsed.hostname === "github.com" || parsed.hostname.endsWith(".githubusercontent.com");
	if (parsed.protocol !== "https:" || !trustedHost) {
		throw new Error("GitHub asset API redirected outside the trusted download hosts.");
	}
	return parsed.href;
}

async function fetchAssetResponse({ asset, fetchImpl, repository, token, wallTimeoutMs }) {
	const endpoint = `${GITHUB_API_ROOT}/repos/${repository}/releases/assets/${asset.id}`;
	let response = await fetchWithTimeout(
		fetchImpl,
		endpoint,
		{ headers: apiHeaders(token, "application/octet-stream"), redirect: "manual" },
		{ label: `GitHub asset ${asset.name}`, wallTimeoutMs },
	);
	if (isRedirect(response.status)) {
		const location = response.headers.get("location");
		if (!location) throw new Error(`GitHub asset redirect is missing Location: ${asset.name}`);
		response = await fetchWithTimeout(
			fetchImpl,
			assertTrustedUnsignedDownload(new URL(location, endpoint)),
			{
				headers: {
					Accept: "application/octet-stream",
					"User-Agent": "magenta-public-release-verifier",
				},
				redirect: "follow",
			},
			{ label: `GitHub asset ${asset.name}`, wallTimeoutMs },
		);
	}
	if (!response.ok || !response.body) {
		throw new Error(`GitHub asset download failed (${response.status}): ${asset.name}`);
	}
	return response;
}

async function writeResponseAtomically(
	response,
	path,
	{
		label = "Release asset",
		maxBytes = MAX_ASSET_BYTES,
		wallTimeoutMs = ASSET_WALL_TIMEOUT_MS,
		inactivityTimeoutMs = ASSET_INACTIVITY_TIMEOUT_MS,
	} = {},
) {
	const contentLength = response.headers.get("content-length");
	if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > maxBytes) {
		throw new Error(`${label} exceeds the ${maxBytes}-byte limit.`);
	}
	if (!response.body) throw new Error(`${label} returned no body.`);
	const temporaryPath = `${path}.partial`;
	const controller = new AbortController();
	let wallTimer;
	let inactivityTimer;
	let downloadedBytes = 0;
	const resetInactivity = () => {
		if (inactivityTimer) clearTimeout(inactivityTimer);
		inactivityTimer = setTimeout(
			() => controller.abort(timeoutError(label, "idle", inactivityTimeoutMs)),
			inactivityTimeoutMs,
		);
	};
	const limiter = new Transform({
		transform(chunk, encoding, callback) {
			resetInactivity();
			const chunkBytes = typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
			downloadedBytes += chunkBytes;
			if (downloadedBytes > maxBytes) {
				callback(new Error(`${label} exceeds the ${maxBytes}-byte limit.`));
				return;
			}
			callback(null, chunk);
		},
		flush(callback) {
			if (inactivityTimer) clearTimeout(inactivityTimer);
			inactivityTimer = undefined;
			callback();
		},
	});
	try {
		wallTimer = setTimeout(() => controller.abort(timeoutError(label, "wall", wallTimeoutMs)), wallTimeoutMs);
		resetInactivity();
		await pipeline(
			Readable.fromWeb(response.body),
			limiter,
			createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
			{ signal: controller.signal },
		);
		renameSync(temporaryPath, path);
	} catch (error) {
		rmSync(temporaryPath, { force: true });
		if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
		throw error;
	} finally {
		if (wallTimer) clearTimeout(wallTimer);
		if (inactivityTimer) clearTimeout(inactivityTimer);
	}
}

export async function downloadReleaseAssets({
	expectedAssetNames = EXPECTED_RELEASE_ASSETS_CURRENT,
	fetchImpl = fetch,
	release,
	releaseDir,
	repository,
	token,
	wallTimeoutMs = ASSET_WALL_TIMEOUT_MS,
	inactivityTimeoutMs = ASSET_INACTIVITY_TIMEOUT_MS,
	maxAssetBytes = MAX_ASSET_BYTES,
}) {
	assertRepository(repository);
	const expectedNames = [...expectedAssetNames].sort();
	const assets = indexExpectedReleaseAssets(release, expectedNames);
	const root = resolve(releaseDir);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const rootStat = lstatSync(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Release directory must be a real directory.");
	if (typeof process.getuid === "function" && rootStat.uid !== process.getuid()) {
		throw new Error("Release directory must be owned by the verifier user.");
	}
	if (process.platform !== "win32" && (rootStat.mode & 0o077) !== 0) {
		throw new Error("Release directory must have private permissions.");
	}
	if (readdirSync(root).length !== 0) throw new Error("Release directory must be empty before downloading assets.");

	for (const name of expectedNames) {
		const asset = assets.get(name);
		const path = join(root, name);
		if (asset.size > maxAssetBytes) throw new Error(`Release asset ${name} exceeds the ${maxAssetBytes}-byte limit.`);
		const response = await fetchAssetResponse({ asset, fetchImpl, repository, token, wallTimeoutMs });
		await writeResponseAtomically(response, path, {
			label: `Release asset ${name}`,
			maxBytes: Math.min(maxAssetBytes, asset.size),
			wallTimeoutMs,
			inactivityTimeoutMs,
		});
		if (statSync(path).size !== asset.size) throw new Error(`Asset size mismatch: ${name}`);
		const actualDigest = await sha256File(path);
		if (`sha256:${actualDigest}` !== asset.digest) throw new Error(`GitHub digest mismatch: ${name}`);
	}

	const actualNames = readdirSync(root).sort();
	if (!arraysEqual(actualNames, expectedNames)) {
		throw new Error("Downloaded asset set does not exactly match the requested contract.");
	}
	return root;
}

function runSystemCommand(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		env: options.env ?? process.env,
		maxBuffer: 16 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
		timeout: options.timeoutMs ?? SYSTEM_COMMAND_TIMEOUT_MS,
	});
	return { error: result.error, status: result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

export function extractArchiveMemberToFile({ archivePath, memberPath, outputPath }) {
	const listing = spawnSync("/usr/bin/tar", ["-tzf", archivePath, memberPath], {
		encoding: "utf8",
		env: process.env,
		maxBuffer: 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (listing.error || listing.status !== 0) {
		throw new Error(
			`Resource archive member listing failed: ${String(listing.stderr ?? listing.error?.message ?? "unknown error").trim()}`,
		);
	}
	const members = String(listing.stdout ?? "")
		.split(/\r?\n/u)
		.filter(Boolean);
	if (members.length !== 1 || members[0] !== memberPath) {
		throw new Error("Resource archive does not contain exactly one canonical macOS clipboard payload.");
	}

	let output;
	try {
		output = openSync(outputPath, "wx", 0o600);
		const extraction = spawnSync("/usr/bin/tar", ["-xOzf", archivePath, memberPath], {
			env: process.env,
			maxBuffer: 1024 * 1024,
			stdio: ["ignore", output, "pipe"],
		});
		if (extraction.error || extraction.status !== 0) {
			throw new Error(
				`Resource archive member extraction failed: ${String(extraction.stderr ?? extraction.error?.message ?? "unknown error").trim()}`,
			);
		}
	} catch (error) {
		rmSync(outputPath, { force: true });
		throw error;
	} finally {
		if (output !== undefined) closeSync(output);
	}
	const extracted = lstatSync(outputPath);
	if (!extracted.isFile() || extracted.isSymbolicLink() || extracted.size === 0) {
		throw new Error("Extracted macOS clipboard payload must be a non-empty regular file.");
	}
}

function runChecked(runCommand, command, args, label, options) {
	const result = runCommand(command, args, options);
	if (result?.error || result?.status !== 0) {
		throw new Error(`${label} failed: ${String(result?.stderr ?? result?.error?.message ?? "unknown error").trim()}`);
	}
	return result;
}

function verifyMacosArchitectures({ architectures: expectedArchitectures, path, runCommand = runSystemCommand }) {
	const name = basename(path);
	assertRegularFile(path, `macOS payload ${name}`);
	const inspection = runChecked(
		runCommand,
		"/usr/bin/lipo",
		["-archs", path],
		`Architecture inspection for ${name}`,
	);
	const actualArchitectures = `${inspection.stdout ?? ""}\n${inspection.stderr ?? ""}`
		.trim()
		.split(/\s+/u)
		.filter(Boolean);
	const normalizedExpectedArchitectures = [...expectedArchitectures].sort();
	if (!arraysEqual(actualArchitectures.sort(), normalizedExpectedArchitectures)) {
		throw new Error(`${name} architecture mismatch: ${actualArchitectures.join(" ") || "missing"}.`);
	}
}

export function verifyMacosBinary({ architecture, path, runCommand = runSystemCommand }) {
	const lipoArchitecture = normalizeMacosArchitecture(architecture) === "x64" ? "x86_64" : "arm64";
	verifyMacosArchitectures({ architectures: [lipoArchitecture], path, runCommand });
}

export function verifyMacosClipboardPayload({ path, runCommand = runSystemCommand, runtimeEnv = process.env }) {
	verifyMacosArchitectures({
		architectures: MACOS_CLIPBOARD_PAYLOAD.architectures,
		path,
		runCommand,
	});
	runChecked(
		runCommand,
		process.execPath,
		[
			"-e",
			'const binding = require(process.argv[1]); if (typeof binding.getText !== "function") process.exit(1);',
			path,
		],
		"Native clipboard binding load",
		{ env: runtimeEnv },
	);
}

function assertExactObjectKeys(value, expectedKeys, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	const actual = Object.keys(value).sort();
	const expected = [...expectedKeys].sort();
	if (!arraysEqual(actual, expected)) throw new Error(`${label} has an unsupported schema.`);
}

function pathIsWithin(parent, candidate) {
	const fromParent = relative(parent, candidate);
	return fromParent !== "" && fromParent !== ".." && !fromParent.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(fromParent);
}

export function normalizeMacosArchitecture(value) {
	if (value === "arm64") return "arm64";
	if (value === "x64" || value === "x86_64") return "x64";
	throw new Error(`Unsupported native macOS architecture: ${value ?? "(missing)"}.`);
}

export function verifyMacosRuntimeHelperProof({
	architecture,
	cacheRoot,
	proof,
	runCommand = runSystemCommand,
	runtimeEnv = process.env,
}) {
	const normalizedArchitecture = normalizeMacosArchitecture(architecture);
	let parsedProof = proof;
	if (typeof proof === "string") {
		try {
			parsedProof = JSON.parse(proof);
		} catch {
			throw new Error("Runtime helper proof is not valid JSON.");
		}
	}
	assertExactObjectKeys(parsedProof, ["architecture", "helpers", "platform", "schema"], "Runtime helper proof");
	if (
		parsedProof.schema !== HELPER_PROOF_SCHEMA ||
		parsedProof.platform !== "darwin" ||
		parsedProof.architecture !== normalizedArchitecture
	) {
		throw new Error("Runtime helper proof identity does not match the native verifier.");
	}
	if (!Array.isArray(parsedProof.helpers) || parsedProof.helpers.length !== 3) {
		throw new Error("Runtime helper proof must contain exactly three helpers.");
	}
	const contracts = new Map(
		MACOS_EMBEDDED_PAYLOADS.filter((entry) => entry.architecture === normalizedArchitecture).map((entry) => [
			entry.kind,
			entry,
		]),
	);
	if (contracts.size !== 3) throw new Error("Runtime helper contract is incomplete for this architecture.");
	const canonicalCacheRoot = realpathSync(resolve(cacheRoot));
	const verified = [];
	const seen = new Set();
	for (const helper of parsedProof.helpers) {
		assertExactObjectKeys(helper, ["kind", "path", "sha256", "size"], "Runtime helper entry");
		const contract = contracts.get(helper.kind);
		if (!contract || seen.has(helper.kind)) throw new Error(`Unexpected or duplicate runtime helper: ${helper.kind}.`);
		seen.add(helper.kind);
		if (!isAbsolute(helper.path)) throw new Error(`Runtime helper path is not absolute: ${helper.kind}.`);
		const inputStats = lstatSync(helper.path);
		if (!inputStats.isFile() || inputStats.isSymbolicLink()) {
			throw new Error(`Runtime helper is not a regular file: ${helper.kind}.`);
		}
		const canonicalPath = realpathSync(helper.path);
		if (!pathIsWithin(canonicalCacheRoot, canonicalPath)) {
			throw new Error(`Runtime helper escaped the isolated proof cache: ${helper.kind}.`);
		}
		const actualSha256 = sha256FileSync(canonicalPath);
		if (!/^[0-9a-f]{64}$/u.test(helper.sha256) || helper.sha256 !== actualSha256) {
			throw new Error(`Runtime helper bytes do not match their proof: ${helper.kind}.`);
		}
		if (!Number.isSafeInteger(helper.size) || helper.size <= 0 || helper.size !== inputStats.size) {
			throw new Error(`Runtime helper size does not match its proof: ${helper.kind}.`);
		}
		verifyMacosBinary({
			architecture: normalizedArchitecture,
			path: canonicalPath,
			runCommand,
		});
		runChecked(runCommand, canonicalPath, ["--help"], `Native startup for ${helper.kind}`, { env: runtimeEnv });
		verified.push({ kind: helper.kind, path: canonicalPath, sha256: actualSha256 });
	}
	if (seen.size !== contracts.size) throw new Error("Runtime helper proof is incomplete.");
	return verified.sort((left, right) => left.kind.localeCompare(right.kind));
}

export function materializeAndVerifyMacosHelpers({
	architecture,
	expectedVersion,
	releaseDir,
	runCommand = runSystemCommand,
	temporaryParent = tmpdir(),
}) {
	const normalizedArchitecture = normalizeMacosArchitecture(architecture);
	const binary = MACOS_OUTER_BINARIES.find(
		(candidate) => normalizeMacosArchitecture(candidate.architecture) === normalizedArchitecture,
	);
	if (!binary) throw new Error(`No release binary matches native architecture ${normalizedArchitecture}.`);
	const proofRoot = mkdtempSync(join(resolve(temporaryParent), "magenta-cli-helper-proof-"));
	try {
		const home = join(proofRoot, "home");
		const temporaryDirectory = join(proofRoot, "tmp");
		mkdirSync(home, { mode: 0o700 });
		mkdirSync(temporaryDirectory, { mode: 0o700 });
		const binaryPath = join(resolve(releaseDir), binary.name);
		const runtimeEnvironment = {
			HOME: home,
			LANG: "C",
			LC_ALL: "C",
			PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
			TMPDIR: temporaryDirectory,
		};
		const proofEnvironment = { ...runtimeEnvironment, MAGENTA_RELEASE_HELPER_PROOF: "1" };
		const versionResult = runCommand(binaryPath, ["--version"], {
			env: runtimeEnvironment,
			timeoutMs: HELPER_PROOF_TIMEOUT_MS,
		});
		if (versionResult?.error || versionResult?.status !== 0) {
			throw new Error(
				`Native Magenta --version failed: ${String(versionResult?.stderr ?? versionResult?.error?.message ?? "unknown error").trim()}`,
			);
		}
		const reportedVersion = String(versionResult.stdout ?? "").trim();
		if (reportedVersion !== expectedVersion) {
			throw new Error(`Native Magenta version mismatch: expected ${expectedVersion}, got ${reportedVersion || "missing"}.`);
		}
		runChecked(runCommand, binaryPath, ["--help"], "Native Magenta --help", {
			env: runtimeEnvironment,
			timeoutMs: HELPER_PROOF_TIMEOUT_MS,
		});
		const result = runCommand(binaryPath, ["_release-helper-proof"], {
			env: proofEnvironment,
			timeoutMs: HELPER_PROOF_TIMEOUT_MS,
		});
		if (result?.error || result?.status !== 0) {
			throw new Error(
				`Native runtime helper materialization failed: ${String(result?.stderr ?? result?.error?.message ?? "unknown error").trim()}`,
			);
		}
		return verifyMacosRuntimeHelperProof({
			architecture: normalizedArchitecture,
			cacheRoot: join(home, ".magenta", "cache"),
			proof: String(result.stdout ?? "").trim(),
			runCommand,
			runtimeEnv: runtimeEnvironment,
		});
	} finally {
		rmSync(proofRoot, { force: true, recursive: true });
	}
}

export function verifyDownloadedMacosRelease({
	expectedVersion,
	extractArchiveMember = extractArchiveMemberToFile,
	nativeArchitecture = process.arch,
	releaseDir,
	runCommand = runSystemCommand,
	temporaryParent = tmpdir(),
}) {
	if (process.platform !== "darwin" && runCommand === runSystemCommand) {
		throw new Error("Native macOS release verification must run on a macOS host.");
	}
	const normalizedNativeArchitecture = normalizeMacosArchitecture(nativeArchitecture);
	if (runCommand === runSystemCommand && normalizedNativeArchitecture !== normalizeMacosArchitecture(process.arch)) {
		throw new Error("Requested native architecture does not match the macOS verifier host.");
	}
	if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
		throw new Error("GitHub tokens must be removed before downloaded assets are inspected.");
	}
	for (const binary of MACOS_OUTER_BINARIES) {
		verifyMacosBinary({
			architecture: binary.architecture,
			path: join(resolve(releaseDir), binary.name),
			runCommand,
		});
	}
	const extractionRoot = mkdtempSync(join(resolve(temporaryParent), "magenta-cli-macos-native-"));
	try {
		const home = join(extractionRoot, "home");
		const temporaryDirectory = join(extractionRoot, "tmp");
		mkdirSync(home, { mode: 0o700 });
		mkdirSync(temporaryDirectory, { mode: 0o700 });
		const clipboardPath = join(extractionRoot, "clipboard.darwin-universal.node");
		extractArchiveMember({
			archivePath: join(resolve(releaseDir), "magenta-resources-universal.tar.gz"),
			memberPath: MACOS_CLIPBOARD_PAYLOAD.resourcePath,
			outputPath: clipboardPath,
		});
		verifyMacosClipboardPayload({
			path: clipboardPath,
			runCommand,
			runtimeEnv: {
				HOME: home,
				LANG: "C",
				LC_ALL: "C",
				PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
				TMPDIR: temporaryDirectory,
			},
		});
	} finally {
		rmSync(extractionRoot, { force: true, recursive: true });
	}
	const nativeBinary = MACOS_OUTER_BINARIES.find(
		(candidate) => normalizeMacosArchitecture(candidate.architecture) === normalizedNativeArchitecture,
	);
	if (!nativeBinary) throw new Error(`No release binary matches native architecture ${normalizedNativeArchitecture}.`);
	chmodSync(join(resolve(releaseDir), nativeBinary.name), 0o700);
	const helpers = materializeAndVerifyMacosHelpers({
		architecture: normalizedNativeArchitecture,
		expectedVersion,
		releaseDir,
		runCommand,
		temporaryParent,
	});
	return { nativeHelpers: helpers.length, nativePayloads: MACOS_OUTER_BINARIES.length + 1 + helpers.length };
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
	const supported = new Set([
		"--allow-draft",
		"--native-architecture",
		"--release-dir",
		"--release-tag",
		"--repository",
	]);
	for (const flag of values.keys()) if (!supported.has(flag)) throw new Error(`Unknown argument: ${flag}`);
	for (const flag of supported) if (!values.has(flag)) throw new Error(`${flag} is required.`);
	const allowDraftValue = values.get("--allow-draft");
	if (allowDraftValue !== "true" && allowDraftValue !== "false") {
		throw new Error("--allow-draft must be true or false.");
	}
	return {
		allowDraft: allowDraftValue === "true",
		nativeArchitecture: normalizeMacosArchitecture(values.get("--native-architecture")),
		releaseDir: values.get("--release-dir"),
		repository: values.get("--repository"),
		tag: values.get("--release-tag"),
	};
}

async function main(args) {
	const options = parseArguments(args);
	const assetContract = releaseAssetContractForTag(options.tag);
	if (assetContract === "legacy-eight") {
		delete process.env.GH_TOKEN;
		delete process.env.GITHUB_TOKEN;
		process.stdout.write(`verified_tag=${options.tag}\nasset_contract=legacy-eight\nmacos_verification=not-required\n`);
		return;
	}

	let token = process.env.GH_TOKEN;
	try {
		const release = await fetchReleaseMetadata({ ...options, token });
		await downloadReleaseAssets({ ...options, release, token });
		await verifySourceCommitBinding({
			releaseDir: options.releaseDir,
			releaseTag: options.tag,
			repository: "Minions-Land/Magenta",
		});
		options.draft = release.draft;
	} finally {
		delete process.env.GH_TOKEN;
		delete process.env.GITHUB_TOKEN;
		token = undefined;
	}

	const manifest = await verifyReleaseChecksumManifest({ releaseDir: options.releaseDir });
	const result = verifyDownloadedMacosRelease({ ...options, expectedVersion: parseReleaseTag(options.tag).version });
	process.stdout.write(`verified_tag=${options.tag}\n`);
	process.stdout.write(`verified_draft=${String(options.draft)}\n`);
	process.stdout.write("asset_contract=current-nine\n");
	process.stdout.write(`assets=${EXPECTED_RELEASE_ASSETS_CURRENT.length}\n`);
	process.stdout.write(`source_commit=${manifest.sourceCommit}\n`);
	process.stdout.write(`manifest_sha256=${manifest.manifestSha256}\n`);
	process.stdout.write("github_digests=ok\nmanifest=ok\nmacos_apple_signing=not-required\n");
	process.stdout.write(`macos_native_payloads=${result.nativePayloads}\nmacos_native_helpers=${result.nativeHelpers}\n`);
	process.stdout.write("macos_native_startup=ok\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main(process.argv.slice(2)).catch((error) => {
		delete process.env.GH_TOKEN;
		delete process.env.GITHUB_TOKEN;
		process.stderr.write(`macOS published release verification failed: ${error.message}\n`);
		process.exitCode = 1;
	});
}
