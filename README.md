<p align="right"><strong>English</strong> · <a href="README.zh-CN.md">简体中文</a></p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/magenta-mark-on-ink.svg">
    <img alt="Magenta" src="docs/assets/magenta-mark.svg" width="96">
  </picture>
</p>

<h1 align="center">Magenta CLI</h1>

<p align="center">
  <strong>An AI coding agent for your terminal: it reads your project, edits files and runs commands, with the model provider you choose.</strong><br>
  Verified standalone binaries for macOS, Linux and Windows. No Node.js or package manager required.
</p>

<p align="center">
  <a href="https://github.com/Minions-Land/Magenta-CLI/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Minions-Land/Magenta-CLI?label=release&color=EC008C"></a>
  <a href="#supported-platforms"><img alt="Platforms: macOS, Linux, Windows" src="https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-555555"></a>
  <a href="https://github.com/Minions-Land/Magenta-CLI/actions/workflows/ci.yml"><img alt="Distribution checks" src="https://github.com/Minions-Land/Magenta-CLI/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/github/license/Minions-Land/Magenta-CLI?color=555555"></a>
</p>

<p align="center">
  <a href="https://minions-land.github.io/Magenta-CLI/app/"><strong>Try it in your browser</strong></a> ·
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#extend-magenta">Extend</a> ·
  <a href="#update-and-uninstall">Update</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="#get-help">Help</a>
</p>

## What is Magenta?

Magenta is a terminal coding agent. You start it inside a project, describe what you want, and it works through the task with tools: it reads and searches files, edits and writes code, runs shell commands (also in the background), and can hand parts of the work to sub-agents. You stay in control of which model it uses, which tools it may call, and which project files it trusts.

- **Bring your own model.** Sign in with a subscription, use an API key, or point Magenta at your own endpoint.
- **Built for long tasks.** Sessions are saved per project and can be continued, resumed, forked and exported; long conversations are compacted automatically.
- **Scriptable.** The same agent runs interactively, as a one-shot command, or behind a JSON/RPC interface.
- **Extensible.** Harness Packages, MCP servers, extensions, skills and prompt templates add capabilities without rebuilding Magenta.

This repository publishes the installable releases. Every release contains the executables, one runtime resources archive, a `SHA256SUMS` manifest and the installers; the installers verify everything before they activate a new version.

## Try it in your browser

