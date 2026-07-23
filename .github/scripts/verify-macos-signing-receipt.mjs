#!/usr/bin/env node

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CHECKSUMMED_ASSETS_V0_0_30 = [
	"magenta-macos-arm64",
	"magenta-macos-x64",
	"magenta-linux-x64",
	"magenta-windows-x64.exe",
	"magenta-resources-universal.tar.gz",
	"install.sh",
	"install.ps1",
	"SOURCE_COMMIT",
];

const RECEIPT_NAME = "macos-signing-receipt.json";
const RECEIPT_SCHEMA = "magenta.macos-signing-receipt.v1";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SOURCE_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/u;
const TRUST_SCHEMA = "magenta.macos-release-trust.v1";
const TRUST_PATH = fileURLToPath(new URL("../macos-release-trust.json", import.meta.url));
const NOTARY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const RECEIPT_KEYS = [
	"assets",
	"certificate",
	"createdAt",
	"embeddedChecksumReceipts",
	"expectedAssetNames",
	"finalManifestSha256",
	"initialEmbeddedChecksumReceipts",
	"initialManifestSha256",
	"notarization",
	"payloads",
	"schema",
	"sourceCommit",
];
const EMBEDDED_KINDS = ["process-tools", "fd", "rg"];
export const MACOS_EMBEDDED_PAYLOADS = Object.freeze([
	{
		architecture: "arm64",
		identifier: "land.minions.magenta.process-tools",
		kind: "process-tools",
		relativePath: "process-tools/prebuilt/magenta-process-tools-macos-arm64",
	},
	{
		architecture: "arm64",
		identifier: "land.minions.magenta.fd",
		kind: "fd",
		relativePath: "fd/prebuilt/fd-macos-arm64",
	},
	{
		architecture: "arm64",
		identifier: "land.minions.magenta.rg",
		kind: "rg",
		relativePath: "rg/prebuilt/rg-macos-arm64",
	},
	{
		architecture: "x64",
		identifier: "land.minions.magenta.process-tools",
		kind: "process-tools",
		relativePath: "process-tools/prebuilt/magenta-process-tools-macos-x64",
	},
	{
		architecture: "x64",
		identifier: "land.minions.magenta.fd",
		kind: "fd",
		relativePath: "fd/prebuilt/fd-macos-x64",
	},
	{
		architecture: "x64",
		identifier: "land.minions.magenta.rg",
		kind: "rg",
		relativePath: "rg/prebuilt/rg-macos-x64",
	},
]);
const EMBEDDED_PAYLOAD_PATHS = MACOS_EMBEDDED_PAYLOADS.map(({ relativePath }) => relativePath);
const OUTER_PAYLOADS = ["magenta-macos-arm64", "magenta-macos-x64"];

function assertRegularFile(path, label) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
}

function assertExactObjectKeys(value, expectedKeys, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	const actual = Object.keys(value).sort();
	const expected = [...expectedKeys].sort();
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`${label} has an unsupported schema.`);
	}
}

function assertSha256(value, label) {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		throw new Error(`${label} must be a lowercase SHA-256 digest.`);
	}
	return value;
}

function assertHashObject(value, expectedKeys, label) {
	assertExactObjectKeys(value, expectedKeys, label);
	for (const key of expectedKeys) assertSha256(value[key], `${label} entry ${key}`);
}

function assertRegularFileStat(fileStat, label) {
	if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error(`${label} must be a regular file.`);
	if (fileStat.nlink !== 1n) throw new Error(`${label} must have exactly one hard link; its link count changed.`);
}

function fileIdentity(fileStat) {
	return [
		fileStat.dev,
		fileStat.ino,
		fileStat.mode,
		fileStat.uid,
		fileStat.gid,
		fileStat.nlink,
		fileStat.size,
		fileStat.mtimeNs,
		fileStat.ctimeNs,
	]
		.map((value) => String(value))
		.join(":");
}

