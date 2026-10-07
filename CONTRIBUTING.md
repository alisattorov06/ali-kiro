# Contributing to ali-kiro

Thanks for helping make **ali-kiro** better! This project is MIT-licensed and
open to contributions of any size — bug reports, docs, tests, new tool
providers, or installer improvements.

## Development setup

Requirements:

- **Node.js ≥ 18** (Node 20/22 LTS recommended)
- **Bun ≥ 1.1** (only needed for the `bun build --compile` binary step)

```bash
git clone https://github.com/alisattorov06/ali-kiro
cd ali-kiro

# Install dependencies (ali-kiro itself is zero-dependency at runtime)
npm install

# Run the test suite (node --test test/)
npm test
```

## Running ali-kiro from source

```bash
node ali-kiro.mjs --help
node ali-kiro.mjs --dry-run --only opencode
```

## Building the binary

The compiled, dependency-free binary is produced with Bun:

```bash
bun build --compile ali-kiro.mjs --outfile ali-kiro
./ali-kiro --version
```

Cross-compile for other platforms with `--target`:

```bash
bun build --compile ali-kiro.mjs --target=bun-linux-arm64 --outfile ali-kiro-linux-arm64
```

## Code style

- **ESM only** — the entry point is `ali-kiro.mjs`; no CommonJS, no build step
  at runtime.
- **Zero runtime dependencies** — if a feature needs a third-party package,
  discuss it in the PR first.
- Keep files small and single-purpose (`src/core/*`, `src/cli/*`,
  `src/install/*`, `src/providers/*`, `src/assets/*` — see
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).
- No hardcoded secrets, tokens, or machine-specific paths.
- Tests live under `test/` and run with the built-in Node test runner.

## Pull request flow

1. Fork the repo and create a branch:
   `feature/your-change` or `fix/your-bug` (avoid `main`).
2. Make small, atomic commits with [Conventional Commits](https://www.conventionalcommits.org/)
   (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).
3. Run `npm test` and make sure the whole suite passes.
4. Open a PR with a clear title and description. Link any related issue.
5. At least one maintainer review is required before merge.

## Testing your installer changes

- `bash -n install.sh` — syntax-check the POSIX installer.
- `bash install.sh --dry-run` — safe preview (no network writes to your system).
- `install.ps1` is PowerShell — review it in the PowerShell ISE / VS Code
  extension before pushing; verify braces and `param()` placement.
- Remember: `npm test` (via CI) must stay green on Node 18, 20, and 22, on
  Linux, macOS, and Windows.