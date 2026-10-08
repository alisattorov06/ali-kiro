# Security

**ali-kiro** is an installer/manager for AI coding assistants. It runs your
machine's official per-tool installers, writes configuration, and keeps a
local state ledger. This page describes the security model.

## No hardcoded secrets

- ali-kiro ships **zero credentials** — no API keys, tokens, passwords, or
  machine-specific secrets are bundled or generated.
- Secrets are read only from your environment and passed through to the tools
  that need them. Examples: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`,
  `GITHUB_TOKEN`, `EXA_API_KEY`.
- The bundled assets contain no `service.json`-style auth files; machine
  specific/auth files are deliberately excluded from the bundle and verified
  at bundle time.

## Log redaction

- Command labels and error output are redacted before printing: any argument
  that looks like a credential flag (`--key`, `--token`, `--secret`,
  `--password`, `--auth`, `--bearer`, …) has its value masked as
  `***REDACTED***` (see `REDACT_RE` in `src/core/executor.mjs`).
- Secrets never appear in logs, the final report, or the state ledger.

## Supply chain

- The one-liners (`install.sh` / `install.ps1`) download the architecture
  matched release binary and verify it against the published `SHA-256SUMS`
  file when available.
- Per-tool installs use each assistant's **official** installer (install
  scripts, npm packages, brew casks, winget, pipx) — never third-party
  mirrors.
- If no signed/verified binary is available yet, the installer falls back to
  running `node ali-kiro.mjs` from a source checkout instead of failing.

## State ledger

- `~/.ali-kiro/state.json` (or the `--target` override) records only tool
  ids, versions, actions, plugin smoke results, MCP server names, and
  error/warning messages.
- It stores **no credentials, tokens, or API keys**.

## Per-tool auth

- Each assistant handles its own first-run authentication — ali-kiro does not
  capture or store those tokens.
- Examples: `agy` (Antigravity CLI) opens a Google sign-in browser flow on
  first run; Gemini CLI can use `GEMINI_API_KEY`; OpenCode, Claude Code, and
  Codex each provide their own login flows.

## Reporting

- Found a vulnerability or a place where a secret could leak? Open an issue at
  <https://github.com/alisattorov06/ali-kiro/issues> — include the affected
  version and as much detail as possible without including the secret itself.
- For sensitive disclosures, mention `security` in the issue title; the
  maintainers will follow up privately if needed.