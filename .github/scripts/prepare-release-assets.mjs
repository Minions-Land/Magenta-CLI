#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	downloadReleaseAssets,
	expectedReleaseAssetsForTag,
	fetchReleaseMetadata,
	parseReleaseTag,
} from "./verify-macos-published-release.mjs";

const DISTRIBUTION_REPOSITORY = "Minions-Land/Magenta-CLI";

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
	const supported = new Set(["--allow-draft", "--release-dir", "--release-tag", "--repository"]);
	for (const flag of values.keys()) if (!supported.has(flag)) throw new Error(`Unknown argument: ${flag}`);
	for (const flag of supported) if (!values.has(flag)) throw new Error(`${flag} is required.`);
	const allowDraft = values.get("--allow-draft");
	if (allowDraft !== "true" && allowDraft !== "false") throw new Error("--allow-draft must be true or false.");
	const repository = values.get("--repository");
	if (repository !== DISTRIBUTION_REPOSITORY) {
		throw new Error(`Release repository must be the fixed ${DISTRIBUTION_REPOSITORY} repository.`);
	}
	parseReleaseTag(values.get("--release-tag"));
	return {
		allowDraft: allowDraft === "true",
		releaseDir: values.get("--release-dir"),
		repository,
		tag: values.get("--release-tag"),
	};
}

export async function prepareReleaseAssets(options) {
	const token = options.token;
	if (typeof token !== "string" || token.length === 0) throw new Error("GH_TOKEN is required.");
	const fetchImpl = options.fetchImpl ?? fetch;
	const release = await fetchReleaseMetadata({ ...options, fetchImpl, token });
	const expectedAssetNames = expectedReleaseAssetsForTag(options.tag);
	await downloadReleaseAssets({
		expectedAssetNames,
		fetchImpl,
		release,
		releaseDir: options.releaseDir,
		repository: options.repository,
		token,
	});
	return { assetCount: expectedAssetNames.length, draft: release.draft, tag: release.tag_name };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const result = await prepareReleaseAssets({
			...parseArguments(process.argv.slice(2)),
			token: process.env.GH_TOKEN,
		});
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch (error) {
		process.stderr.write(`Release asset preparation failed: ${error.message}\n`);
		process.exitCode = 1;
	}
}
