# ali-kiro — Architecture

This document describes the high-level architecture of **ali-kiro**: a
one-command, cross-platform installer and manager for AI coding assistants
(OpenCode, Claude Code, OpenAI Codex, Cursor, Aider, Gemini CLI), with a full
OpenCode stack (configuration, plugins, skills, and MCP server presets) bundled.

Everything below describes the design as implemented. If small details drift
from what you see in the code, treat the code as the source of truth.

## Module map

```
src/
  core/       Engine: state ledger, idempotency, dry-run gating, verification,
              logging, and the plan/diff machinery.
  cli/        Argument parsing, the interactive tool selector, and report
              rendering (terminal menu + final summary).
  install/    Per-tool installers (OpenCode, Claude Code, Codex, Cursor,
              Aider, Gemini CLI), the Node.js bootstrap helper, and
              platform helpers (POSIX + Windows).
  providers/  Knowledge about each AI tool: how to detect an existing
              installation, the install command for each OS, and the
              verification command.
  assets/     Offline, machine-portable bundle: plugins/, skills/, mcp/,
              config/ (see "Asset layout").
```

The binaries (`ali-kiro.mjs` → `ali-kiro` via `bun build --compile`) are just
the CLI entry point over the same modules — there is no separate binary logic
to maintain.

## The 7-step pipeline

Every invocation of `ali-kiro` runs the same pipeline:

1. **Parse arguments** — `--list`, `--yes`, `--dry-run`, `--only <tool>`,
   `--target <dir>`, plus flags passed through to the underlying tools.
2. **Load the state ledger** — reads `~/.ali-kiro/state.json` (or the
   `--target` override) so the run starts from what is actually installed.
3. **Detect the environment** — OS + architecture, Node.js version, which of
   the 6 AI tools are already present, and their versions.
4. **Compute the plan** — build the desired-state manifest (tools + OpenCode
   stack) and diff it against the ledger and the live environment.
5. **Gate on dry-run** — with `--dry-run`, render the plan and exit
   (exit code 0) without mutating anything.
6. **Execute** — install each missing/outdated piece. Every step is idempotent:
   already-satisfied steps are skipped, failed steps are retried (see
   "Error and retry policy") and the run continues with the next tool.
7. **Verify and persist** — re-check each tool's verification command, write
   the updated state ledger, print the final report, and exit with an
   appropriate code.

## State ledger

```
~/.ali-kiro/state.json
```

- One JSON record per managed item (tool, plugin, skill set, MCP server), with
  `status`, `version`, `installMethod`, `installedAt`, and `verified`.
- `--target <dir>` redirects the ledger (and all writes) to a test directory,
  which is how dry runs and smoke tests are validated without touching the
  user's real configuration.
- The ledger is what makes ali-kiro **idempotent**: re-running converges to
  the same state instead of duplicating installs.

## Asset layout (`src/assets/`)

```
src/assets/
  plugins/    FlowDeck, harness-memory, oh-my-opencode-slim,
              opencode-dynamic-context-pruning, opencode-snip (5 plugins)
  skills/     38 skills (19 from anthropics/skills, 2 from
              kdcokenny/opencode-workspace, 17 MiniMax suite)
  mcp/        mcp-servers.json — 10 MCP server presets (6 auto, 4 manual)
  config/     opencode.json, opencode.json.backup, cli.json, dcp.jsonc
```

- All plugin paths in the config are portable relative paths (`./plugins/...`),
  so the bundle works from any checkout location.
- `service.json`-style machine-specific/auth files are deliberately **not**
  bundled — the bundle contains no secrets (verified at bundle time).

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Everything installed/verified successfully (or a successful dry run) |
| `1` | Generic error (network failure, Node.js bootstrap failed, unexpected exit) |
| `2` | CLI usage error (unknown flag, invalid `--only` value, bad `--target`) |
| `3` | Partial success — some tools installed, others failed |
| `4` | Verification failed — installs completed but post-install checks did not pass |

## Error and retry policy

- Each install step may retry transient failures (network timeouts, download
  interruptions) with a short backoff — bounded retries, then the step is
  marked `failed` with its reason in the ledger.
- One tool failing does **not** abort the rest of the run; the final report
  lists every failure so the user can fix and re-run (the run is idempotent,
  so re-running only touches the failed pieces).
- `--dry-run` never mutates anything — it only computes and prints the plan.
- Installer scripts (`install.sh` / `install.ps1`) prefer the prebuilt binary
  and fall back to running `node ali-kiro.mjs` from source when the binary is
  unavailable, falling back once more to bootstrapping Node.js LTS if needed.
- Failures, retries, and skipped steps are all recorded in the state ledger
  for auditability.