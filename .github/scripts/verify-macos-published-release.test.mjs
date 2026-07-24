import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	CHECKSUMMED_ASSETS_CURRENT,
	downloadReleaseAssets,
	EXPECTED_RELEASE_ASSETS_CURRENT,
	EXPECTED_RELEASE_ASSETS_LEGACY_EIGHT,
	expectedReleaseAssetsForTag,
	extractArchiveMemberToFile,
	fetchReleaseMetadata,
	indexExpectedReleaseAssets,
	MACOS_CLIPBOARD_PAYLOAD,
	MACOS_EMBEDDED_PAYLOADS,
	materializeAndVerifyMacosHelpers,
	normalizeMacosArchitecture,
	parseReleaseTag,
	requiresNineAssetContract,
	verifyDownloadedMacosRelease,
	verifyMacosBinary,
	verifyMacosClipboardPayload,
	verifyReleaseChecksumManifest,
} from "./verify-macos-published-release.mjs";

const REPOSITORY = "Minions-Land/Magenta-CLI";
const TAG = "v0.1.0";

function sha256(content) {
	return createHash("sha256").update(content).digest("hex");
}

function fileMode(path) {
	return statSync(path).mode & 0o777;
}

function releaseFixture() {
	const bodies = new Map(
		EXPECTED_RELEASE_ASSETS_CURRENT.map((name) => [name, Buffer.from(`release asset: ${name}\n`)]),
	);
	const assets = EXPECTED_RELEASE_ASSETS_CURRENT.map((name, index) => ({
		digest: `sha256:${sha256(bodies.get(name))}`,
		id: index + 100,
		name,
		size: bodies.get(name).length,
		state: "uploaded",
	}));
	return { bodies, release: { assets, draft: true, prerelease: false, tag_name: TAG } };
}

test("enforces the current nine-asset contract from v0.0.30", () => {
	assert.deepEqual(parseReleaseTag(TAG), { major: 0, minor: 1, patch: 0, version: "0.1.0" });
	assert.equal(requiresNineAssetContract("v0.0.24"), false);
	assert.equal(requiresNineAssetContract("v0.0.29"), false);
	assert.throws(() => expectedReleaseAssetsForTag("v0.0.24"), /Unsupported historical release asset contract/u);
	assert.deepEqual(expectedReleaseAssetsForTag("v0.0.27"), EXPECTED_RELEASE_ASSETS_LEGACY_EIGHT);
	assert.deepEqual(expectedReleaseAssetsForTag("v0.0.29"), EXPECTED_RELEASE_ASSETS_LEGACY_EIGHT);
	assert.equal(requiresNineAssetContract("v0.0.30"), true);
	assert.deepEqual(expectedReleaseAssetsForTag("v0.0.30"), EXPECTED_RELEASE_ASSETS_CURRENT);
	assert.equal(requiresNineAssetContract(TAG), true);
	assert.equal(requiresNineAssetContract("v1.0.0"), true);
	assert.equal(normalizeMacosArchitecture("x86_64"), "x64");
	assert.equal(MACOS_EMBEDDED_PAYLOADS.length, 6);
	assert.throws(() => parseReleaseTag("v0.01.0"), /exact vMAJOR\.MINOR\.PATCH/u);
	assert.equal(EXPECTED_RELEASE_ASSETS_CURRENT.length, 9);

	const fixture = releaseFixture();
	assert.equal(indexExpectedReleaseAssets(fixture.release).size, 9);
	fixture.release.assets.pop();
	assert.throws(() => indexExpectedReleaseAssets(fixture.release), /does not exactly match/u);
});

test("macOS verifier fails closed for an unknown historical asset contract", () => {
	const env = { ...process.env };
	delete env.GH_TOKEN;
	delete env.GITHUB_TOKEN;
	const result = spawnSync(
		process.execPath,
		[
			fileURLToPath(new URL("./verify-macos-published-release.mjs", import.meta.url)),
			"--allow-draft",
			"false",
			"--native-architecture",
			"arm64",
			"--release-dir",
			"/unused",
			"--release-tag",
			"v0.0.24",
			"--repository",
			REPOSITORY,
		],
		{ encoding: "utf8", env },
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /Unsupported historical release asset contract: v0\.0\.24/u);
});