**[Magenta in your browser](https://minions-land.github.io/Magenta-CLI/app/)** is the same chat interface as `magenta web`, running entirely in the web page with your own API key (OpenAI, Anthropic, OpenRouter, Google Gemini) or your own endpoint URL and key (OpenAI Responses, OpenAI Chat Completions or Anthropic Messages; the endpoint must allow requests from web pages).

- **Private by design.** Requests go from your browser directly to the provider you choose; nothing is sent to Magenta's servers (there are none). Keys stay in the tab's memory unless you choose to remember them on your device, and one button forgets all keys and chats.
- **A conversation tree.** Fork from any of your messages, clone a chat, label turns; chats are stored in your browser as Magenta sessions.
- **Any provider, one interface,** with token and prompt-cache statistics for every answer.
- **Auditable files.** Export a chat as session JSONL (opens in the CLI) or as a self-contained HTML file, and import session JSONL.
- **Web search** uses the provider's own search where it offers one (OpenAI, Anthropic), or Tavily with your own key.

The browser app cannot touch your computer. Subscription sign-in (ChatGPT plans), the tools that read and edit your project and run commands, Packages, memory and automatic compaction need the CLI: [install it](#install), then run `magenta`, or `magenta web` for the same interface served by your own machine.

## Install

### macOS / Linux (`v0.1.0+`)

```bash
bootstrap="$(mktemp)"
curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/install.sh -o "$bootstrap"
bash "$bootstrap"
rm -f "$bootstrap"
```

The bootstrap asks the GitHub API for the latest release tag, checks the digest of that release's `install.sh`, and runs it pinned to the tag. The installer downloads the executable for your platform and `magenta-resources-universal.tar.gz`, verifies both against `SHA256SUMS`, and installs to:

```text
~/.local/lib/magenta/        executable and resources
~/.local/bin/magenta         command on your PATH
```

Make sure `~/.local/bin` is on your `PATH`. Set `MAGENTA_INSTALL_DIR` and `MAGENTA_BIN_DIR` before running the bootstrap to install elsewhere. To move to a specific version later, use [`magenta update --version`](#update-and-uninstall).

### Windows x64 (PowerShell)

```powershell
$ErrorActionPreference = "Stop"
$repo = "Minions-Land/Magenta-CLI"
$release = Invoke-RestMethod "https://api.github.com/repos/Minions-Land/Magenta-CLI/releases/latest"
$tag = [string]$release.tag_name
if ($tag -cnotmatch '^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw "Invalid release tag: $tag" }
$assets = @($release.assets | Where-Object { $_.name -ceq "install.ps1" })
if ($assets.Count -ne 1 -or $assets[0].state -cne "uploaded") { throw "Release has no unique installer" }
$asset = $assets[0]
if ([int64]$asset.size -le 0 -or [int64]$asset.size -gt 16MB) { throw "Installer size is invalid" }
if ([string]$asset.digest -cnotmatch '^sha256:(?<hash>[0-9a-f]{64})$') { throw "Installer digest is invalid" }
$expectedHash = $Matches.hash
$installer = Join-Path ([IO.Path]::GetTempPath()) ("magenta-install-" + [guid]::NewGuid() + ".ps1")
try {
  Invoke-WebRequest -UseBasicParsing "https://github.com/$repo/releases/download/$tag/install.ps1" -OutFile $installer
  if ((Get-Item -LiteralPath $installer).Length -ne [int64]$asset.size) { throw "Installer size mismatch" }
  if ((Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedHash) { throw "Installer digest mismatch" }
  & $installer -Version $tag
} finally {
  Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue
}
```

This installs to `%LOCALAPPDATA%\Magenta` and adds it to your user `PATH`; open a new terminal afterwards. To choose a directory without changing `PATH`, replace the `& $installer -Version $tag` line with `& $installer -Version $tag -InstallDir "D:\Tools\Magenta" -NoPath`.

### Check the installation

```bash
magenta --version
```

prints the installed version, for example `0.7.1`. `magenta --help` lists every option; it starts like this:

```text
Magenta - AI coding assistant with file, shell, and background work tools

Usage:
  magenta [options] [@files...] [messages...]

Commands:
  magenta install <source> [-l]     Install extension source and add to settings
  magenta remove <source> [-l]      Remove extension source from settings
  magenta uninstall <source> [-l]   Alias for remove
  magenta update [source|self|magenta]   Update Magenta (use --all for Magenta and extensions,
                                           --version <X.Y.Z> to pin, --rollback to restore the previous version)
  magenta list                      List installed extensions from settings
  magenta config                    Open TUI to enable/disable package resources
  magenta relay <command>           Add, start, stop, inspect, or diagnose SSH mailbox relays
  magenta hcp check <package-root>  Validate one local Harness Package (all profiles; --profile, --assemble)
  magenta hcp list | prune [--yes]  Show the Harness Package cache; prune it and the local component store (dry run without --yes)
  magenta hcp use | status | reset | log | diff | rollback  Local HCP components: select, inspect, history (--scope user|project|session)
  magenta hcp contract | schema | types | new | check --conformance  Author local HCP components
  magenta doctor [--json]           Read-only health report (install, config, credentials, network)
  magenta checkpoints list | restore <n> [--force]  List or restore file checkpoints (--harness-file-checkpoints)
  magenta sessions search <query> [--all]  Search saved Session transcripts, tool results included
  magenta web [--port <n>] [--no-open]  Local web chat UI on 127.0.0.1 (web Tools only; see docs/web.md)
  magenta <command> --help          Show help for install/remove/uninstall/update/list/relay/hcp/doctor/checkpoints/sessions/web
```

> [!NOTE]
> macOS builds are not signed with an Apple Developer ID or notarized. If Gatekeeper blocks the first start, allow it in **System Settings → Privacy & Security**.

### Supported platforms

| Platform | Release asset |
|---|---|
| macOS, Apple Silicon | `magenta-macos-arm64` |
| macOS, Intel | `magenta-macos-x64` |
| Linux x64 | `magenta-linux-x64` |
| Windows x64 | `magenta-windows-x64.exe` |

Every platform also needs `magenta-resources-universal.tar.gz` from the same release; the installers handle this. To download and verify files by hand, see [Manual download](#manual-download).

### Networks in mainland China

Large downloads from GitHub can be slow. Set a payload mirror before installing or updating:

```bash
export MAGENTA_GITHUB_MIRROR=https://ghfast.top
```

```powershell
$env:MAGENTA_GITHUB_MIRROR = "https://ghfast.top"
```

The mirror is used only for the executable and the resources archive. Release metadata and the checksums still come directly from GitHub (`api.github.com`), so a mirror cannot substitute both a file and the checksum that verifies it; if `api.github.com` itself is unreachable, fix that network path first. Public mirrors come and go. Other prefixes that worked at the time of writing are `https://gh-proxy.com`, `https://ghproxy.net` and `https://gh.llkk.cc`. Add the `export` line to `~/.bashrc` or `~/.zshrc` so `magenta update self` uses it too.

## Quick start

1. **Start Magenta in your project.**

   ```bash
   cd /path/to/your/project
   magenta
   ```

2. **Sign in or add a key.** Type `/login` and choose a subscription sign-in (for example *ChatGPT sign-in for Magenta*, *Codex sign-in* or *GitHub Copilot*), an API-key provider, or an endpoint URL with its key. `/login chatgpt` and `/login codex` go straight to the two OpenAI plan sign-ins; Codex sign-in uses a device code, so it also works over SSH. Credentials are stored in `~/.magenta/agent/auth.json`. Environment variables work too:

   ```bash
   export OPENAI_API_KEY=...      # or ANTHROPIC_API_KEY, GEMINI_API_KEY, ...
   magenta
   ```

   Magenta can also reuse an existing Claude Code (`~/.claude/settings.json`) or Codex (`~/.codex/auth.json`, `~/.codex/config.toml`) API-key configuration.

3. **On a server, or with your own endpoint, use `/api`.** `/api add <name> <url>` saves an endpoint URL together with its API key (entered in a masked dialog) for the current provider (`anthropic`, `openai` or `google`), and switches to it. `/api` lists saved routes, `/api <name>` switches between them, and `/api remove <name>` deletes one. Routes are kept owner-only in `~/.magenta/agent/api-routes.json`.

4. **Pick a model.** `/model` (or Ctrl+L) selects a model; Shift+Tab cycles the reasoning levels that model supports. `magenta --list-models` lists models from the command line.

5. **Ask for something.**

   ```text
   Summarize this repository and run its documented checks.
   ```

   For a one-shot run that prints the answer and exits, use `magenta -p "..."`. Continue the last session with `magenta -c`, or pick one with `magenta -r`.

Magenta reads `AGENTS.md` (and `CLAUDE.md`) from your project for project instructions. Project-local files, including these instruction files, are trusted per project: use `/trust`, or `--approve` / `--no-approve` for one run. In a project that needs a trust decision and has none, non-interactive runs (`-p`, JSON, RPC, app server) load only your global instruction files.

## Features

> [!IMPORTANT]
> This section describes the latest published release, **v0.7.1**. See the [release notes](https://github.com/Minions-Land/Magenta-CLI/releases) for what changed in each version; features appear here only once they are released.

**Upgrading from v0.6.x:**
- The `terminal`, `lsp` and `bg_shell` tools are removed. Run interactive programs inside `tmux` through `bash`; slow `bash` commands still move to the background on their own, and `stop_bash` stops one. `--tools` now reports a removed tool as unknown.
- `create_notebook` and `add_cell` moved into the `AutOmicScience` and `PantheonOS` Harness Packages (same names and arguments) and need `python3` on `PATH`.
- The `memory_retain`, `memory_recall` and `memory_forget` tools and their `.magenta/memory/` store are replaced by file memory. Magenta no longer reads the old store; copy any note worth keeping into the new memory folder (`/memory` shows it) and delete `.magenta/memory/`.
- `todo` now takes the complete list on every call and is on by default; todo lists saved by earlier versions are not restored.
- Project `AGENTS.md` / `CLAUDE.md` files follow project trust: in a project that needs a trust decision and has none, print, JSON, RPC and app-server runs load only the global instruction files. Pass `--approve` or trust the project.
- `--validate-config` exits with status 1 for unknown, mistyped or out-of-range settings, and a print or JSON run stopped after repeated invalid tool calls ends with `status: "error"` and exit code 1. `steer` and `follow_up` sent to an idle session over RPC, the app server or the SDK now start a turn.
- The first request after upgrading rebuilds the prompt cache once, because the default tool set and system prompt changed.

From v0.5.x, also note that the web tools are called `web_search` and `web_fetch` (the old `web-search` / `web-fetch` names are not aliases), and Claude plan sign-in is removed: use an Anthropic API key or a compatible endpoint and key (`/api`).

**Agent and tools**
- File tools (`read`, `edit`, `write`, `grep`, `find`) and `bash`, plus provider-neutral `web_search` and `web_fetch` tools.
- A Claude Code–style `todo` list in the default tool set, docked between the transcript and the editor (`Alt+T` or `/todo` collapses it).
- Slow `bash` commands move to the background on their own and write their full output to a log file; `stop_bash` stops one. Parallel sub-agents and workflows (`sub_agent`, with optional cost and token budgets), and persistent teammates (`multiagent`).
- Reasoning profiles from `off` to `ultra` (`--thinking`; Shift+Tab in the interface).
- Precise control of what the model may call: `--tools`, `--exclude-tools`, `--lock-tools`, and `--harness-<capability>` / `--no-harness-<capability>` switches. These control tool visibility; they are not an operating-system sandbox.

**Models and providers**
- Subscription sign-in through `/login`, including the OpenAI plan sign-ins `/login chatgpt` and `/login codex` with models listed per account; API keys from the environment or the auth file, and reuse of supported Claude Code / Codex key files.
- Endpoint URL + API key routes, set up from `/login` or `/api`, each pinned to its own key.
- Prompt-cache controls (`--cache-retention none|short|long|auto`) and optional local cache telemetry.
- OpenAI: tool calls no longer fill every optional parameter (function tools are sent with `strict: false` on the official endpoint and Codex sign-in), and new sessions on the official endpoint start with a warm prompt cache.

**Working alongside the agent**
- Side questions: `/btw <question>` is answered by a read-only fork of the conversation while the agent keeps working, reusing its prompt cache; you decide whether the answer reaches the main agent, or promote it to a background task.
- Send now (Ctrl+Enter or Alt+S) interrupts the reply, or moves a running `bash` command to the background, and delivers your message at once. Queued messages are no longer lost when you switch sessions.
- File memory, on by default in interactive sessions: each repository has Markdown memory files the model keeps with its ordinary file tools, and an index loaded at session start. `/memory` opens them or switches memory off (`--no-harness-memory`, `harness.memory: false`). Memory is off in print, JSON, RPC and app-server runs.

**Sessions**
- Sessions are saved per project: continue (`-c`), resume (`-r`, `/resume`), fork, and navigate the session tree (`/tree`). `magenta sessions search <query>` and a full-transcript search in `/resume` find past sessions by anything they contain.
- Automatic context compaction for long sessions: the summary is prepared in the background during long runs and installed without a wait, also while idle just before the prompt cache expires. Recently used files are re-read into the new context window.
- File checkpoints (opt-in, `--harness-file-checkpoints`): `/rewind` undoes the file changes of any earlier turn, with or without the conversation; `magenta checkpoints` does the same from the command line.
- Context recall (on by default): the `context_recall` tool fetches exact text from the session, including turns removed by compaction, and optionally from past sessions of the project. Context sharing (opt-in, `--harness-context-share`) passes that text verbatim to sub-agents and teammates.
- Export a session to a self-contained HTML file with `/export` or `magenta --export <session-file>`.

**Browser**
- `magenta web` opens a local browser chat on 127.0.0.1, driven by the same session runtime as the CLI, with a fixed set of web tools (no shell or file tools). The [hosted web app](https://minions-land.github.io/Magenta-CLI/app/) needs no install and runs with your own key or endpoint. Both are in English and Simplified Chinese.

**Automation and integration**
- One-shot mode (`-p`), JSON event output, RPC and app-server modes (`--mode json|rpc|app-server`).
- Run limits for unattended use: `--run-timeout`, `--background-policy`, `--hard-budget`, `--max-child-agents`.
- `--validate-config` checks models, credentials and resources without calling a model.
- Run tools on another machine over SSH (`--ssh user@host`) and manage SSH mailbox relays (`magenta relay`).

**Installation and updates**
- Verified self-update (`magenta update self`), installation of an exact version (`--version <X.Y.Z>`), and rollback to the previous installation (`--rollback`).

## Extend Magenta

Magenta's built-in tools and behaviours are assembled as components through the **Harness Component Protocol (HCP)**: each component fills a named role with a fixed contract. A **Harness Package** adds components through the same contracts, so a domain system (its tools, skills and prompts) plugs into Magenta without changing Magenta itself.

- **Use an official Package.** Inside Magenta, `/harness package` lists the official downloadable Packages (currently `Cardiomni` and `ClaudeScience`, published as releases of this repository). **Download & load** verifies the archive and stores it under `~/.magenta/harness-packages`.
- **Select a Package from GitHub or a local folder** with `--harness-package`:

  ```bash
  magenta --harness-package 'github:owner/repository/PackageName@version:profile'
  magenta --harness-packages-root /trusted/package-root --harness-package PackageName
  ```

  Downloads are checked against the release's `.sha256` file, and the first verified digest of each version is recorded so a silently replaced archive is rejected. Add `#sha256=<hex>` to pin a digest yourself.
- **Build your own.** `magenta hcp check <package-root>` validates a local Package; `magenta --harness-list` shows the components and Sources in use. Packages can add entries to the `/` menu; menu protocol v2 adds typed arguments, conditions, state badges and capability toggles.
- **Replace a built-in tool with your own.** `magenta hcp use` swaps the implementation behind an open built-in tool (`grep`, `read`, `ls`, `find`, `web_fetch`, `web_search`) for your own local Source, scoped to your user, a project or one session. You approve each one at your terminal by typing its digest; `magenta hcp log` and `magenta hcp rollback` keep the history and undo a change. With `--harness-hcp-propose` (off by default) the agent can propose a component, and only you can approve it.
- **Lighter extensions.** `magenta install <source>` adds extensions, skills, prompt templates and themes; MCP servers are configured in `~/.magenta/agent/mcp-servers.json`.

### Documentation

Every release ships its full user documentation in the resources archive, and the installers place it beside the executable:

| System | Documentation folder |
|---|---|
| macOS / Linux | `~/.local/lib/magenta/docs/` |
| Windows | `%LOCALAPPDATA%\Magenta\docs\` |

Start with `index.md` and `quickstart.md`. For the topics above, see `providers.md` (sign-in, API keys, `/api`), `usage.md`, `sessions.md`, `memory.md`, `todo-list.md`, `async.md`, `web.md`, `file-checkpoints.md`, `context-recall.md`, `context-sharing.md`, `compaction.md`, `harness-packages.md`, `packages.md`, `mcp.md`, `settings.md` and `troubleshooting.md`.

## Update and uninstall

```bash
magenta update self               # update to the latest release
magenta update --version 0.6.0    # install an exact release, older or newer
magenta update --rollback         # restore the previous installation
```

Updates use the same verification as the installer and keep your settings, credentials and sessions. `magenta --update` is an older alias for `magenta update self`.

**Uninstall on macOS / Linux** with the same bootstrap as the installation:

```bash
bootstrap="$(mktemp)"
curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/install.sh -o "$bootstrap"
bash "$bootstrap" --uninstall
rm -f "$bootstrap"
```

**Uninstall on Windows:** run the installation command above with `& $installer -Version $tag` replaced by `& $installer -Uninstall`.

Uninstalling removes only the installed release and its `PATH` entry. Your settings, credentials, sessions and caches in `~/.magenta` stay; delete that folder yourself if you no longer need them. If you installed with a custom `MAGENTA_INSTALL_DIR` / `MAGENTA_BIN_DIR`, set the same values when uninstalling.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `magenta: command not found` | Add `~/.local/bin` to `PATH` (macOS / Linux), or open a new terminal after the Windows installer changed `PATH`. |
| `Could not fetch latest release` | `api.github.com` is unreachable or rate-limited. A payload mirror does not help here; check your network or proxy. |
| HTTP 403 from the GitHub API | The anonymous limit of 60 requests per hour is used up. Wait for the reset, or set `MAGENTA_GITHUB_TOKEN` to a token that can read public repositories. |
| Downloads are slow | Set `MAGENTA_GITHUB_MIRROR` (see [Networks in mainland China](#networks-in-mainland-china)) and run the installer or `magenta update self` again. |
| Verification failed | The download was corrupted or altered. Run the installer again; it never activates an unverified file. |
| An old version cannot update itself | Releases from before the current asset layout cannot install new ones. Run the installation command again. |
| Sign-in, model or tool problems | Run `magenta doctor` for a read-only health report, `magenta --validate-config` to check credentials, models and resources without calling a model, and `magenta --verbose` for startup details. `troubleshooting.md` in the [documentation folder](#documentation) covers more cases. |

## Get help

- **Bugs and questions:** [open an issue](https://github.com/Minions-Land/Magenta-CLI/issues) in this repository. Include the output of `magenta --version`, your operating system, and the steps to reproduce.
- **Release history:** [Releases](https://github.com/Minions-Land/Magenta-CLI/releases). Each release lists its changes and records the source commit it was built from in `SOURCE_COMMIT`.
- **Security issues:** please do not post exploit details in a public issue; open an issue asking for a private contact instead.

## Security and verification

- Releases are built by a release workflow from a tagged source commit and published here only after the exact asset set has been checked.
- `SHA256SUMS` covers every payload of a release; installers and updates refuse files that do not match it or the digests GitHub reports for the release assets.
- New versions are staged and started before they replace the active installation, so a failed update leaves the previous version in place.

<a id="manual-download"></a>
<details>
<summary><strong>Manual download and checksum verification</strong></summary>

Choose one exact tag and download the platform executable, the resources archive and the manifest from that same tag:

```bash
tag="<exact-release-tag>"
base="https://github.com/Minions-Land/Magenta-CLI/releases/download/$tag"
asset="magenta-linux-x64" # or magenta-macos-arm64, magenta-macos-x64, or magenta-windows-x64.exe
curl -fL "$base/$asset" -o "$asset"
curl -fL "$base/magenta-resources-universal.tar.gz" -o magenta-resources-universal.tar.gz
curl -fL "$base/SHA256SUMS" -o SHA256SUMS
awk -v target="$asset" '$2 == target || $2 == "magenta-resources-universal.tar.gz"' SHA256SUMS > SHA256SUMS.selected
test "$(wc -l < SHA256SUMS.selected | tr -d " ")" = 2
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c SHA256SUMS.selected
else
  shasum -a 256 -c SHA256SUMS.selected
fi
```

This verifies the files; it does not install them. With a mirror, download the two large files through it but fetch `SHA256SUMS` directly from GitHub.
</details>

<a id="unix-v0-0-29-manual-transition"></a>
<details>
<summary><strong>Unix v0.0.29 manual transition</strong> (only for the old v0.0.29 release)</summary>

`v0.0.29` predates the release-bound Unix installer, so the bootstrap above refuses to install it. This fixed procedure pins the tag and the reviewed manifest digest, downloads only that release's executable, resources and `SHA256SUMS`, and never downloads or runs a remote shell script. It installs into a new versioned directory and stops before writing anything if that directory or `~/.local/bin/magenta` already exists. From `v0.1.0` on, use the bootstrap above.

```bash
set -eu
umask 077

tag="v0.0.29"
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) asset="magenta-macos-arm64" ;;
  Darwin:x86_64) asset="magenta-macos-x64" ;;
  Linux:x86_64) asset="magenta-linux-x64" ;;
  *) echo "Unsupported platform for Magenta v0.0.29" >&2; exit 1 ;;
esac

base="https://github.com/Minions-Land/Magenta-CLI/releases/download/$tag"
manifest_sha256="f61d38f8d9c7838a77b9e79d3c33d322fc328cb22c713a304614797f5e986d21"
install_dir="$HOME/.local/lib/magenta-$tag"
entrypoint="$HOME/.local/bin/magenta"

if [ -e "$install_dir" ] || [ -L "$install_dir" ] || [ -e "$entrypoint" ] || [ -L "$entrypoint" ]; then
  echo "Refusing to overwrite an existing Magenta installation." >&2
  exit 1
fi

download_dir="$(mktemp -d "${TMPDIR:-/tmp}/magenta-v0.0.29.XXXXXXXX")"
cleanup() { rm -rf "$download_dir"; }
trap cleanup EXIT HUP INT TERM
cd "$download_dir"

curl -fL "$base/$asset" -o "$asset"
curl -fL "$base/magenta-resources-universal.tar.gz" -o magenta-resources-universal.tar.gz
curl -fL "$base/SHA256SUMS" -o SHA256SUMS

verify_checksums() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$1"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c "$1"
  else
    echo "Neither sha256sum nor shasum is available." >&2
    return 1
  fi
}

printf '%s  %s\n' "$manifest_sha256" SHA256SUMS > SHA256SUMS.root
verify_checksums SHA256SUMS.root
awk -v binary="$asset" '
  NF == 2 && $2 == binary && length($1) == 64 && $1 !~ /[^0-9a-f]/ { binary_count++; print }
  NF == 2 && $2 == "magenta-resources-universal.tar.gz" && length($1) == 64 && $1 !~ /[^0-9a-f]/ { resource_count++; print }
  END { if (binary_count != 1 || resource_count != 1) exit 1 }
' SHA256SUMS > SHA256SUMS.selected
verify_checksums SHA256SUMS.selected

mkdir -p "$HOME/.local/lib" "$HOME/.local/bin"
mkdir "$install_dir"
tar -xzf magenta-resources-universal.tar.gz -C "$install_dir"
cp "$asset" "$install_dir/magenta"
chmod 755 "$install_dir/magenta"
version="$("$install_dir/magenta" --version)"
test "$version" = "0.0.29"
"$install_dir/magenta" --help >/dev/null
ln -s "$install_dir/magenta" "$entrypoint"

printf 'Installed Magenta %s at %s\n' "$version" "$entrypoint"
```

This path does not overwrite an earlier installation. If `~/.local/bin/magenta` already exists, decide whether to keep, migrate or remove it first; do not turn the refusal check into a forced overwrite.
</details>

## Repository contents

| Path | Purpose |
|---|---|
| `install.sh` | The Unix bootstrap used above: resolves the latest tag and runs that release's verified installer. |
| `.github/` | Checks for this repository and the published releases. |
| `docs/` | The project website (GitHub Pages), including a viewer for shared session exports, and the Magenta logo files. |
| `docs/app/` | Magenta in your browser: the minified web app bundle and its static assets (`build-info.json` records the source commit and file digests; `LICENSES.txt` lists the bundled packages). |
| `docs/catalog/` | The public model catalog Magenta reads for model updates, generated from the model data built into the release (see `docs/catalog/README.md`). |
| `LICENSE`, `THIRD-PARTY-NOTICES.md` | The MIT licence of Magenta CLI and the third-party notices. |

Product source code is not published in this repository.

## Licence and third-party notices

Magenta CLI is released under the [MIT Licence](LICENSE). It is derived from the [Pi](https://github.com/earendil-works/pi) coding agent by Mario Zechner and contributors, used under the MIT Licence; [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) reproduces Pi's notice. Third-party software bundled in a release, including the npm packages in the executable, the embedded ripgrep executables and the [marked](https://github.com/markedjs/marked) and [highlight.js](https://github.com/highlightjs/highlight.js) libraries in HTML exports, remains under its own licence. Since v0.6.0, each release ships the full notices in `docs/THIRD-PARTY-NOTICES.md`, next to the `magenta` executable after installation.

The Magenta name and mark are the project's brand assets.
