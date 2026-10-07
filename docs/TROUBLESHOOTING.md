# ali-kiro — Troubleshooting

Common issues when installing or running **ali-kiro**, with fixes. If your
problem isn't here, open an issue at
<https://github.com/alisattorov06/ali-kiro/issues>.

## "Binary download failed: the release may not be published yet"

The GitHub Releases assets (`ali-kiro-linux-x64`, `ali-kiro-macos-arm64`, …)
only exist once a release has been tagged **and** the release workflow has
finished. If you see this message:

- The installers **automatically fall back** to running
  `node ali-kiro.mjs` from source — you don't need to do anything.
- To force the source path explicitly:
  ```bash
  git clone https://github.com/alisattorov06/ali-kiro && cd ali-kiro
  node ali-kiro.mjs
  ```

## "node: command not found" (or "No Node.js found")

The installers auto-install Node.js LTS:

- **macOS**: `brew install node` (falls back to the official `.pkg` from
  https://nodejs.org/dist/).
- **Linux**: NodeSource setup script on apt-based systems (falls back to the
  official tarball in `/usr/local`, or `~/.ali-kiro/node` without sudo).
- **Windows**: `winget install OpenJS.NodeJS.LTS` (falls back to the official
  `.msi`).

If you prefer to manage Node yourself, install any Node ≥ 18 first
(https://nodejs.org) and re-run the installer.

## npm registry scopes (Google / OpenAI packages)

`@google/gemini-cli` and `@openai/codex` are **scoped** npm packages. If your
npm is pointed at a private or corporate registry that doesn't mirror the
public registry, those installs fail with 404/ENOTFOUND:

```bash
npm install -g @google/gemini-cli --registry=https://registry.npmjs.org
npm install -g @openai/codex       --registry=https://registry.npmjs.org
```

Or configure the scoped registry once in `~/.npmrc`:

```
@google:registry=https://registry.npmjs.org/
@openai:registry=https://registry.npmjs.org/
```

## MCP server: "connection closed" / "server exited unexpectedly"

Remote or local MCP servers usually fail for one of three reasons:

1. **Node.js too old** — several servers launch via `npx`; upgrade to Node 18+.
2. **Missing native addon (tokenOptimizer)** — `token-optimizer-mcp` needs
   `better-sqlite3`'s native binding. Fix by clearing the npx cache and
   rebuilding:
   ```bash
   cd ~/.npm/_npx/<dir>
   npm rebuild better-sqlite3
   ```
3. **Network / auth** — the `github` MCP preset requires an
   `Authorization: token <GITHUB_TOKEN>` header; `websearch` (Exa) may need an
   `EXA_API_KEY`. Check the server config and re-launch.

## OpenCode needs a restart after installing

Skills, plugins, and MCP server definitions are loaded when OpenCode starts.
After running ali-kiro, **restart OpenCode** (fully quit and relaunch) so the
new config, 38 skills, 5 plugins, and MCP servers are picked up. In some
versions `/plugins` or `/mcp` views show the refresh, but a restart is the
reliable path.

## sudo prompts during auto Node.js install (Linux)

The Linux tarball method prefers `/usr/local` and will use `sudo`. If you
don't want sudo prompts in a piped one-liner:

- Install Node.js yourself beforehand (https://nodejs.org), or
- let the installer fall back to a user-local install by ensuring your user
  can write to `/usr/local`, or pre-installing Node so the step is skipped.

The installers never prompt for secrets and never hardcode credentials.

## I want to preview what will happen

```bash
# Safe preview — prints the plan, changes nothing
ali-kiro --dry-run

# Preview a single tool
ali-kiro --dry-run --only opencode

# Test installs into an isolated directory
ali-kiro --target ~/ali-kiro-test --dry-run
```

`--dry-run` never mutates your system, config, or the state ledger.

## Windows: ExecutionPolicy blocks install.ps1

`irm https://raw.githubusercontent.com/alisattorov06/ali-kiro/main/install.ps1 | iex`
runs in the current scope and needs **no** policy change. If you saved the
file and your policy blocks it:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

## Building / compiling notes

- Binary: `bun build --compile ali-kiro.mjs --outfile ali-kiro`
- Cross-platform: add `--target=bun-linux-arm64` (or `bun-darwin-x64`,
  `bun-darwin-arm64`, `bun-windows-x64` — Windows builds get a `.exe` suffix
  automatically).
- Tests: `npm test` (runs `node --test test/`).