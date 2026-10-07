# ali-kiro — Bundled Assets

This directory (`src/assets/`) holds the offline, machine-portable assets for the
**ali-kiro** cross-platform AI-tool installer. Everything below is copied verbatim
from the read-only backup located at `~/opencode-backup/`, minus secrets and build
artifacts (`node_modules`/`.git` were already stripped in the source).

Bundle metadata (versions, lock-file flags, MCP flags, bundle timestamp) is in
[`VERSIONS.json`](./VERSIONS.json).

---

## Plugins (`plugins/` — 5)

All five plugin directories are byte-for-byte copies of the source plugin repos
(`node_modules` and `.git` excluded). Each is registered in
[`config/opencode.json`](./config/opencode.json) via portable relative paths
(`./plugins/<dir>`), so the bundle works from any location, on any machine.

| Plugin (dir) | Version | Entry point | Lock files | Notes |
|---|---|---|---|---|
| `FlowDeck` | 0.7.0 | `dist/index.js` (package.json `main`) | `package-lock.json` | Structured planning/execution workflows; build via `bun run build` |
| `harness-memory` | 0.5.1 | `dist/v2-entry.js` | `package-lock.json` | Persistent memory/harness with built-in security scanning |
| `oh-my-opencode-slim` | 3.0.3 | `dist/server/index.js` | `bun.lock` + `package-lock.json` | Slimmed omo plugin suite (agents, skills, presets) |
| `opencode-dynamic-context-pruning` (dcp) | 3.2.0 | `dist/index.js` (also `server.js`) | `package-lock.json` | Dynamic context pruning; config referenced by `config/dcp.jsonc` |
| `opencode-snip` | git-main (no `version` field in package.json) | `.opencode/plugins/index.ts` (package.json `main`) | `package-lock.json` | Shell-command `snip` prefix to cut LLM token consumption |

All entry files were verified present at bundle time — no rebuilds were required.

---

## Skills (`skills/` — 38)

Flat directory layout (no subfolder grouping); directory names preserved exactly.
Every skill directory contains a `SKILL.md`.

Provenance:

- **19 from Anthropic** (`anthropic/skills`): `academy-guide`, `algorithmic-art`,
  `brand-guidelines`, `canvas-design`, `claude-api`, `discernment-nudge`,
  `doc-coauthoring`, `docx`, `frontend-design`, `internal-comms`, `mcp-builder`,
  `pdf`, `pptx`, `skill-creator`, `slack-gif-creator`, `theme-factory`,
  `web-artifacts-builder`, `webapp-testing`, `xlsx`
- **2 from kdcokenny/opencode-workspace**: `code-review`, `code-philosophy`
- **19 MiniMax suite** (`minimax-*`): `minimax-android-native-dev`,
  `minimax-buddy-sings`, `minimax-flutter-dev`, `minimax-frontend-dev`,
  `minimax-fullstack-dev`, `minimax-gif-sticker-maker`, `minimax-ios-application-dev`,
  `minimax-minimax-docx`, `minimax-minimax-multimodal-toolkit`,
  `minimax-minimax-music-gen`, `minimax-minimax-music-playlist`,
  `minimax-minimax-pdf`, `minimax-minimax-xlsx`, `minimax-pptx-generator`,
  `minimax-react-native-dev`, `minimax-shader-dev`, `minimax-vision-analysis`

All symlinks in the source were resolved to real file copies before bundling
(0 symlinks remain).

---

## MCP presets (`mcp/mcp-servers.json`)

10 server entries, with the `auto` flag and manual-action notes from the source file.

| Name | Type | auto | Notes |
|---|---|---|---|
| `context7` | remote | ✅ | https://mcp.context7.com/mcp |
| `gh_grep` | remote | ✅ | grep.app MCP |
| `grep_app` | remote | ❌ | **Suspect duplicate** of `gh_grep` (same URL) — verify manually before enabling |
| `websearch` | remote | ✅ | https://mcp.exa.ai/mcp; may need `EXA_API_KEY` env |
| `github` | remote | ❌ | Needs `Authorization: token <GITHUB_TOKEN>` header (was 401 missing Authorization) — add manually |
| `memory` | local | ✅ | `npx -y mcp-server-memory` |
| `sequentialThinking` | local | ✅ | `npx -y @modelcontextprotocol/server-sequential-thinking` |
| `playwright` | local | ✅ | `npx -y @playwright/mcp@latest` |
| `tokenOptimizer` | local | ❌ | **Needs manual fix** — `better-sqlite3` native addon missing in npx cache; clear `~/.npm/_npx/*` and reinstall; cache db at `~/.token-optimizer-cache/cache.db` |
| `magic` | local | ❌ | **Suspect** — npm package name (`magic-mcp`) is a guess; verify manually before enabling |

6 of 10 entries have `auto: true`.

---

## Config files (`config/` — 4)

| File | Purpose |
|---|---|
| `opencode.json` | Main OpenCode config — `$schema` + portable `./plugins/...` plugin array (5 entries) |
| `opencode.json.backup` | Backup config (single npm plugin entry, kept for history) |
| `cli.json` | OpenCode v2 CLI preferences (animation, session, tabs, attention, terminal, debug) |
| `dcp.jsonc` | Dynamic-context-pruning plugin schema reference |

`service.json` (which may contain machine-specific auth/service info) was
deliberately **excluded** from the backup and is not bundled.

---

## No Secrets Guarantee

The backup source deliberately excluded `service.json`. A value-aware secret scan
of this bundle (done at bundle time) found **no real credentials**: the only regex
hits for `password` / `api[_-]?key` / `token` / `secret` are legitimate source-code
references (e.g. harness-memory's built-in secret-scanner and its security tests
using **fake** tokens like `sk-abcdefghijklmnopqrstuvwxyz123456`), and
`opencode.json` plugin paths are portable `./plugins/...` relative paths with no
machine-specific absolute paths. **No API keys, passwords, private keys, or tokens
are present in this bundle.**

> Installer note: `github` MCP requires a user-supplied GitHub token at install
> time (via `--header 'Authorization=token ...'`); nothing was hardcoded.