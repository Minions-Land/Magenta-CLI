import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, linkSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	CHECKSUMMED_ASSETS_V0_0_30,
	readRepositoryMacosTeamId,
	sha256File,
	verifyMacosSigningReceipt,
} from "./verify-macos-signing-receipt.mjs";

const TEAM_ID = "ABCDE12345";
const SOURCE_COMMIT = "a".repeat(40);

function sha256(content) {
	return createHash("sha256").update(content).digest("hex");
}

function hashProof(keys, phase = "proof") {
	return Object.fromEntries(keys.map((key) => [key, sha256(`${phase}:${key}`)]));
}

function createFixture() {
	const releaseDir = mkdtempSync(join(tmpdir(), "magenta-cli-receipt-"));
	const assetHashes = {};
	for (const name of CHECKSUMMED_ASSETS_V0_0_30) {
		const content = name === "SOURCE_COMMIT" ? `${SOURCE_COMMIT}\n` : `release:${name}\n`;
		writeFileSync(join(releaseDir, name), content);
		assetHashes[name] = sha256(content);
	}
	const manifest = `${CHECKSUMMED_ASSETS_V0_0_30.map((name) => `${assetHashes[name]}  ${name}`).join("\n")}\n`;
	writeFileSync(join(releaseDir, "SHA256SUMS"), manifest);

	const embeddedPayloads = [
		"process-tools/prebuilt/magenta-process-tools-macos-arm64",
		"fd/prebuilt/fd-macos-arm64",
		"rg/prebuilt/rg-macos-arm64",
		"process-tools/prebuilt/magenta-process-tools-macos-x64",
		"fd/prebuilt/fd-macos-x64",
		"rg/prebuilt/rg-macos-x64",
	];
	const receipt = {
		assets: assetHashes,
		certificate: { sha256: sha256("certificate"), teamId: TEAM_ID },
		createdAt: "2026-07-23T00:00:00.000Z",
		embeddedChecksumReceipts: hashProof(["process-tools", "fd", "rg"], "signed"),
		expectedAssetNames: [...CHECKSUMMED_ASSETS_V0_0_30],
		finalManifestSha256: sha256(manifest),
		initialEmbeddedChecksumReceipts: hashProof(["process-tools", "fd", "rg"], "unsigned"),
		initialManifestSha256: sha256("unsigned manifest"),
		notarization: [
			{
				architecture: "arm64",
				id: "12345678-1234-1234-1234-123456789abc",
				logSha256: sha256("arm64 notary log"),
				status: "Accepted",
			},
			{
				architecture: "x64",
				id: "abcdefab-cdef-abcd-efab-cdefabcdefab",
				logSha256: sha256("x64 notary log"),
				status: "Accepted",
			},
		],
		payloads: {
			clipboard: { afterSha256: sha256("signed clipboard"), beforeSha256: sha256("unsigned clipboard") },
			embedded: hashProof(embeddedPayloads),
			outer: {
				"magenta-macos-arm64": assetHashes["magenta-macos-arm64"],
				"magenta-macos-x64": assetHashes["magenta-macos-x64"],
			},
		},
		schema: "magenta.macos-signing-receipt.v1",
		sourceCommit: SOURCE_COMMIT,
	};
	const receiptPath = join(releaseDir, "macos-signing-receipt.json");
	writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
	return { receipt, receiptPath, releaseDir };
}

function rewriteReceipt(fixture) {
	writeFileSync(fixture.receiptPath, `${JSON.stringify(fixture.receipt, null, 2)}\n`);
}

test("accepts the exact v0.0.30 signing receipt and hash contract", () => {
	const fixture = createFixture();
	try {
		assert.deepEqual(verifyMacosSigningReceipt({ expectedTeamId: TEAM_ID, releaseDir: fixture.releaseDir }), {
			clipboardSha256: fixture.receipt.payloads.clipboard.afterSha256,
			embeddedPayloadSha256: fixture.receipt.payloads.embedded,
			finalManifestSha256: fixture.receipt.finalManifestSha256,
			sourceCommit: SOURCE_COMMIT,
			teamId: TEAM_ID,
		});
	} finally {
		rmSync(fixture.releaseDir, { force: true, recursive: true });
	}
});

