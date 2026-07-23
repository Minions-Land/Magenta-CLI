import assert from "node:assert/strict";
import test from "node:test";
import {
	EXPECTED_RELEASE_ASSETS_V0_0_29,
	EXPECTED_RELEASE_ASSETS_V0_0_30,
	expectedReleaseAssetsForTag,
} from "./verify-macos-published-release.mjs";
import { prepareReleaseAssets } from "./prepare-release-assets.mjs";

test("selects the exact legacy and v0.0.30+ asset contracts", () => {
	assert.deepEqual(expectedReleaseAssetsForTag("v0.0.29"), EXPECTED_RELEASE_ASSETS_V0_0_29);
	assert.deepEqual(expectedReleaseAssetsForTag("v0.0.30"), EXPECTED_RELEASE_ASSETS_V0_0_30);
	assert.deepEqual(expectedReleaseAssetsForTag("v1.0.0"), EXPECTED_RELEASE_ASSETS_V0_0_30);
	assert.equal(EXPECTED_RELEASE_ASSETS_V0_0_29.length, 8);
	assert.equal(EXPECTED_RELEASE_ASSETS_V0_0_30.length, 10);
});

test("fails before network access without the scoped release token", async () => {
	await assert.rejects(
		() =>
			prepareReleaseAssets({
				allowDraft: false,
				fetchImpl: () => assert.fail("network must not be reached"),
				releaseDir: "/unused",
				repository: "Minions-Land/Magenta-CLI",
				tag: "v0.0.30",
				token: "",
			}),
		/GH_TOKEN is required/u,
	);
});
