// Magenta session viewer: pure helpers (no DOM, no network), shared by the page
// script and the unit tests in .github/scripts/session-viewer.test.mjs.
//
// A /share link looks like  <viewer>/session/#<gist-id>[&leafId=<id>&targetId=<id>]
// The gist holds one self-contained HTML export written by `magenta /share`.
// Everything read from GitHub is untrusted: it is only ever placed in a
// sandboxed frame (the export) or in text nodes (the owner's login).

/** Largest export the viewer loads. GitHub serves gist files up to 10 MB through raw URLs. */
export const MAX_EXPORT_BYTES = 10 * 1024 * 1024;

const GIST_ID = /^[0-9a-f]{20,40}$/u;
const ENTRY_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const GIST_PAGE = /^https:\/\/gist\.github\.com\/[^\s"'<>]+$/u;
const RAW_GIST = /^https:\/\/gist\.githubusercontent\.com\/[^\s"'<>]+$/u;

/** A user-facing failure: a short title, an explanation, and optionally a safe link. */
export function failure(title, detail, link) {
	return { ok: false, title, detail, ...(link ? { link } : {}) };
}

/**
 * Read `#<gist-id>[&leafId=..&targetId=..]`. The gist id is validated before any
 * request is made; deep-link ids that do not look like entry ids are dropped.
 */
export function parseShareHash(hash) {
	const raw = String(hash ?? "").replace(/^#/u, "");
	if (!raw) {
		return failure(
			"No session in this link",
			"A Magenta share link ends with # and a GitHub gist id, for example …/session/#0123456789abcdef0123456789abcdef. Create one with /share in Magenta.",
		);
	}
	const [idPart, ...rest] = raw.split("&");
	const gistId = idPart.trim().toLowerCase();
	if (!GIST_ID.test(gistId)) {
		return failure(
			"This is not a valid share link",
			"The part after # must be a GitHub gist id (20 to 40 hexadecimal characters). Check that the link was copied completely.",
		);
	}
	const query = new URLSearchParams(rest.join("&"));
	const params = {};
	for (const key of ["leafId", "targetId"]) {
		const value = query.get(key);
		if (value && ENTRY_ID.test(value)) params[key] = value;
	}
	return { ok: true, gistId, params };
}

export function gistApiUrl(gistId) {
	if (!GIST_ID.test(gistId)) throw new Error("invalid gist id");
	return `https://api.github.com/gists/${gistId}`;
}

export function gistPageUrl(gistId) {
	if (!GIST_ID.test(gistId)) throw new Error("invalid gist id");
	return `https://gist.github.com/${gistId}`;
}

/** Explain a non-OK GitHub response. `header(name)` returns a header value or null. */
export function describeHttpFailure(status, header, gistId, now = Date.now()) {
	const gistLink = { href: gistPageUrl(gistId), text: "Open the gist on GitHub" };
	if (status === 404) {
		return failure(
			"Session not found",
			"GitHub has no gist with this id. It may have been deleted by the person who shared it, or the link is incomplete.",
		);
	}
	const remaining = header("x-ratelimit-remaining");
	if ((status === 403 || status === 429) && (remaining === "0" || header("retry-after") !== null)) {
		const reset = Number(header("x-ratelimit-reset"));
		const retryAfter = Number(header("retry-after"));
		let when = "in a few minutes";
		if (Number.isFinite(reset) && reset > 0) {
			const minutes = Math.max(1, Math.ceil((reset * 1000 - now) / 60000));
			when = `in about ${minutes} minute${minutes === 1 ? "" : "s"}`;
		} else if (Number.isFinite(retryAfter) && retryAfter > 0) {
			const minutes = Math.max(1, Math.ceil(retryAfter / 60));
			when = `in about ${minutes} minute${minutes === 1 ? "" : "s"}`;
		}
		return failure(
			"GitHub rate limit reached",
			`GitHub allows 60 anonymous API requests per hour from your network, and they are used up. Try again ${when}, or open the gist on GitHub directly.`,
			gistLink,
		);
	}
	if (status === 403 || status === 451) {
		return failure("GitHub refused the request", `GitHub answered HTTP ${status} for this gist.`, gistLink);
	}
	if (status >= 500) {
		return failure("GitHub is unavailable", `GitHub answered HTTP ${status}. Try again later.`, gistLink);
	}
	return failure("Could not load the session", `GitHub answered HTTP ${status}.`, gistLink);
}

function isExportName(name) {
	return typeof name === "string" && /\.html?$/iu.test(name);
}

/**
 * Pick the HTML export from a gist API response and the facts shown about it.
 * Returns `{ ok, owner, gistUrl, file: { name, size, content?, rawUrl? } }`.
 */
export function selectExport(gist, gistId) {
	if (!gist || typeof gist !== "object" || typeof gist.files !== "object" || gist.files === null) {
		return failure("Unexpected answer from GitHub", "The gist could not be read.");
	}
	const gistUrl =
		typeof gist.html_url === "string" && GIST_PAGE.test(gist.html_url) ? gist.html_url : gistPageUrl(gistId);
	const login = gist.owner && typeof gist.owner.login === "string" ? gist.owner.login : "";
	const owner = GITHUB_LOGIN.test(login) ? { login, url: `https://github.com/${login}` } : null;
	const files = Object.values(gist.files).filter((file) => file && typeof file === "object");
	const candidates = files.filter((file) => isExportName(file.filename));
	const file = candidates.find((candidate) => candidate.filename === "session.html") ?? candidates[0];
	const gistLink = { href: gistUrl, text: "Open the gist on GitHub" };
	if (!file) {
		return failure(
			"No session export in this gist",
			"This gist has no .html file, so it was not created by Magenta's /share.",
			gistLink,
		);
	}
	const size = Number(file.size);
	if (!Number.isFinite(size) || size < 0) return failure("Unexpected answer from GitHub", "The file size is missing.", gistLink);
	if (size > MAX_EXPORT_BYTES) {
		return failure(
			"This session is too large to show here",
			`The export is ${formatBytes(size)}; the viewer shows exports up to ${formatBytes(MAX_EXPORT_BYTES)}. Download it from GitHub and open it locally instead.`,
			gistLink,
		);
	}
	const selected = { name: file.filename, size };
	if (file.truncated === true || typeof file.content !== "string") {
		if (typeof file.raw_url !== "string" || !RAW_GIST.test(file.raw_url)) {
			return failure("Unexpected answer from GitHub", "The export's download address is not a GitHub gist address.", gistLink);
		}
		selected.rawUrl = file.raw_url;
	} else {
		selected.content = file.content;
	}
	return { ok: true, owner, gistUrl, file: selected };
}

export function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function escapeAttribute(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll("'", "&#39;");
}

/**
 * Add the two <meta> tags the export's own script reads when it runs inside a
 * viewer frame: the deep-link parameters, and the base URL its "copy link"
 * buttons should build on (this viewer's address plus #<gist-id>).
 */
export function injectShareMeta(html, { params, shareBaseUrl }) {
	const query = new URLSearchParams();
	if (params.leafId) query.set("leafId", params.leafId);
	if (params.targetId) query.set("targetId", params.targetId);
	const meta =
		`<meta name="pi-url-params" content="${escapeAttribute(query.toString())}">` +
		`<meta name="pi-share-base-url" content="${escapeAttribute(shareBaseUrl)}">`;
	const head = /<head(?:\s[^>]*)?>/iu.exec(html);
	if (!head) return `${meta}${html}`;
	const at = head.index + head[0].length;
	return `${html.slice(0, at)}${meta}${html.slice(at)}`;
}