test("verifies the exact checksum manifest and full source commit", async () => {
	const releaseDir = mkdtempSync(join(tmpdir(), "magenta-cli-manifest-"));
	try {
		const lines = [];
		for (const name of CHECKSUMMED_ASSETS_CURRENT) {
			const body = name === "SOURCE_COMMIT" ? `${"a".repeat(40)}\n` : `release asset: ${name}\n`;
			writeFileSync(join(releaseDir, name), body);
			lines.push(`${sha256(body)}  ${name}`);
		}
		writeFileSync(join(releaseDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
		const result = await verifyReleaseChecksumManifest({ releaseDir });
		assert.equal(result.sourceCommit, "a".repeat(40));
		assert.match(result.manifestSha256, /^[0-9a-f]{64}$/u);

		writeFileSync(join(releaseDir, "install.sh"), "tampered\n");
		await assert.rejects(() => verifyReleaseChecksumManifest({ releaseDir }), /asset hash mismatch: install\.sh/u);
	} finally {
		rmSync(releaseDir, { force: true, recursive: true });
	}
});

test("starts the native CLI and materialized helpers in a secret-free home", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-cli-helper-proof-test-"));
	const releaseDir = join(root, "release");
	mkdirSync(releaseDir);
	const binaryPath = join(releaseDir, "magenta-macos-arm64");
	writeFileSync(binaryPath, "outer binary");
	const contracts = MACOS_EMBEDDED_PAYLOADS.filter(({ architecture }) => architecture === "arm64");
	const bytesByKind = new Map(contracts.map(({ kind }) => [kind, Buffer.from(`helper:${kind}\n`)]));
	const binaryRuns = [];
	const helperRuns = [];
	let reportedVersion = "0.1.0";
	const runCommand = (command, args, options = {}) => {
		if (command === binaryPath) {
			binaryRuns.push({ args, env: options.env });
			const expectedEnvironmentKeys = ["HOME", "LANG", "LC_ALL", "PATH", "TMPDIR"];
			if (args[0] === "_release-helper-proof") expectedEnvironmentKeys.push("MAGENTA_RELEASE_HELPER_PROOF");
			assert.deepEqual(Object.keys(options.env).sort(), expectedEnvironmentKeys.sort());
			assert.equal(options.env.MAGENTA_RELEASE_HELPER_PROOF, args[0] === "_release-helper-proof" ? "1" : undefined);
			if (args[0] === "--version") return { status: 0, stderr: "", stdout: `${reportedVersion}\n` };
			if (args[0] === "--help") return { status: 0, stderr: "", stdout: "help\n" };
			assert.deepEqual(args, ["_release-helper-proof"]);
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
		if (contracts.some(({ kind }) => command.endsWith(`/${kind}`))) {
			helperRuns.push({ args, command, env: options.env });
			return { status: 0, stderr: "", stdout: "help\n" };
		}
		return { status: 0, stderr: "", stdout: "" };
	};
	try {
		const verified = materializeAndVerifyMacosHelpers({
			architecture: "arm64",
			expectedVersion: "0.1.0",
			releaseDir,
			runCommand,
			temporaryParent: root,
		});
		assert.deepEqual(verified.map(({ kind }) => kind), ["fd", "process-tools", "rg"]);
		assert.deepEqual(binaryRuns.map(({ args }) => args), [["--version"], ["--help"], ["_release-helper-proof"]]);
		assert.equal(binaryRuns.every(({ env }) => !("GH_TOKEN" in env)), true);
		assert.equal(helperRuns.length, 3);
		assert.equal(helperRuns.every(({ args }) => args[0] === "--help"), true);

		reportedVersion = "0.1.1";
		assert.throws(
			() =>
				materializeAndVerifyMacosHelpers({
					architecture: "arm64",
					expectedVersion: "0.1.0",
					releaseDir,
					runCommand,
					temporaryParent: root,
				}),
			/version mismatch/u,
		);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("keeps verified downloads private and enables only the native x64 outer binary before startup", async () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-cli-native-mode-"));
	const releaseDir = join(root, "release");
	mkdirSync(releaseDir, { mode: 0o700 });
	const armBinary = join(releaseDir, "magenta-macos-arm64");
	const x64Binary = join(releaseDir, "magenta-macos-x64");
	const events = [];
	try {
		const manifestLines = [];
		for (const name of CHECKSUMMED_ASSETS_CURRENT) {
			const body = name === "SOURCE_COMMIT" ? `${"b".repeat(40)}\n` : `verified payload: ${name}\n`;
			writeFileSync(join(releaseDir, name), body, { mode: 0o600 });
			manifestLines.push(`${sha256(body)}  ${name}`);
		}
		writeFileSync(join(releaseDir, "SHA256SUMS"), `${manifestLines.join("\n")}\n`, { mode: 0o600 });

		await verifyReleaseChecksumManifest({ releaseDir });
		events.push("manifest");
		for (const name of EXPECTED_RELEASE_ASSETS_CURRENT) assert.equal(fileMode(join(releaseDir, name)), 0o600);

		const x64Contracts = MACOS_EMBEDDED_PAYLOADS.filter(({ architecture }) => architecture === "x64");
		const runCommand = (command, args, options = {}) => {
			if (command === "/usr/bin/lipo") {
				const target = args[1];
				if (target === armBinary) {
					assert.equal(fileMode(armBinary), 0o600);
					events.push("lipo:arm64");
					return { status: 0, stderr: "", stdout: "arm64\n" };
				}
				if (target === x64Binary) {
					assert.equal(fileMode(x64Binary), 0o600);
					events.push("lipo:x64");
					return { status: 0, stderr: "", stdout: "x86_64\n" };
				}
				if (target.endsWith("/clipboard.darwin-universal.node")) {
					events.push("lipo:clipboard");
					return { status: 0, stderr: "", stdout: "x86_64 arm64\n" };
				}
				if (x64Contracts.some(({ kind }) => target.endsWith(`/${kind}`))) {
					return { status: 0, stderr: "", stdout: "x86_64\n" };
				}
				return { status: 1, stderr: `unexpected lipo target: ${target}`, stdout: "" };
			}
			if (command === process.execPath) {
				assert.equal(fileMode(armBinary), 0o600);
				assert.equal(fileMode(x64Binary), 0o600);
				events.push("load:clipboard");
				return { status: 0, stderr: "", stdout: "" };
			}
			if (command === x64Binary) {
				assert.equal(fileMode(armBinary), 0o600);
				assert.equal(fileMode(x64Binary), 0o700);
				events.push(`outer:${args[0]}`);
				if (args[0] === "--version") return { status: 0, stderr: "", stdout: "0.1.0\n" };
				if (args[0] === "--help") return { status: 0, stderr: "", stdout: "help\n" };
				const cacheRoot = join(options.env.HOME, ".magenta", "cache", "proof-generation");
				mkdirSync(cacheRoot, { recursive: true });
				const helpers = x64Contracts.map(({ kind }) => {
					const path = join(cacheRoot, kind);
					const body = `helper:${kind}\n`;
					writeFileSync(path, body, { mode: 0o700 });
					return { kind, path, sha256: sha256(body), size: Buffer.byteLength(body) };
				});
				return {
					status: 0,
					stderr: "",
					stdout: `${JSON.stringify({ architecture: "x64", helpers, platform: "darwin", schema: "magenta.release-embedded-helper-proof.v1" })}\n`,
				};
			}
			if (x64Contracts.some(({ kind }) => command.endsWith(`/${kind}`))) {
				return { status: 0, stderr: "", stdout: "help\n" };
			}
			return { status: 1, stderr: `unexpected command: ${command}`, stdout: "" };
		};

		const result = verifyDownloadedMacosRelease({
			expectedVersion: "0.1.0",
			extractArchiveMember({ outputPath }) {
				writeFileSync(outputPath, "clipboard payload\n", { mode: 0o600 });
			},
			nativeArchitecture: "x64",
			releaseDir,
			runCommand,
			temporaryParent: root,
		});
		assert.deepEqual(result, { nativeHelpers: 3, nativePayloads: 6 });
		assert.deepEqual(events.slice(0, 8), [
			"manifest",
			"lipo:arm64",
			"lipo:x64",
			"lipo:clipboard",
			"load:clipboard",
			"outer:--version",
			"outer:--help",
			"outer:_release-helper-proof",
		]);
		assert.equal(fileMode(x64Binary), 0o700);
		for (const name of EXPECTED_RELEASE_ASSETS_CURRENT) {
			if (name !== "magenta-macos-x64") assert.equal(fileMode(join(releaseDir, name)), 0o600);
		}
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
		for (const name of EXPECTED_RELEASE_ASSETS_CURRENT) {
			assert.deepEqual(readFileSync(join(releaseDir, name)), fixture.bodies.get(name));
		}
		assert.equal(calls.filter((call) => call.authorization === "Bearer test-token").length, 9);
		assert.equal(calls.filter((call) => call.url.includes("release-assets.githubusercontent.com")).length, 9);
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

test("checks the declared native architecture without requiring Apple signing", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-cli-binary-"));
	const binaryPath = join(root, "magenta-macos-arm64");
	writeFileSync(binaryPath, "unsigned binary");
	const calls = [];
	try {
		verifyMacosBinary({
			architecture: "arm64",
			path: binaryPath,
			runCommand(command, args) {
				calls.push({ args, command });
				return { status: 0, stderr: "", stdout: "arm64\n" };
			},
		});
		assert.deepEqual(calls, [{ args: ["-archs", binaryPath], command: "/usr/bin/lipo" }]);
		assert.equal(calls.some(({ command }) => /codesign|spctl/u.test(command)), false);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("maps the logical x64 outer contract to lipo x86_64", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-cli-x64-binary-"));
	const binaryPath = join(root, "magenta-macos-x64");
	writeFileSync(binaryPath, "x64 binary");
	const calls = [];
	try {
		verifyMacosBinary({
			architecture: "x64",
			path: binaryPath,
			runCommand(command, args) {
				calls.push({ args, command });
				return { status: 0, stderr: "", stdout: "x86_64\n" };
			},
		});
		assert.deepEqual(calls, [{ args: ["-archs", binaryPath], command: "/usr/bin/lipo" }]);
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("checks and loads the universal macOS clipboard payload", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-cli-clipboard-"));
	const clipboardPath = join(root, "clipboard.darwin-universal.node");
	const bytes = Buffer.from("universal clipboard payload\n");
	writeFileSync(clipboardPath, bytes);
	const calls = [];
	const runCommand = (command, args) => {
		calls.push({ args, command });
		if (command.endsWith("/lipo")) return { status: 0, stderr: "", stdout: "x86_64 arm64\n" };
		return { status: 0, stderr: "", stdout: "" };
	};
	try {
		verifyMacosClipboardPayload({
			path: clipboardPath,
			runCommand,
		});
		assert.deepEqual(calls.map((call) => call.command), ["/usr/bin/lipo", process.execPath]);
		assert.deepEqual(calls[1].args.slice(0, 2), ["-e", calls[1].args[1]]);
		assert.equal(calls[1].args.at(-1), clipboardPath);
		assert.equal(calls.some(({ command }) => /codesign|spctl/u.test(command)), false);
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

test("refuses native verification while API tokens remain", () => {
	const originalToken = process.env.GH_TOKEN;
	process.env.GH_TOKEN = "must-not-reach-native-code";
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
