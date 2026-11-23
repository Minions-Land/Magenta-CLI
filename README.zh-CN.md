<p align="right"><a href="README.md">English</a> · <strong>简体中文</strong></p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/magenta-mark-on-ink.svg">
    <img alt="Magenta" src="docs/assets/magenta-mark.svg" width="96">
  </picture>
</p>

<h1 align="center">Magenta CLI</h1>

<p align="center">
  <strong>终端里的 AI 编程 Agent：读懂你的项目、修改文件、运行命令，模型由你选择。</strong><br>
  经过校验的 macOS、Linux、Windows 独立可执行文件，无需 Node.js 或包管理器。
</p>

<p align="center">
  <a href="https://github.com/Minions-Land/Magenta-CLI/releases/latest"><img alt="最新版本" src="https://img.shields.io/github/v/release/Minions-Land/Magenta-CLI?label=release&color=EC008C"></a>
  <a href="#支持的平台"><img alt="平台：macOS、Linux、Windows" src="https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-555555"></a>
  <a href="https://github.com/Minions-Land/Magenta-CLI/actions/workflows/ci.yml"><img alt="分发检查" src="https://github.com/Minions-Land/Magenta-CLI/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="许可证：MIT" src="https://img.shields.io/github/license/Minions-Land/Magenta-CLI?color=555555"></a>
</p>

<p align="center">
  <a href="https://minions-land.github.io/Magenta-CLI/app/"><strong>在浏览器中试用</strong></a> ·
  <a href="#安装">安装</a> ·
  <a href="#快速上手">快速上手</a> ·
  <a href="#功能">功能</a> ·
  <a href="#扩展-magenta">扩展</a> ·
  <a href="#更新与卸载">更新</a> ·
  <a href="#故障排查">故障排查</a> ·
  <a href="#获取帮助">帮助</a>
</p>

## Magenta 是什么？

Magenta 是一个终端编程 Agent。在项目目录中启动它，描述你想完成的事，它会借助工具逐步完成：读取和搜索文件、编辑和写入代码、运行 shell 命令（也可以在后台运行），还能把部分工作交给子 Agent。使用哪个模型、允许调用哪些工具、信任哪些项目文件，都由你决定。

- **自带模型。** 可以用订阅登录、API key，或者接入你自己的 endpoint。
- **适合长任务。** 会话按项目保存，可以继续、恢复、分叉和导出；长对话会自动压缩上下文。
- **可脚本化。** 同一个 Agent 可以交互运行，也可以一次性执行命令，或通过 JSON/RPC 接口集成。
- **可扩展。** Harness Package、MCP 服务器、扩展、技能（skills）和提示模板都能增加能力，无需重新构建 Magenta。

本仓库发布可安装的版本。每个 Release 都包含各平台可执行文件、一个运行时资源包、`SHA256SUMS` 校验清单和安装脚本；安装脚本在启用新版本之前会校验所有文件。

## 在浏览器中试用