test("fails closed without a repository-owned Apple Team ID", () => {
	const fixture = createFixture();
	try {
		assert.throws(
			() => verifyMacosSigningReceipt({ expectedTeamId: "", releaseDir: fixture.releaseDir }),
			/repository macOS release trust/iu,
		);
		assert.throws(
			() => verifyMacosSigningReceipt({ expectedTeamId: "ZZZZZ99999", releaseDir: fixture.releaseDir }),
			/certificate Team ID does not match repository trust/u,
		);
	} finally {
		rmSync(fixture.releaseDir, { force: true, recursive: true });
	}
});

test("loads one strict source-owned Team ID from tracked repository trust", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-cli-trust-"));
	try {
		const trustPath = join(root, "trust.json");
		writeFileSync(
			trustPath,
			`${JSON.stringify({ schema: "magenta.macos-release-trust.v1", appleTeamId: TEAM_ID })}\n`,
		);
		assert.equal(readRepositoryMacosTeamId(trustPath), TEAM_ID);
		writeFileSync(
			trustPath,
			`${JSON.stringify({ schema: "magenta.macos-release-trust.v1", appleTeamId: "UNCONFIGURED" })}\n`,
		);
		assert.throws(() => readRepositoryMacosTeamId(trustPath), /one configured Apple Team ID/u);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("hashes multi-megabyte assets with a bounded buffer", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-cli-hash-"));
	try {
		const path = join(root, "asset.bin");
		const content = Buffer.alloc(3 * 1024 * 1024 + 17, 0x5a);
		writeFileSync(path, content);
		assert.equal(sha256File(path), sha256(content));
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("rejects assets with multiple hard links", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-cli-hardlink-"));
	try {
		const path = join(root, "asset.bin");
		writeFileSync(path, "payload");
		linkSync(path, join(root, "asset-alias.bin"));
		assert.throws(() => sha256File(path), /exactly one hard link/u);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("rejects replacement and growth while hashing an asset", () => {
	for (const mutation of ["replace", "grow"]) {
		const root = mkdtempSync(join(tmpdir(), "magenta-cli-hash-race-"));
		try {
			const path = join(root, "asset.bin");
			writeFileSync(path, Buffer.alloc(2 * 1024 * 1024, 0x41));
			let mutated = false;
			assert.throws(
				() =>
					sha256File(path, {
						testAfterChunk() {
							if (mutated) return;
							mutated = true;
							if (mutation === "replace") {
								const replacementPath = join(root, "asset-replacement.bin");
								writeFileSync(replacementPath, Buffer.from("replacement"));
								renameSync(replacementPath, path);
							} else appendFileSync(path, Buffer.alloc(1024, 0x42));
						},
					}),
				/changed|replaced|hard link/u,
			);
		} finally {
			rmSync(root, { force: true, recursive: true });
		}
	}
});

test("rejects receipt schema, asset, and notarization tampering", async (context) => {
	const cases = [
		{
			label: "extra top-level field",
			mutate: (receipt) => {
				receipt.fallbackTeamId = TEAM_ID;
			},
			expected: /unsupported schema/u,
		},
		{
			label: "asset digest",
			mutate: (receipt) => {
				receipt.assets["install.sh"] = "0".repeat(64);
			},
			expected: /asset hash mismatch: install\.sh/u,
		},
		{
			label: "duplicate architecture",
			mutate: (receipt) => {
				receipt.notarization[1].architecture = "arm64";
			},
			expected: /invalid notarization evidence/u,
		},
		{
			label: "unchanged signed manifest",
			mutate: (receipt) => {
				receipt.initialManifestSha256 = receipt.finalManifestSha256;
			},
			expected: /does not prove a signed manifest transition/u,
		},
		{
			label: "unchanged embedded receipt",
			mutate: (receipt) => {
				receipt.initialEmbeddedChecksumReceipts.fd = receipt.embeddedChecksumReceipts.fd;
			},
			expected: /did not change during signing: fd/u,
		},
		{
			label: "outer payload proof",
			mutate: (receipt) => {
				receipt.payloads.outer["magenta-macos-arm64"] = "0".repeat(64);
			},
			expected: /Outer payload evidence does not match/u,
		},
	];

	for (const testCase of cases) {
		await context.test(testCase.label, () => {
			const fixture = createFixture();
			try {
				testCase.mutate(fixture.receipt);
				rewriteReceipt(fixture);
				assert.throws(
					() => verifyMacosSigningReceipt({ expectedTeamId: TEAM_ID, releaseDir: fixture.releaseDir }),
					testCase.expected,
				);
			} finally {
				rmSync(fixture.releaseDir, { force: true, recursive: true });
			}
		});
	}
});
