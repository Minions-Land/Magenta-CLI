import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	MAX_EXPORT_BYTES,
	describeHttpFailure,
	injectShareMeta,
	parseShareHash,
	selectExport,
} from "../../docs/session/viewer-core.js";

const ID = "0123456789abcdef0123456789abcdef";
const headers = (values) => (name) => values[name] ?? null;
const page = readFileSync(new URL("../../docs/session/index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../../docs/session/viewer.js", import.meta.url), "utf8");

test("share links carry a validated gist id and optional deep-link ids in the fragment", () => {
	assert.deepEqual(parseShareHash(`#${ID}`), { ok: true, gistId: ID, params: {} });
	assert.deepEqual(parseShareHash(`#${ID.toUpperCase()}&leafId=a1b2c3d4&targetId=e5f6`), {
		ok: true,
		gistId: ID,
		params: { leafId: "a1b2c3d4", targetId: "e5f6" },
	});
	assert.deepEqual(parseShareHash(`#${ID}&leafId=<script>&targetId=ok`).params, { targetId: "ok" });
	for (const bad of ["", "#", "#abc", "#../../users/octocat", `#${ID}0123456789`, "#zzzzzzzzzzzzzzzzzzzzzzzz", "#https://evil.example/"]) {
		const result = parseShareHash(bad);
		assert.equal(result.ok, false, bad);
		assert.ok(result.title.length > 0);
	}
});

test("GitHub failures become clear messages: missing, rate-limited, refused, unavailable", () => {
	const now = Date.UTC(2026, 0, 1, 12, 0, 0);
	assert.equal(describeHttpFailure(404, headers({}), ID).title, "Session not found");
	const limited = describeHttpFailure(
		403,
		headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 600) }),
		ID,
		now,
	);
	assert.equal(limited.title, "GitHub rate limit reached");
	assert.match(limited.detail, /in about 10 minutes/u);
	assert.equal(limited.link.href, `https://gist.github.com/${ID}`);
	assert.equal(describeHttpFailure(429, headers({ "retry-after": "60" }), ID, now).title, "GitHub rate limit reached");
	assert.equal(describeHttpFailure(403, headers({ "x-ratelimit-remaining": "12" }), ID).title, "GitHub refused the request");
	assert.equal(describeHttpFailure(502, headers({}), ID).title, "GitHub is unavailable");
});

test("the export is the gist's HTML file; owner, links and size are validated", () => {
	const gist = {
		html_url: `https://gist.github.com/octocat/${ID}`,
		owner: { login: "octocat" },
		files: {
			"notes.txt": { filename: "notes.txt", size: 3, content: "hey" },
			"session.html": { filename: "session.html", size: 20, content: "<html><head></head></html>" },
		},
	};
	const selected = selectExport(gist, ID);
	assert.equal(selected.ok, true);
	assert.deepEqual(selected.owner, { login: "octocat", url: "https://github.com/octocat" });
	assert.equal(selected.file.name, "session.html");
	assert.equal(selected.file.content, "<html><head></head></html>");

	const hostile = selectExport(
		{ ...gist, html_url: "javascript:alert(1)", owner: { login: '"><img src=x onerror=alert(1)>' } },
		ID,
	);
	assert.equal(hostile.owner, null);
	assert.equal(hostile.gistUrl, `https://gist.github.com/${ID}`);

	const truncated = selectExport(
		{ files: { "session.html": { filename: "session.html", size: 2_000_000, truncated: true, raw_url: `https://gist.githubusercontent.com/octocat/${ID}/raw/abc/session.html` } } },
		ID,
	);
	assert.equal(truncated.ok, true);
	assert.match(truncated.file.rawUrl, /^https:\/\/gist\.githubusercontent\.com\//u);
	const offsite = selectExport(
		{ files: { "session.html": { filename: "session.html", size: 2_000_000, truncated: true, raw_url: "https://evil.example/x" } } },
		ID,
	);
	assert.equal(offsite.ok, false);

	const huge = selectExport({ files: { "s.html": { filename: "s.html", size: MAX_EXPORT_BYTES + 1, truncated: true } } }, ID);
	assert.equal(huge.ok, false);
	assert.equal(huge.title, "This session is too large to show here");
	assert.equal(selectExport({ files: { "a.jsonl": { filename: "a.jsonl", size: 1, content: "{}" } } }, ID).title, "No session export in this gist");
	assert.equal(selectExport(null, ID).ok, false);
});

test("deep-link metadata is added to the export head, escaped", () => {
	const html = injectShareMeta("<!DOCTYPE html><html><head><title>x</title></head><body></body></html>", {
		params: { leafId: "a1", targetId: "b2" },
		shareBaseUrl: `https://minions-land.github.io/Magenta-CLI/session/#${ID}`,
	});
	assert.match(html, /<head><meta name="pi-url-params" content="leafId=a1&amp;targetId=b2"><meta name="pi-share-base-url" content="https:\/\/minions-land\.github\.io\/Magenta-CLI\/session\/#0123456789abcdef0123456789abcdef"><title>/u);
	const quoted = injectShareMeta("<body>no head</body>", { params: {}, shareBaseUrl: 'x" onload="alert(1)' });
	assert.ok(quoted.startsWith('<meta name="pi-url-params" content="">'));
	assert.ok(quoted.includes('content="x&quot; onload=&quot;alert(1)"'));
});

test("the page isolates the export: sandbox without same-origin, strict CSP, no third-party resources", () => {
	const sandbox = script.match(/const FRAME_SANDBOX = "([^"]+)"/u)?.[1];
	assert.ok(sandbox);
	assert.ok(sandbox.split(" ").includes("allow-scripts"));
	assert.ok(!sandbox.includes("allow-same-origin"));
	assert.ok(!sandbox.includes("allow-top-navigation"));
	assert.ok(!sandbox.includes("allow-forms"));
	assert.match(script, /frame\.srcdoc = html/u);
	assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/u);
	const csp = page.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/u)?.[1];
	assert.ok(csp);
	assert.match(csp, /default-src 'none'/u);
	assert.match(csp, /connect-src https:\/\/api\.github\.com https:\/\/gist\.githubusercontent\.com;/u);
	assert.match(csp, /form-action 'none'/u);
	assert.match(csp, /base-uri 'none'/u);
	for (const [, url] of page.matchAll(/(?:src|href)="([^"]+)"/gu)) {
		assert.ok(!/^(?:https?:)?\/\//u.test(url), `third-party resource: ${url}`);
	}
});
