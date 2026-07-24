import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertMacosSignature,
	downloadReleaseAssets,
	EXPECTED_RELEASE_ASSETS_V0_0_30,
	extractArchiveMemberToFile,
	fetchReleaseMetadata,
	indexExpectedReleaseAssets,
	MACOS_CLIPBOARD_PAYLOAD,
	MACOS_OUTER_IDENTIFIER,
	materializeAndVerifyMacosHelpers,
	normalizeMacosArchitecture,
	parseReleaseTag,
	requiresV0030Contract,
	verifyDownloadedMacosRelease,
	verifyMacosBinary,
	verifyMacosClipboardPayload,
} from "./verify-macos-published-release.mjs";
import { MACOS_EMBEDDED_PAYLOADS } from "./verify-macos-signing-receipt.mjs";

const REPOSITORY = "Minions-Land/Magenta-CLI";
const TAG = "v0.0.30";
const TEAM_ID = "ABCDE12345";

function sha256(content) {
	return createHash("sha256").update(content).digest("hex");
}

function releaseFixture() {
	const bodies = new Map(
		EXPECTED_RELEASE_ASSETS_V0_0_30.map((name) => [name, Buffer.from(`release asset: ${name}\n`)]),
	);
	const assets = EXPECTED_RELEASE_ASSETS_V0_0_30.map((name, index) => ({
		digest: `sha256:${sha256(bodies.get(name))}`,
		id: index + 100,
		name,
		size: bodies.get(name).length,
		state: "uploaded",
	}));
	return { bodies, release: { assets, draft: true, prerelease: false, tag_name: TAG } };
}

function signatureFixture(overrides = {}) {
	return [
		"CodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=1+0 location=embedded",
		`Identifier=${overrides.identifier ?? "land.minions.magenta"}`,
		"Format=Mach-O thin (arm64)",
		"Signature size=9000",
		`Authority=${overrides.authority ?? `Developer ID Application: Magenta (${TEAM_ID})`}`,
		`Timestamp=${overrides.timestamp ?? "Jul 23, 2026 at 01:23:45"}`,
		`TeamIdentifier=${overrides.teamId ?? TEAM_ID}`,
		...(overrides.extra ?? []),
	].join("\n");
}

test("enforces the v0.0.30+ version and exact ten-asset contract", () => {
	assert.deepEqual(parseReleaseTag(TAG), { major: 0, minor: 0, patch: 30, version: "0.0.30" });
	assert.equal(requiresV0030Contract("v0.0.29"), false);
	assert.equal(requiresV0030Contract(TAG), true);
	assert.equal(requiresV0030Contract("v1.0.0"), true);
	assert.equal(MACOS_OUTER_IDENTIFIER, "land.minions.magenta");
	assert.equal(MACOS_CLIPBOARD_PAYLOAD.identifier, "land.minions.magenta.clipboard");
	assert.equal(normalizeMacosArchitecture("x86_64"), "x64");
	assert.equal(MACOS_EMBEDDED_PAYLOADS.length, 6);
	assert.throws(() => parseReleaseTag("v0.00.30"), /exact vMAJOR\.MINOR\.PATCH/u);
	assert.equal(EXPECTED_RELEASE_ASSETS_V0_0_30.length, 10);

	const fixture = releaseFixture();
	assert.equal(indexExpectedReleaseAssets(fixture.release).size, 10);
	fixture.release.assets.pop();
	assert.throws(() => indexExpectedReleaseAssets(fixture.release), /does not exactly match/u);
});

