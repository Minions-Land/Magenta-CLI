import assert from "node:assert/strict";
import test from "node:test";
import {
	EXPECTED_RELEASE_ASSETS_LEGACY_EIGHT,
	EXPECTED_RELEASE_ASSETS_CURRENT,
	expectedReleaseAssetsForTag,
} from "./verify-macos-published-release.mjs";
import { prepareReleaseAssets } from "./prepare-release-assets.mjs";

test("selects the exact historical and current asset contracts", () => {
	assert.deepEqual(expectedReleaseAssetsForTag("v0.0.27"), EXPECTED_RELEASE_ASSETS_LEGACY_EIGHT);
	assert.deepEqual(expectedReleaseAssetsForTag("v0.0.29"), EXPECTED_RELEASE_ASSETS_LEGACY_EIGHT);
	assert.throws(() => expectedReleaseAssetsForTag("v0.0.24"), /Unsupported historical release asset contract/u);
	assert.throws(() => expectedReleaseAssetsForTag("v0.0.28"), /Unsupported historical release asset contract/u);
	assert.deepEqual(expectedReleaseAssetsForTag("v0.0.30"), EXPECTED_RELEASE_ASSETS_CURRENT);
	assert.deepEqual(expectedReleaseAssetsForTag("v0.1.0"), EXPECTED_RELEASE_ASSETS_CURRENT);
	assert.deepEqual(expectedReleaseAssetsForTag("v1.0.0"), EXPECTED_RELEASE_ASSETS_CURRENT);
	assert.equal(EXPECTED_RELEASE_ASSETS_LEGACY_EIGHT.length, 8);
	assert.equal(EXPECTED_RELEASE_ASSETS_CURRENT.length, 9);
});

test("rejects an unknown historical asset contract before network access", async () => {
	let networkReached = false;
	await assert.rejects(
		() =>
			prepareReleaseAssets({
				allowDraft: false,
				fetchImpl: () => {
					networkReached = true;
					throw new Error("network must not be reached");
				},
				releaseDir: "/unused",
				repository: "Minions-Land/Magenta-CLI",
				tag: "v0.0.24",
				token: "test-token",
			}),
		/Unsupported historical release asset contract/u,
	);
	assert.equal(networkReached, false);
});

test("fails before network access without the scoped release token", async () => {
	await assert.rejects(
		() =>
			prepareReleaseAssets({
				allowDraft: false,
				fetchImpl: () => assert.fail("network must not be reached"),
				releaseDir: "/unused",
				repository: "Minions-Land/Magenta-CLI",
				tag: "v0.1.0",
				token: "",
			}),
		/GH_TOKEN is required/u,
	);
});
