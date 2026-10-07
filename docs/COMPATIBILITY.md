# ali-kiro — Compatibility

This page documents the platforms, runtimes, and per-tool install methods that
**ali-kiro** supports, plus known gaps and workarounds.

## Platform matrix

| Platform | Arch | Prebuilt binary | From source | Notes |
|----------|------|-----------------|-------------|-------|
| Linux | x64 | ✅ `ali-kiro-linux-x64` | ✅ Node ≥ 18 | Glibc-based distros (Ubuntu, Debian, Fedora, Arch…) |
| Linux | arm64 | ✅ `ali-kiro-linux-arm64` | ✅ Node ≥ 18 | Raspberry Pi OS 64-bit, AWS Graviton, Apple-Silicon VMs |
| macOS | x64 | ✅ `ali-kiro-macos-x64` | ✅ Node ≥ 18 | Intel Macs |
| macOS | arm64 | ✅ `ali-kiro-macos-arm64` | ✅ Node ≥ 18 | Apple Silicon (M1/M2/M3/M4) |
| Windows | x64 | ✅ `ali-kiro-windows-x64.exe` | ✅ Node ≥ 18 | Windows 10/11; ARM64 runs x64 via emulation |

No 32-bit (i386/armv7) builds are published.

## Runtime requirements

| Runtime | Required | Notes |
|---------|----------|-------|
| Node.js | **≥ 18** | 20/22 LTS recommended. Only needed for the *from-source* method and for MCP servers that run `npx`. |
| Bun | ≥ 1.1 | Only needed when *building* the binary from source (`bun build --compile`). Not needed to run ali-kiro. |
| git / curl / wget | optional | The installers use these when available and fall back gracefully when they are not. |

The prebuilt binary is fully self-contained and needs **no** Node.js or Bun to
run.

## Installer behavior by platform

- **install.sh (macOS/Linux)**: downloads
  `ali-kiro-<os>-<arch>` from GitHub Releases into `~/.ali-kiro/bin/`, verifies
  it against `SHA-256SUMS` when the release publishes one, and executes it.
  Falls back to `node ali-kiro.mjs` (git clone, or tarball extraction) into
  `~/.ali-kiro/src/`, then to auto-installing Node.js LTS.
- **install.ps1 (Windows)**: same flow with `ali-kiro-windows-x64.exe` into
  `$HOME\.ali-kiro\bin\`; Node.js fallback via `winget install
  OpenJS.NodeJS.LTS`, then the official .msi installer.

## Per-tool install methods

| Tool | Primary install method | Verify with |
|------|------------------------|-------------|
| OpenCode | Official install script (macOS/Linux) / install.ps1 (Windows); also available from the Aider/OpenCode release channels | `opencode --version` |
| Claude Code | `npm install -g @anthropic-ai/claude-code` | `claude --version` |
| OpenAI Codex | `npm install -g @openai/codex` | `codex --version` |
| Cursor | GUI installer from cursor.com (`brew install --cask cursor` on macOS) | `cursor --version` |
| Aider | `python -m pip install aider-install && aider-install` | `aider --version` |
| Gemini CLI | `npm install -g @google/gemini-cli` | `gemini --version` |

## Bundled OpenCode stack compatibility

| Item | Compatibility |
|------|---------------|
| Plugins (5) | Compatible with OpenCode v2 plugin loading; installed via portable relative paths |
| Skills (38) | Skilled directories are flat, each with a `SKILL.md` — no special OpenCode version required |
| MCP servers (10 presets) | 6 auto-configured (context7, gh_grep, websearch, memory, sequentialThinking, playwright); 4 manual (grep_app, github, tokenOptimizer, magic) |

## Known gaps and workarounds

- **tokenOptimizer native binding** — `token-optimizer-mcp` depends on
  `better-sqlite3`, which needs a native rebuild on some systems. If the
  server fails to start, clear the npx cache and rebuild:
  `cd ~/.npm/_npx/<dir> && npm rebuild better-sqlite3`.
- **GitHub MCP auth** — the `github` MCP preset is *not* auto-enabled: it needs
  an `Authorization` header with a personal access token (e.g.
  `--header 'Authorization=token <GITHUB_TOKEN>'`). No token is ever hardcoded.
- **Cursor on Linux** — the Cursor AppImage does not register a `cursor` CLI
  on PATH by default; the verification step may therefore report Cursor as not
  verified even when the desktop app is installed.
- **macOS Gatekeeper** — the prebuilt binary is not notarized. First launch may
  require right-click → *Open*, or `xattr -dr com.apple.quarantine <binary>`.
- **Windows on ARM** — only x64 builds are published; ARM64 devices run them
  via Windows' built-in x64 emulation.
- **Node < 18** — the from-source method and several MCP servers require
  Node 18+. The installers auto-install a current Node LTS when Node is
  missing or too old.
- **No Docker image** — ali-kiro is intentionally distributed as a binary,
  an npm package, or from source; there is no container image.