test("materializes native embedded helpers in a secret-free home and binds bytes and signatures to the receipt", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-cli-helper-proof-test-"));
	const releaseDir = join(root, "release");
	mkdirSync(releaseDir);
	const binaryPath = join(releaseDir, "magenta-macos-arm64");
	writeFileSync(binaryPath, "signed outer binary");
	const contracts = MACOS_EMBEDDED_PAYLOADS.filter(({ architecture }) => architecture === "arm64");
	const bytesByKind = new Map(contracts.map(({ kind }) => [kind, Buffer.from(`signed helper:${kind}\n`)]));
	const embeddedPayloadSha256 = Object.fromEntries(
		MACOS_EMBEDDED_PAYLOADS.map(({ relativePath }) => [relativePath, sha256(`unused:${relativePath}`)]),
	);
	for (const contract of contracts) embeddedPayloadSha256[contract.relativePath] = sha256(bytesByKind.get(contract.kind));
	const helperRuns = [];
	const runCommand = (command, args, options = {}) => {
		if (command === binaryPath) {
			helperRuns.push({ args, env: options.env });
			assert.deepEqual(args, ["_release-helper-proof"]);
			assert.deepEqual(Object.keys(options.env).sort(), [
				"HOME",
				"LANG",
				"LC_ALL",
				"MAGENTA_RELEASE_HELPER_PROOF",
				"PATH",
				"TMPDIR",
			]);
			assert.equal(options.env.MAGENTA_RELEASE_HELPER_PROOF, "1");
			const cacheRoot = join(options.env.HOME, ".magenta", "cache", "proof-generation");
			mkdirSync(cacheRoot, { recursive: true });
			const helpers = contracts.map(({ kind }) => {
				const path = join(cacheRoot, kind);
				const bytes = bytesByKind.get(kind);
				writeFileSync(path, bytes, { mode: 0o755 });
				return { kind, path, sha256: sha256(bytes), size: bytes.length };
			});
			return {
				status: 0,
				stderr: "",
				stdout: `${JSON.stringify({ architecture: "arm64", helpers, platform: "darwin", schema: "magenta.release-embedded-helper-proof.v1" })}\n`,
			};
		}
		if (command.endsWith("/lipo")) return { status: 0, stderr: "", stdout: "arm64\n" };
		if (command.endsWith("/codesign") && args[0] === "--display") {
			const kind = args.at(-1).split("/").at(-1);
			const contract = contracts.find((candidate) => candidate.kind === kind);
			return { status: 0, stderr: signatureFixture({ identifier: contract.identifier }), stdout: "" };
		}
		return { status: 0, stderr: "", stdout: "" };
	};
	try {
		const verified = materializeAndVerifyMacosHelpers({
			architecture: "arm64",
			embeddedPayloadSha256,
			expectedTeamId: TEAM_ID,
			releaseDir,
			runCommand,
			temporaryParent: root,
		});
		assert.deepEqual(verified.map(({ kind }) => kind), ["fd", "process-tools", "rg"]);
		assert.equal(helperRuns.length, 1);
		assert.equal("GH_TOKEN" in helperRuns[0].env, false);

		const tampered = { ...embeddedPayloadSha256, [contracts[0].relativePath]: "0".repeat(64) };
		assert.throws(
			() =>
				materializeAndVerifyMacosHelpers({
					architecture: "arm64",
					embeddedPayloadSha256: tampered,
					expectedTeamId: TEAM_ID,
					releaseDir,
					runCommand,
					temporaryParent: root,
				}),
			/does not match the signing receipt/u,
		);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("selects one exact draft release through the authenticated GitHub API", async () => {
	const fixture = releaseFixture();
	const calls = [];
	const fetchImpl = async (url, options) => {
		calls.push({ options, url: String(url) });
		if (String(url) === `https://api.github.com/repos/${REPOSITORY}`) {
			return new Response(JSON.stringify({ id: 12345 }), {
				headers: { "content-type": "application/json" },
				status: 200,
			});
		}
		return new Response(JSON.stringify([fixture.release]), {
			headers: { "content-type": "application/json" },
			status: 200,
		});
	};
	const release = await fetchReleaseMetadata({
		allowDraft: true,
		fetchImpl,
		repository: REPOSITORY,
		tag: TAG,
		token: "test-token",
	});
	assert.deepEqual(release, fixture.release);
	assert.equal(calls.length, 2);
	assert.equal(new Headers(calls[0].options.headers).get("authorization"), "Bearer test-token");
	assert.match(calls[1].url, /\/releases\?per_page=100$/u);
});

test("uses the exact tag endpoint for a published release and rejects a draft", async () => {
	const fixture = releaseFixture();
	const calls = [];
	const fetchImpl = async (url) => {
		calls.push(String(url));
		return new Response(JSON.stringify(fixture.release), {
			headers: { "content-type": "application/json" },
			status: 200,
		});
	};
	await assert.rejects(
		() =>
			fetchReleaseMetadata({
				allowDraft: false,
				fetchImpl,
				repository: REPOSITORY,
				tag: TAG,
				token: "test-token",
			}),
		/draft release verification requires allow_draft=true/iu,
	);
	assert.deepEqual(calls, [`https://api.github.com/repos/${REPOSITORY}/releases/tags/${TAG}`]);

	fixture.release.draft = false;
	assert.deepEqual(
		await fetchReleaseMetadata({
			allowDraft: false,
			fetchImpl,
			repository: REPOSITORY,
			tag: TAG,
			token: "test-token",
		}),
		fixture.release,
	);
});

test("rejects pagination that leaves the authenticated repository release endpoint", async () => {
	const fixture = releaseFixture();
	let call = 0;
	const fetchImpl = async (url) => {
		call += 1;
		if (call === 1) {
			return new Response(JSON.stringify({ id: 12345 }), { status: 200 });
		}
		return new Response(JSON.stringify([]), {
			status: 200,
			headers: {
				link: '<https://api.github.com/repositories/99999/releases?per_page=100&page=2>; rel="next"',
			},
		});
	};
	await assert.rejects(
		() =>
			fetchReleaseMetadata({
				allowDraft: true,
				fetchImpl,
				repository: REPOSITORY,
				tag: TAG,
				token: "test-token",
			}),
		/expected repository release endpoint/u,
	);
});

test("downloads every asset by API ID, strips auth on redirects, and checks GitHub digests", async () => {
	const fixture = releaseFixture();
	const byId = new Map(fixture.release.assets.map((asset) => [String(asset.id), asset]));
	const calls = [];
	const fetchImpl = async (url, options) => {
		const parsed = new URL(url);
		calls.push({ authorization: new Headers(options.headers).get("authorization"), url: parsed.href });
		if (parsed.hostname === "api.github.com") {
			const asset = byId.get(parsed.pathname.split("/").at(-1));
			assert.ok(asset);
			return new Response(null, {
				headers: { location: `https://release-assets.githubusercontent.com/${asset.id}` },
				status: 302,
			});
		}
		const asset = byId.get(parsed.pathname.slice(1));
		return new Response(fixture.bodies.get(asset.name), { status: 200 });
	};
	const releaseDir = mkdtempSync(join(tmpdir(), "magenta-cli-assets-"));
	try {
		await downloadReleaseAssets({
			fetchImpl,
			release: fixture.release,
			releaseDir,
			repository: REPOSITORY,
			token: "test-token",
		});
		for (const name of EXPECTED_RELEASE_ASSETS_V0_0_30) {
			assert.deepEqual(readFileSync(join(releaseDir, name)), fixture.bodies.get(name));
		}
		assert.equal(calls.filter((call) => call.authorization === "Bearer test-token").length, 10);
		assert.equal(calls.filter((call) => call.url.includes("release-assets.githubusercontent.com")).length, 10);
		assert.equal(
			calls.filter((call) => call.url.includes("release-assets.githubusercontent.com")).every((call) => !call.authorization),
			true,
		);
	} finally {
		rmSync(releaseDir, { force: true, recursive: true });
	}
});

test("rejects an asset whose downloaded bytes disagree with the GitHub digest", async () => {
	const fixture = releaseFixture();
	const firstAsset = fixture.release.assets[0];
	const tampered = Buffer.from(fixture.bodies.get(firstAsset.name));
	tampered[0] ^= 1;
	fixture.bodies.set(firstAsset.name, tampered);
	const byId = new Map(fixture.release.assets.map((asset) => [String(asset.id), asset]));
	const fetchImpl = async (url) => {
		const parsed = new URL(url);
		const asset = byId.get(parsed.pathname.split("/").at(-1));
		return new Response(fixture.bodies.get(asset.name), { status: 200 });
	};
	const releaseDir = mkdtempSync(join(tmpdir(), "magenta-cli-tampered-assets-"));
	try {
		await assert.rejects(
			() =>
				downloadReleaseAssets({
					fetchImpl,
					release: fixture.release,
					releaseDir,
					repository: REPOSITORY,
					token: "test-token",
				}),
			/GitHub digest mismatch/u,
		);
	} finally {
		rmSync(releaseDir, { force: true, recursive: true });
	}
});

test("rejects oversized release metadata before downloading any bytes", async () => {
	const fixture = releaseFixture();
	fixture.release.assets[0].size = 2;
	const calls = [];
	const releaseDir = mkdtempSync(join(tmpdir(), "magenta-cli-oversized-"));
	await assert.rejects(
		() =>
			downloadReleaseAssets({
				fetchImpl: async (url) => {
					calls.push(String(url));
					return new Response(null, { status: 500 });
				},
				release: fixture.release,
				releaseDir,
				repository: REPOSITORY,
				token: "test-token",
				maxAssetBytes: 1,
			}),
		/1-byte limit/u,
	);
	assert.deepEqual(calls, []);
	rmSync(releaseDir, { force: true, recursive: true });
});

test("aborts a stalled asset body with the idle timeout", async () => {
	const fixture = releaseFixture();
	const byId = new Map(fixture.release.assets.map((asset) => [String(asset.id), asset]));
	const releaseDir = mkdtempSync(join(tmpdir(), "magenta-cli-stalled-"));
	try {
		await assert.rejects(
			() =>
				downloadReleaseAssets({
					fetchImpl: async (url) => {
						const parsed = new URL(url);
						const asset = byId.get(parsed.pathname.split("/").at(-1));
						if (parsed.hostname === "api.github.com") {
							return new Response(null, {
								status: 302,
								headers: { location: `https://release-assets.githubusercontent.com/${asset.id}` },
							});
						}
						let timer;
						const body = new ReadableStream({
							start(controller) {
								controller.enqueue(new Uint8Array([0x61]));
								timer = setTimeout(() => controller.enqueue(new Uint8Array([0x62])), 100);
							},
							cancel() {
								clearTimeout(timer);
							},
						});
						return new Response(body, { status: 200 });
					},
					release: fixture.release,
					releaseDir,
					repository: REPOSITORY,
					token: "test-token",
					inactivityTimeoutMs: 10,
					wallTimeoutMs: 1_000,
				}),
			/idle timeout/u,
		);
	} finally {
		rmSync(releaseDir, { force: true, recursive: true });
	}
});

test("requires strict notarized Developer ID checks without executing either binary", () => {
	const calls = [];
	const runCommand = (command, args) => {
		calls.push({ args, command });
		if (command.endsWith("/lipo")) return { status: 0, stderr: "", stdout: "arm64\n" };
		if (args[0] === "--display") return { status: 0, stderr: signatureFixture(), stdout: "" };
		return { status: 0, stderr: "", stdout: "" };
	};
	verifyMacosBinary({ architecture: "arm64", expectedTeamId: TEAM_ID, path: "/tmp/magenta", runCommand });

	assert.deepEqual(calls.map((call) => call.command), [
		"/usr/bin/codesign",
		"/usr/sbin/spctl",
		"/usr/bin/lipo",
		"/usr/bin/codesign",
	]);
	assert.deepEqual(calls[0].args.slice(0, 5), [
		"--verify",
		"--strict",
		"--check-notarization",
		"--verbose=2",
		"--test-requirement",
	]);
	assert.match(calls[0].args[5], /certificate leaf\[field\.1\.2\.840\.113635\.100\.6\.1\.13\] exists/u);
	assert.deepEqual(calls[1].args.slice(0, 4), ["--assess", "--type", "execute", "--verbose=4"]);
	assert.equal(calls.some((call) => call.args.includes("--help") || call.args.includes("--version")), false);
});

test("independently verifies the signed universal macOS clipboard payload without executing it", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-cli-clipboard-"));
	const clipboardPath = join(root, "clipboard.darwin-universal.node");
	const bytes = Buffer.from("signed universal clipboard payload\n");
	writeFileSync(clipboardPath, bytes);
	const calls = [];
	const runCommand = (command, args) => {
		calls.push({ args, command });
		if (command.endsWith("/lipo")) return { status: 0, stderr: "", stdout: "x86_64 arm64\n" };
		if (args[0] === "--display") {
			return {
				status: 0,
				stderr: signatureFixture({ identifier: MACOS_CLIPBOARD_PAYLOAD.identifier }),
				stdout: "",
			};
		}
		return { status: 0, stderr: "", stdout: "" };
	};
	try {
		verifyMacosClipboardPayload({
			expectedSha256: sha256(bytes),
			expectedTeamId: TEAM_ID,
			path: clipboardPath,
			runCommand,
		});
		assert.deepEqual(calls.map((call) => call.command), [
			"/usr/bin/codesign",
			"/usr/bin/lipo",
			"/usr/bin/codesign",
		]);
		assert.equal(calls.some((call) => call.command.endsWith("/spctl")), false);
		assert.throws(
			() =>
				verifyMacosClipboardPayload({
					expectedSha256: "0".repeat(64),
					expectedTeamId: TEAM_ID,
					path: clipboardPath,
					runCommand,
				}),
			/does not match the signing receipt/u,
		);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("extracts only the exact clipboard archive member into a regular file", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-cli-clipboard-archive-"));
	const sourceRoot = join(root, "source");
	const sourcePath = join(sourceRoot, MACOS_CLIPBOARD_PAYLOAD.resourcePath);
	const archivePath = join(root, "resources.tar.gz");
	const outputPath = join(root, "clipboard.node");
	const bytes = Buffer.from("archive clipboard payload\n");
	try {
		mkdirSync(join(sourcePath, ".."), { recursive: true });
		writeFileSync(sourcePath, bytes);
		const archive = spawnSync(
			"/usr/bin/tar",
			["-czf", archivePath, MACOS_CLIPBOARD_PAYLOAD.resourcePath],
			{ cwd: sourceRoot, encoding: "utf8" },
		);
		assert.equal(archive.status, 0, archive.stderr);
		extractArchiveMemberToFile({
			archivePath,
			memberPath: MACOS_CLIPBOARD_PAYLOAD.resourcePath,
			outputPath,
		});
		assert.deepEqual(readFileSync(outputPath), bytes);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("rejects forged signature metadata and refuses verification while API tokens remain", async (context) => {
	const cases = [
		["identifier", signatureFixture({ identifier: "land.minions.wrong" }), /Identifier mismatch/u],
		["team", signatureFixture({ teamId: "ZZZZZ99999" }), /TeamIdentifier mismatch/u],
		["authority", signatureFixture({ authority: "Apple Development: Magenta" }), /Developer ID Application/u],
		["timestamp", signatureFixture({ timestamp: "none" }), /secure timestamp/u],
		["ad hoc", `${signatureFixture()}\nSignature=adhoc`, /ad-hoc signature/u],
		[
			"runtime",
			signatureFixture().replace("flags=0x10000(runtime)", "flags=0x0(none)"),
			/hardened runtime/u,
		],
	];
	for (const [label, signature, expected] of cases) {
		await context.test(label, () => {
			assert.throws(
				() =>
					assertMacosSignature(signature, {
						expectedIdentifier: "land.minions.magenta",
						expectedTeamId: TEAM_ID,
						name: "magenta-macos-arm64",
					}),
				expected,
			);
		});
	}

	const originalToken = process.env.GH_TOKEN;
	process.env.GH_TOKEN = "must-not-reach-codesign";
	try {
		assert.throws(
			() => verifyDownloadedMacosRelease({ releaseDir: "/tmp/unused", runCommand: () => assert.fail() }),
			/tokens must be removed/u,
			);
		} finally {
			if (originalToken === undefined) delete process.env.GH_TOKEN;
			else process.env.GH_TOKEN = originalToken;
		}
});