/** @internal Exported for bounded-hash regression tests. */
export function sha256File(path, { testAfterChunk } = {}) {
	const label = `Release asset ${path}`;
	const before = lstatSync(path, { bigint: true });
	assertRegularFileStat(before, label);
	const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
	const descriptor = openSync(path, flags);
	try {
		const opened = fstatSync(descriptor, { bigint: true });
		assertRegularFileStat(opened, label);
		if (fileIdentity(opened) !== fileIdentity(before)) throw new Error(`${label} changed while it was opened.`);
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(1024 * 1024);
		let total = 0n;
		while (true) {
			const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
			total += BigInt(bytesRead);
			testAfterChunk?.(Number(total));
		}
		const after = fstatSync(descriptor, { bigint: true });
		assertRegularFileStat(after, label);
		if (total !== after.size || fileIdentity(after) !== fileIdentity(opened)) {
			throw new Error(`${label} changed while it was hashed.`);
		}
		const finalPath = lstatSync(path, { bigint: true });
		assertRegularFileStat(finalPath, label);
		if (fileIdentity(finalPath) !== fileIdentity(after)) throw new Error(`${label} was replaced while it was hashed.`);
		return hash.digest("hex");
	} finally {
		closeSync(descriptor);
	}
}

function parseChecksumManifest(path) {
	const entries = new Map();
	for (const [index, line] of readFileSync(path, "utf8").split(/\r?\n/u).entries()) {
		if (!line) continue;
		const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(line);
		if (!match) throw new Error(`Invalid SHA256SUMS line ${index + 1}.`);
		const [, hash, name] = match;
		if (entries.has(name)) throw new Error(`Duplicate SHA256SUMS entry: ${name}`);
		entries.set(name, hash);
	}
	assertExactObjectKeys(Object.fromEntries(entries), CHECKSUMMED_ASSETS_V0_0_30, "SHA256SUMS entries");
	return entries;
}

function parseReceipt(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error("macOS signing receipt is not valid JSON.");
	}
}

export function readRepositoryMacosTeamId(path = TRUST_PATH) {
	let trust;
	try {
		trust = JSON.parse(readFileSync(resolve(path), "utf8"));
	} catch {
		throw new Error("Repository macOS release trust is not valid JSON.");
	}
	assertExactObjectKeys(trust, ["appleTeamId", "schema"], "Repository macOS release trust");
	if (trust.schema !== TRUST_SCHEMA || !TEAM_ID_PATTERN.test(trust.appleTeamId ?? "")) {
		throw new Error("Repository macOS release trust must contain one configured Apple Team ID.");
	}
	return trust.appleTeamId;
}

