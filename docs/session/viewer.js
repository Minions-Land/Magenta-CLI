// Magenta session viewer: page script. Fetches the gist named in the URL
// fragment from the public GitHub API and shows its HTML export in a sandboxed
// frame. Untrusted gist content never enters this page's DOM: the export goes
// into <iframe sandbox="allow-scripts ..."> (no allow-same-origin, so it runs
// in an opaque origin without access to this page), and only the validated
// owner login, file name and size are written here, as text.

import {
	MAX_EXPORT_BYTES,
	describeHttpFailure,
	failure,
	formatBytes,
	gistApiUrl,
	injectShareMeta,
	parseShareHash,
	selectExport,
} from "./viewer-core.js";

const REQUEST_TIMEOUT_MS = 30_000;
const FRAME_SANDBOX = "allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox";

const elements = {
	status: document.getElementById("status"),
	statusTitle: document.getElementById("status-title"),
	statusDetail: document.getElementById("status-detail"),
	statusLink: document.getElementById("status-link"),
	share: document.getElementById("share-info"),
	owner: document.getElementById("owner"),
	file: document.getElementById("file"),
	gistLink: document.getElementById("gist-link"),
	stage: document.getElementById("stage"),
};

let generation = 0;

function showStatus(title, detail, link) {
	elements.status.hidden = false;
	elements.statusTitle.textContent = title;
	elements.statusDetail.textContent = detail ?? "";
	if (link) {
		elements.statusLink.href = link.href;
		elements.statusLink.textContent = link.text;
		elements.statusLink.hidden = false;
	} else {
		elements.statusLink.hidden = true;
		elements.statusLink.removeAttribute("href");
	}
}

function showFailure(result) {
	elements.stage.replaceChildren();
	showStatus(result.title, result.detail, result.link);
	document.title = "Magenta session viewer";
}

async function fetchWithTimeout(url, accept) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		return await fetch(url, {
			headers: { Accept: accept },
			credentials: "omit",
			referrerPolicy: "no-referrer",
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
	}
}

function networkFailure(error) {
	const timedOut = error && error.name === "AbortError";
	return failure(
		timedOut ? "GitHub did not answer in time" : "Could not reach GitHub",
		timedOut
			? "The request to GitHub took longer than 30 seconds. Try again."
			: "The viewer loads the session from api.github.com in your browser. Check your network connection or extensions that block requests, then try again.",
	);
}

async function readBoundedText(response, gistUrl) {
	const declared = Number(response.headers.get("content-length"));
	const tooLarge = failure(
		"This session is too large to show here",
		`The viewer shows exports up to ${formatBytes(MAX_EXPORT_BYTES)}. Download it from GitHub and open it locally instead.`,
		{ href: gistUrl, text: "Open the gist on GitHub" },
	);
	if (Number.isFinite(declared) && declared > MAX_EXPORT_BYTES) return tooLarge;
	const buffer = await response.arrayBuffer();
	if (buffer.byteLength > MAX_EXPORT_BYTES) return tooLarge;
	return { ok: true, text: new TextDecoder("utf-8").decode(buffer) };
}

function showShareInfo(selection) {
	elements.share.hidden = false;
	if (selection.owner) {
		elements.owner.textContent = `@${selection.owner.login}`;
		elements.owner.href = selection.owner.url;
	} else {
		elements.owner.textContent = "an unknown GitHub account";
		elements.owner.removeAttribute("href");
	}
	elements.file.textContent = `${selection.file.name} · ${formatBytes(selection.file.size)}`;
	elements.gistLink.href = selection.gistUrl;
}

function mountFrame(html) {
	const frame = document.createElement("iframe");
	frame.setAttribute("sandbox", FRAME_SANDBOX);
	frame.setAttribute("referrerpolicy", "no-referrer");
	frame.setAttribute("title", "Shared Magenta session (isolated)");
	frame.className = "session-frame";
	frame.srcdoc = html;
	elements.stage.replaceChildren(frame);
}

async function load() {
	const current = ++generation;
	const stale = () => current !== generation;
	elements.share.hidden = true;
	elements.stage.replaceChildren();

	const parsed = parseShareHash(window.location.hash);
	if (!parsed.ok) return showFailure(parsed);
	showStatus("Loading the shared session…", "Fetching the gist from GitHub.");

	let response;
	try {
		response = await fetchWithTimeout(gistApiUrl(parsed.gistId), "application/vnd.github+json");
	} catch (error) {
		if (!stale()) showFailure(networkFailure(error));
		return;
	}
	if (stale()) return;
	if (!response.ok) {
		return showFailure(describeHttpFailure(response.status, (name) => response.headers.get(name), parsed.gistId));
	}

	let gist;
	try {
		gist = await response.json();
	} catch {
		return showFailure(failure("Unexpected answer from GitHub", "The gist could not be read."));
	}
	if (stale()) return;
	const selection = selectExport(gist, parsed.gistId);
	if (!selection.ok) return showFailure(selection);
	showShareInfo(selection);

	let html = selection.file.content;
	if (html === undefined) {
		showStatus("Loading the shared session…", `Downloading ${formatBytes(selection.file.size)} from GitHub.`);
		let raw;
		try {
			raw = await fetchWithTimeout(selection.file.rawUrl, "text/plain");
		} catch (error) {
			if (!stale()) showFailure(networkFailure(error));
			return;
		}
		if (stale()) return;
		if (!raw.ok) {
			return showFailure(describeHttpFailure(raw.status, (name) => raw.headers.get(name), parsed.gistId));
		}
		const body = await readBoundedText(raw, selection.gistUrl);
		if (stale()) return;
		if (!body.ok) return showFailure(body);
		html = body.text;
	}

	const shareBaseUrl = `${window.location.origin}${window.location.pathname}#${parsed.gistId}`;
	elements.status.hidden = true;
	document.title = selection.owner
		? `Session shared by @${selection.owner.login} · Magenta`
		: "Shared session · Magenta";
	mountFrame(injectShareMeta(html, { params: parsed.params, shareBaseUrl }));
}

window.addEventListener("hashchange", () => {
	void load();
});
void load();