**[浏览器版 Magenta](https://minions-land.github.io/Magenta-CLI/app/)** 与 `magenta web` 使用同一套聊天界面，完全运行在网页中，使用你自己的 API key（OpenAI、Anthropic、OpenRouter、Google Gemini），或你自己的 endpoint URL 与 key（OpenAI Responses、OpenAI Chat Completions 或 Anthropic Messages 协议；该 endpoint 必须允许网页直接访问）。

- **隐私优先。** 请求从你的浏览器直接发往你选择的提供商；不会发送到 Magenta 的服务器（我们没有服务器）。key 默认只保存在当前标签页的内存中，除非你选择在本设备上记住；一个按钮即可清除所有 key 和对话。
- **对话树。** 可从你的任意一条消息分叉、克隆对话、给轮次加标签；对话以 Magenta 会话格式保存在你的浏览器中。
- **任意提供商，同一界面，** 每条回答都显示 token 与提示缓存（cache read）统计。
- **可审计的文件。** 可将对话导出为会话 JSONL（可在 CLI 中打开）或自包含的 HTML 文件，并可导入会话 JSONL。
- **网页搜索** 优先使用提供商自带的搜索（OpenAI、Anthropic），否则可用你自己的 Tavily key。

浏览器版无法访问你的电脑。订阅登录（ChatGPT 套餐）、读取和编辑项目及运行命令的工具、Package、记忆以及自动上下文压缩都需要 CLI：先[安装](#安装)，再运行 `magenta`；也可以运行 `magenta web`，在本机提供同一套界面。

## 安装

### macOS / Linux（`v0.1.0+`）

```bash
bootstrap="$(mktemp)"
curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/install.sh -o "$bootstrap"
bash "$bootstrap"
rm -f "$bootstrap"
```

bootstrap 会通过 GitHub API 获取最新的 Release tag，校验该 Release 中 `install.sh` 的摘要，然后以这个 tag 运行它。安装脚本下载对应平台的可执行文件和 `magenta-resources-universal.tar.gz`，用 `SHA256SUMS` 校验两者，并安装到：

```text
~/.local/lib/magenta/        可执行文件和资源
~/.local/bin/magenta         PATH 上的命令
```

请确保 `~/.local/bin` 在 `PATH` 中。如需安装到其他位置，在运行 bootstrap 前设置 `MAGENTA_INSTALL_DIR` 和 `MAGENTA_BIN_DIR`。以后要切换到某个特定版本，请使用 [`magenta update --version`](#更新与卸载)。

### Windows x64（PowerShell）

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

默认安装到 `%LOCALAPPDATA%\Magenta` 并加入用户 `PATH`；安装后请打开一个新终端。若要指定目录且不修改 `PATH`，把 `& $installer -Version $tag` 这一行换成 `& $installer -Version $tag -InstallDir "D:\Tools\Magenta" -NoPath`。

### 检查安装

```bash
magenta --version
```

会输出已安装的版本号，例如 `0.6.0`。`magenta --help` 列出全部选项，开头如下：

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
  magenta web [--port <n>] [--no-open]  Local web chat UI on 127.0.0.1 (web Tools only; see docs/web.md)
  magenta <command> --help          Show help for install/remove/uninstall/update/list/relay/hcp/doctor/checkpoints/web
```

> [!NOTE]
> macOS 版本没有 Apple Developer ID 签名，也未经过公证。如果首次启动被 Gatekeeper 拦截，请在 **系统设置 → 隐私与安全性** 中允许打开。

### 支持的平台

| 平台 | Release 资产 |
|---|---|
| macOS，Apple Silicon | `magenta-macos-arm64` |
| macOS，Intel | `magenta-macos-x64` |
| Linux x64 | `magenta-linux-x64` |
| Windows x64 | `magenta-windows-x64.exe` |

每个平台都还需要同一 Release 中的 `magenta-resources-universal.tar.gz`，安装脚本会自动处理。如需手动下载并校验，见[手动下载](#手动下载)。

### 中国大陆网络

从 GitHub 下载大文件可能很慢。安装或更新前设置一个下载镜像：

```bash
export MAGENTA_GITHUB_MIRROR=https://ghfast.top
```

```powershell
$env:MAGENTA_GITHUB_MIRROR = "https://ghfast.top"
```

镜像只用于下载可执行文件和资源包。Release 元数据和校验值仍直接从 GitHub（`api.github.com`）获取，因此镜像无法同时替换文件和用来校验它的摘要；如果 `api.github.com` 本身无法访问，请先解决这条网络路径。公共镜像时有时无，撰写本文时可用的其他前缀还有 `https://gh-proxy.com`、`https://ghproxy.net` 和 `https://gh.llkk.cc`。把 `export` 这一行加入 `~/.bashrc` 或 `~/.zshrc`，`magenta update self` 也会使用它。

## 快速上手

1. **在项目目录中启动 Magenta。**

   ```bash
   cd /path/to/your/project
   magenta
   ```

2. **登录或添加 key。** 输入 `/login`，选择订阅登录（例如 *ChatGPT sign-in for Magenta*、*Codex sign-in* 或 *GitHub Copilot*）、某个 API key 提供商，或填写 endpoint URL 及其 key。`/login chatgpt` 和 `/login codex` 可直接进入这两种 OpenAI 套餐登录；Codex 登录使用设备码，因此在 SSH 下也能用。凭据保存在 `~/.magenta/agent/auth.json`。也可以使用环境变量：

   ```bash
   export OPENAI_API_KEY=...      # 或 ANTHROPIC_API_KEY、GEMINI_API_KEY 等
   magenta
   ```

   Magenta 也能复用已有的 Claude Code（`~/.claude/settings.json`）或 Codex（`~/.codex/auth.json`、`~/.codex/config.toml`）API key 配置。

3. **在服务器上，或使用自己的 endpoint 时，用 `/api`。** `/api add <name> <url>` 为当前提供商（`anthropic`、`openai` 或 `google`）保存一个 endpoint URL 及其 API key（在遮蔽输入框中填写），并切换过去。`/api` 列出已保存的路由，`/api <name>` 在路由间切换，`/api remove <name>` 删除路由。路由保存在仅所有者可读的 `~/.magenta/agent/api-routes.json` 中。

4. **选择模型。** `/model`（或 Ctrl+L）选择模型；Shift+Tab 在该模型支持的推理等级间切换。命令行中可用 `magenta --list-models` 列出模型。

5. **提出需求。**

   ```text
   Summarize this repository and run its documented checks.
   ```

   一次性执行并输出结果后退出：`magenta -p "..."`。继续上一个会话：`magenta -c`；选择一个会话恢复：`magenta -r`。

Magenta 会读取项目中的 `AGENTS.md`（以及 `CLAUDE.md`）作为项目说明。项目本地文件按项目信任：使用 `/trust`，或用 `--approve` / `--no-approve` 只对本次运行生效。

## 功能

> [!IMPORTANT]
> 本节描述最新发布的版本 **v0.6.0**。各版本的变化见 [Release 说明](https://github.com/Minions-Land/Magenta-CLI/releases)；功能只有在发布后才会出现在这里。

**从 v0.5.x 升级：** 网页工具改名为 `web_search` 和 `web_fetch`（旧名 `web-search` / `web-fetch` 在 `--tools`、设置和工具策略中不再作为别名）；Claude 套餐登录已移除，请改用 Anthropic API key，或兼容的 endpoint 与 key（`/api`）。

**Agent 与工具**
- 文件工具（`read`、`edit`、`write`、`grep`、`find`）和 `bash`，以及与提供商无关的 `web_search` 和 `web_fetch` 工具。
- 后台命令（`bg_shell`）、并行子 Agent 和工作流（`sub_agent`，可设置费用和 token 预算），以及常驻队友（`multiagent`）。
- 从 `off` 到 `ultra` 的推理档位（`--thinking`；界面中用 Shift+Tab）。
- 精确控制模型可以调用什么：`--tools`、`--exclude-tools`、`--lock-tools`，以及 `--harness-<capability>` / `--no-harness-<capability>` 开关。它们控制工具可见性，不是操作系统级沙箱。

**模型与提供商**
- 通过 `/login` 订阅登录，包括 OpenAI 套餐登录 `/login chatgpt` 和 `/login codex`，按账号列出可用模型；从环境变量或 auth 文件读取 API key，并可复用受支持的 Claude Code / Codex key 文件。
- endpoint URL + API key 路由，可在 `/login` 或 `/api` 中设置，每个 endpoint 与自己的 key 绑定。
- 提示缓存控制（`--cache-retention none|short|long|auto`）和可选的本地缓存统计。

**会话**
- 会话按项目保存：继续（`-c`）、恢复（`-r`、`/resume`）、分叉，以及浏览会话树（`/tree`）。
- 长会话自动压缩上下文；压缩摘要默认从提示缓存读取对话（`compaction.summaryCache`）。
- 文件检查点（需开启，`--harness-file-checkpoints`）：`/rewind` 可撤销之前任一轮的文件改动，可选是否连同对话一起回退；命令行中用 `magenta checkpoints` 完成同样操作。
- 上下文召回（需开启，`--harness-context-recall`）：`context_recall` 工具可原文取回本会话中的内容（包括已被压缩掉的轮次），也可选择检索本项目过去的会话。上下文共享（需开启，`--harness-context-share`）可把这些原文直接交给子 Agent 和队友。
- 用 `/export` 或 `magenta --export <session-file>` 把会话导出为独立的 HTML 文件。

**浏览器**
- `magenta web` 在 127.0.0.1 上打开本地浏览器聊天，与 CLI 使用同一套会话运行时，只提供固定的网页工具（没有 shell 和文件工具）。[网页版](https://minions-land.github.io/Magenta-CLI/app/)无需安装，使用你自己的 key 或 endpoint。两者都支持英文和简体中文。

**自动化与集成**
- 一次性模式（`-p`）、JSON 事件输出、RPC 和 app-server 模式（`--mode json|rpc|app-server`）。
- 无人值守运行的限制：`--run-timeout`、`--background-policy`、`--hard-budget`、`--max-child-agents`。
- `--validate-config` 检查模型、凭据和资源，不调用模型。
- 通过 SSH 在另一台机器上运行工具（`--ssh user@host`），并管理 SSH 邮箱中继（`magenta relay`）。

**安装与更新**
- 带校验的自更新（`magenta update self`）、安装指定版本（`--version <X.Y.Z>`）和回滚到上一个安装（`--rollback`）。

## 扩展 Magenta

Magenta 的内置工具和行为通过 **Harness Component Protocol（HCP）** 组装成组件：每个组件以固定的契约承担一个具名角色。**Harness Package** 通过同样的契约加入组件，因此一个领域系统（它的工具、技能和提示）可以接入 Magenta，而不需要修改 Magenta 本身。

- **使用官方 Package。** 在 Magenta 中输入 `/harness package`，可以列出可下载的官方 Package（目前是 `Cardiomni` 和 `ClaudeScience`，作为本仓库的 Release 发布）。**Download & load** 会校验压缩包并保存到 `~/.magenta/harness-packages`。
- **从 GitHub 或本地目录选择 Package**，使用 `--harness-package`：

  ```bash
  magenta --harness-package 'github:owner/repository/PackageName@version:profile'
  magenta --harness-packages-root /trusted/package-root --harness-package PackageName
  ```

  下载内容会用 Release 中的 `.sha256` 文件校验，并记录每个版本首次校验通过的摘要，被悄悄替换的压缩包会被拒绝。也可以加上 `#sha256=<hex>` 自行固定摘要。
- **构建自己的 Package。** `magenta hcp check <package-root>` 校验本地 Package；`magenta --harness-list` 显示正在使用的组件和 Source。Package 可以向 `/` 菜单添加条目；菜单协议 v2 支持带类型的参数、条件、状态标记和能力开关。
- **用自己的实现替换内置工具。** `magenta hcp use` 可把开放的内置工具（`grep`、`read`、`ls`、`find`、`web_fetch`、`web_search`）背后的实现换成你自己的本地 Source，作用范围可以是你的用户、某个项目或单个会话。每次替换都需要你在终端中输入摘要确认；`magenta hcp log` 和 `magenta hcp rollback` 保留历史并可撤销更改。开启 `--harness-hcp-propose`（默认关闭）后，Agent 可以提议组件，但只有你能批准。
- **更轻量的扩展。** `magenta install <source>` 可添加扩展、技能、提示模板和主题；MCP 服务器在 `~/.magenta/agent/mcp-servers.json` 中配置。

### 文档

每个 Release 的资源包都附带完整的用户文档，安装脚本会把它放在可执行文件旁边：

| 系统 | 文档目录 |
|---|---|
| macOS / Linux | `~/.local/lib/magenta/docs/` |
| Windows | `%LOCALAPPDATA%\Magenta\docs\` |

从 `index.md` 和 `quickstart.md` 开始。上面提到的主题可参阅 `providers.md`（登录、API key、`/api`）、`usage.md`、`sessions.md`、`web.md`、`file-checkpoints.md`、`context-recall.md`、`context-sharing.md`、`compaction.md`、`harness-packages.md`、`packages.md`、`mcp.md`、`settings.md` 和 `troubleshooting.md`。文档目前为英文。

## 更新与卸载

```bash
magenta update self               # 更新到最新版本
magenta update --version 0.5.3    # 安装指定版本（更旧或更新均可）
magenta update --rollback         # 恢复到上一个安装
```

更新与安装使用相同的校验，并保留你的设置、凭据和会话。`magenta --update` 是 `magenta update self` 的旧别名。

**在 macOS / Linux 上卸载**，使用与安装相同的 bootstrap：

```bash
bootstrap="$(mktemp)"
curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/install.sh -o "$bootstrap"
bash "$bootstrap" --uninstall
rm -f "$bootstrap"
```

**在 Windows 上卸载：** 运行上面的安装命令，但把 `& $installer -Version $tag` 换成 `& $installer -Uninstall`。

卸载只删除已安装的版本及其 `PATH` 条目。`~/.magenta` 中的设置、凭据、会话和缓存会保留；不再需要时请自行删除该目录。如果安装时自定义了 `MAGENTA_INSTALL_DIR` / `MAGENTA_BIN_DIR`，卸载时请设置相同的值。

## 故障排查

| 现象 | 处理方法 |
|---|---|
| `magenta: command not found` | 把 `~/.local/bin` 加入 `PATH`（macOS / Linux），或在 Windows 安装脚本修改 `PATH` 后打开新终端。 |
| `Could not fetch latest release` | `api.github.com` 无法访问或触发了限流。下载镜像对此无效，请检查网络或代理。 |
| GitHub API 返回 HTTP 403 | 匿名访问每小时 60 次的额度已用完。等待重置，或把 `MAGENTA_GITHUB_TOKEN` 设为可读取公开仓库的 token。 |
| 下载很慢 | 设置 `MAGENTA_GITHUB_MIRROR`（见[中国大陆网络](#中国大陆网络)），然后重新运行安装脚本或 `magenta update self`。 |
| 校验失败 | 下载内容损坏或被篡改。重新运行安装脚本；它绝不会启用未通过校验的文件。 |
| 旧版本无法自更新 | 当前资源布局之前的旧版本无法安装新版本。请重新运行安装命令。 |
| 登录、模型或工具问题 | 运行 `magenta doctor` 查看只读的健康报告，运行 `magenta --validate-config` 检查凭据、模型和资源（不调用模型），用 `magenta --verbose` 查看启动详情。[文档目录](#文档)中的 `troubleshooting.md` 涵盖更多情况。 |

## 获取帮助

- **问题与疑问：** 在本仓库[提交 issue](https://github.com/Minions-Land/Magenta-CLI/issues)。请附上 `magenta --version` 的输出、操作系统和复现步骤。
- **版本历史：** [Releases](https://github.com/Minions-Land/Magenta-CLI/releases)。每个 Release 都列出变更，并在 `SOURCE_COMMIT` 中记录构建所用的源码提交。
- **安全问题：** 请不要在公开 issue 中贴出漏洞利用细节；先提交一个 issue 请求私下联系方式。

## 安全与校验

- Release 由发布工作流从带 tag 的源码提交构建，只有在核对完整的资产集合后才会发布到这里。
- `SHA256SUMS` 覆盖一个 Release 的所有内容；安装和更新会拒绝与它或 GitHub 报告的资产摘要不一致的文件。
- 新版本会先暂存并启动验证，然后才替换当前安装，因此更新失败时旧版本保持不变。

<a id="手动下载"></a>
<details>
<summary><strong>手动下载与校验</strong></summary>

选择一个确切的 tag，从同一个 tag 下载平台可执行文件、资源包和校验清单：

```bash
tag="<exact-release-tag>"
base="https://github.com/Minions-Land/Magenta-CLI/releases/download/$tag"
asset="magenta-linux-x64" # 或 magenta-macos-arm64、magenta-macos-x64、magenta-windows-x64.exe
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

这只校验文件，不会安装它们。使用镜像时，两个大文件可以通过镜像下载，但 `SHA256SUMS` 要直接从 GitHub 获取。
</details>

**旧版 v0.0.29：** 该版本早于按 Release 绑定的 Unix 安装脚本，上面的 bootstrap 会拒绝安装它。如确实需要，请按英文 README 中的 [Unix v0.0.29 manual transition](README.md#unix-v0-0-29-manual-transition) 操作。

## 仓库内容

| 路径 | 用途 |
|---|---|
| `install.sh` | 上面使用的 Unix bootstrap：解析最新 tag 并运行该 Release 中经过校验的安装脚本。 |
| `.github/` | 本仓库和已发布 Release 的检查。 |
| `docs/` | 项目网站（GitHub Pages），包括共享会话导出的查看器，以及 Magenta 标志文件。 |
| `docs/app/` | 浏览器版 Magenta：压缩后的网页应用包及其静态资源（`build-info.json` 记录源码提交与文件摘要；`LICENSES.txt` 列出打包的第三方包）。 |
| `docs/catalog/` | Magenta 用于更新模型信息的公开模型目录，由 Release 内置的模型数据生成（见 `docs/catalog/README.md`）。 |
| `LICENSE`、`THIRD-PARTY-NOTICES.md` | Magenta CLI 的 MIT 许可证与第三方声明。 |

本仓库不发布产品源代码。

## 许可与第三方声明

Magenta CLI 以 [MIT 许可证](LICENSE) 发布。它衍生自 Mario Zechner 及贡献者开发的 [Pi](https://github.com/earendil-works/pi) 编程 Agent，按 MIT 许可证使用；[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 收录了 Pi 的许可声明。Release 中打包的第三方软件，包括可执行文件内的 npm 包、内嵌的 ripgrep 可执行文件，以及 HTML 导出中嵌入的 [marked](https://github.com/markedjs/marked) 和 [highlight.js](https://github.com/highlightjs/highlight.js)，仍适用其各自的许可证。从下一个 Release 起，每个 Release 都在 `docs/THIRD-PARTY-NOTICES.md` 中附带完整声明，安装后位于 `magenta` 可执行文件旁的 `docs` 目录。

Magenta 名称和标志是本项目的品牌资产。