export function verifyMacosSigningReceipt({ expectedTeamId = readRepositoryMacosTeamId(), releaseDir }) {
	if (!TEAM_ID_PATTERN.test(expectedTeamId ?? "")) {
		throw new Error("Repository macOS release trust must contain one configured Apple Team ID.");
	}

	const root = resolve(releaseDir);
	const manifestPath = join(root, "SHA256SUMS");
	const receiptPath = join(root, RECEIPT_NAME);
	assertRegularFile(manifestPath, "SHA256SUMS");
	assertRegularFile(receiptPath, "macOS signing receipt");

	const manifest = parseChecksumManifest(manifestPath);
	for (const [name, expectedHash] of manifest) {
		const path = join(root, name);
		assertRegularFile(path, `Release asset ${name}`);
		if (sha256File(path) !== expectedHash) throw new Error(`SHA256SUMS asset hash mismatch: ${name}`);
	}

	const sourceCommit = readFileSync(join(root, "SOURCE_COMMIT"), "utf8").trim().toLowerCase();
	if (!SOURCE_COMMIT_PATTERN.test(sourceCommit)) throw new Error("SOURCE_COMMIT is not a full Git object ID.");

	const receipt = parseReceipt(receiptPath);
	assertExactObjectKeys(receipt, RECEIPT_KEYS, "macOS signing receipt");
	if (receipt.schema !== RECEIPT_SCHEMA) throw new Error("macOS signing receipt has an unsupported schema.");
	if (receipt.sourceCommit !== sourceCommit) throw new Error("macOS signing receipt SOURCE_COMMIT mismatch.");

	const finalManifestSha256 = sha256File(manifestPath);
	if (assertSha256(receipt.finalManifestSha256, "Final manifest digest") !== finalManifestSha256) {
		throw new Error("macOS signing receipt final manifest digest mismatch.");
	}
	if (assertSha256(receipt.initialManifestSha256, "Initial manifest digest") === finalManifestSha256) {
		throw new Error("macOS signing receipt does not prove a signed manifest transition.");
	}

	if (JSON.stringify(receipt.expectedAssetNames) !== JSON.stringify(CHECKSUMMED_ASSETS_V0_0_30)) {
		throw new Error("macOS signing receipt asset contract mismatch.");
	}
	assertHashObject(receipt.assets, CHECKSUMMED_ASSETS_V0_0_30, "macOS signing receipt assets");
	for (const name of CHECKSUMMED_ASSETS_V0_0_30) {
		if (receipt.assets[name] !== manifest.get(name)) {
			throw new Error(`macOS signing receipt asset hash mismatch: ${name}`);
		}
	}

	assertExactObjectKeys(receipt.certificate, ["sha256", "teamId"], "Signing certificate");
	assertSha256(receipt.certificate.sha256, "Signing certificate digest");
	if (receipt.certificate.teamId !== expectedTeamId) {
		throw new Error("macOS signing receipt certificate Team ID does not match repository trust.");
	}

	if (!Array.isArray(receipt.notarization) || receipt.notarization.length !== 2) {
		throw new Error("macOS signing receipt must contain two notarization records.");
	}
	const notarizedArchitectures = new Set();
	for (const record of receipt.notarization) {
		assertExactObjectKeys(record, ["architecture", "id", "logSha256", "status"], "Notarization record");
		if (
			(record.architecture !== "arm64" && record.architecture !== "x64") ||
			notarizedArchitectures.has(record.architecture) ||
			record.status !== "Accepted" ||
			!NOTARY_ID_PATTERN.test(record.id ?? "")
		) {
			throw new Error("macOS signing receipt contains invalid notarization evidence.");
		}
		assertSha256(record.logSha256, "Notarization log digest");
		notarizedArchitectures.add(record.architecture);
	}

	if (typeof receipt.createdAt !== "string") throw new Error("macOS signing receipt timestamp is invalid.");
	const createdAt = new Date(receipt.createdAt);
	if (Number.isNaN(createdAt.valueOf()) || createdAt.toISOString() !== receipt.createdAt) {
		throw new Error("macOS signing receipt timestamp is invalid.");
	}

	assertHashObject(
		receipt.initialEmbeddedChecksumReceipts,
		EMBEDDED_KINDS,
		"Initial embedded checksum receipts",
	);
	assertHashObject(receipt.embeddedChecksumReceipts, EMBEDDED_KINDS, "Final embedded checksum receipts");
	for (const kind of EMBEDDED_KINDS) {
		if (receipt.initialEmbeddedChecksumReceipts[kind] === receipt.embeddedChecksumReceipts[kind]) {
			throw new Error(`Embedded checksum receipt did not change during signing: ${kind}`);
		}
	}
	assertExactObjectKeys(receipt.payloads, ["clipboard", "embedded", "outer"], "Signed payload evidence");
	assertExactObjectKeys(
		receipt.payloads.clipboard,
		["afterSha256", "beforeSha256"],
		"Clipboard payload evidence",
	);
	const clipboardBefore = assertSha256(receipt.payloads.clipboard.beforeSha256, "Unsigned clipboard digest");
	const clipboardAfter = assertSha256(receipt.payloads.clipboard.afterSha256, "Signed clipboard digest");
	if (clipboardBefore === clipboardAfter) throw new Error("Clipboard signing did not change the payload digest.");
	assertHashObject(receipt.payloads.embedded, EMBEDDED_PAYLOAD_PATHS, "Embedded payload evidence");
	assertHashObject(receipt.payloads.outer, OUTER_PAYLOADS, "Outer payload evidence");
	for (const name of OUTER_PAYLOADS) {
		if (receipt.payloads.outer[name] !== receipt.assets[name]) {
			throw new Error(`Outer payload evidence does not match the release asset: ${name}`);
		}
	}

	return {
		clipboardSha256: clipboardAfter,
		embeddedPayloadSha256: { ...receipt.payloads.embedded },
		finalManifestSha256,
		sourceCommit,
		teamId: expectedTeamId,
	};
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
	for (const flag of values.keys()) if (flag !== "--release-dir") throw new Error(`Unknown argument: ${flag}`);
	const releaseDir = values.get("--release-dir");
	if (!releaseDir) throw new Error("--release-dir is required.");
	return { releaseDir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	try {
		const result = verifyMacosSigningReceipt(parseArguments(process.argv.slice(2)));
		process.stdout.write(`macos_receipt_team_id=${result.teamId}\n`);
		process.stdout.write(`macos_receipt_manifest_sha256=${result.finalManifestSha256}\n`);
	} catch (error) {
		process.stderr.write(`macOS signing receipt verification failed: ${error.message}\n`);
		process.exitCode = 1;
	}
}
