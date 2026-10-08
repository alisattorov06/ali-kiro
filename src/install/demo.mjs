// ali-kiro — `--demo`: a scripted fake session for terminal recording.
// Deterministic output, ~120ms per step, no real installs. Exit 0.
import { logger, setLoggerOptions, clearCounters } from '../core/logger.mjs';

export async function runDemo({ sleepMs = 120 } = {}) {
  // Deterministic output regardless of the terminal: force colors off.
  setLoggerOptions({ tty: false, quiet: false });
  clearCounters();
  const wait = () => new Promise((r) => setTimeout(r, sleepMs));

  logger.info('ali-kiro demo — scripted session (no real installs)');
  logger.info('');

  logger.step(1, 'Environment check: OS/arch, package managers, assets integrity');
  await wait();
  logger.info('Platform: linux/x64 · node v24.0.0 · package managers: npm, bun, curl, wget');
  logger.info('Assets: config 3/3 · plugins 5 · skills 38 · mcp present');
  logger.ok('Environment OK.');

  logger.step(2, 'AI selection: menu (TTY) or --only/--skip filters (default: all 7)');
  await wait();
  logger.info('Selected 7 tools: opencode, claude-code, codex, cursor, aider, gemini, antigravity');
  logger.ok('claude-code already installed (v2.1.2) — will not reinstall.');

  logger.step(3, 'OpenCode full stack: config, plugins+deps+smoke, skills, MCP, service');
  await wait();
  logger.ok('config rendered (opencode.json, cli.json, dcp.jsonc) — backups: opencode.json.bak-2026-10-07T120000Z');
  logger.ok('plugin "FlowDeck" deps installed (npm)');
  logger.ok('plugin smoke OK: FlowDeck (id=flowdeck)');
  logger.ok('plugin smoke OK: oh-my-opencode-slim (id=oh-my-opencode-slim)');
  logger.info('skill "claude-api" skipped — already present (user skills preserved)');
  logger.ok('MCP "context7" added (--url https://mcp.context7.com/mcp --global)');
  logger.warn('opencode service restart did not succeed (service may not be running yet) — continuing.');
  logger.ok('OpenCode service responds (api /api/info OK).');

  logger.step(4, 'Other AI assistants: install + verify each selected tool');
  await wait();
  logger.info('codex install started (npm install -g @openai/codex)');
  logger.ok('codex installed (v0.42.0)');
  logger.info('cursor install started (brew install --cask cursor)');
  logger.warn('cursor: command failed (curl) — trying fallback.');
  logger.ok('cursor installed (v3.23.23)');
  logger.ok('aider installed (v0.78.0)');
  logger.ok('gemini installed (v0.10.0)');
  logger.info('antigravity install started (curl -fsSL https://antigravity.google/cli/install.sh | bash)');
  logger.ok('antigravity installed (agy v1.3.1) — first run signs in via browser');

  logger.step(5, 'Verification sweep: re-check every binary version, plugins, MCP list');
  await wait();
  logger.info('sweep: opencode → v2.0.24');
  logger.info('sweep: claude-code → v2.1.2');
  logger.info('sweep: codex → v0.42.0');
  logger.info('sweep: cursor → v3.23.23');
  logger.info('sweep: aider → v0.78.0');
  logger.info('sweep: gemini → v0.10.0');
  logger.info('sweep: antigravity → v1.3.1');
  logger.info('MCP servers currently configured: context7, gh_grep, websearch');

  logger.step(6, 'Report + state write (~/.ali-kiro/state.json, atomic)');
  await wait();
  logger.info('State written to ~/.ali-kiro/state.json');

  logger.step(7, 'Final report + dry-run summary + exit code');
  await wait();
  logger.info('Done. Restart OpenCode (or run `opencode service restart`) to pick up changes.');

  logger.finalReport({
    tools: {
      opencode: { installed: true, version: '2.0.24', action: 'install' },
      'claude-code': { installed: true, version: '2.1.2', action: 'already-installed' },
      codex: { installed: true, version: '0.42.0', action: 'install' },
      cursor: { installed: true, version: '3.23.23', action: 'install' },
      aider: { installed: true, version: '0.78.0', action: 'install' },
      gemini: { installed: true, version: '0.10.0', action: 'install' },
      antigravity: { installed: true, version: '1.3.1', action: 'install' },
    },
    plugins: [
      { name: 'FlowDeck', ok: true },
      { name: 'harness-memory', ok: true },
      { name: 'oh-my-opencode-slim', ok: true },
      { name: 'opencode-dynamic-context-pruning', ok: true },
      { name: 'opencode-snip', ok: true },
    ],
    skillsCount: 38,
    mcps: [
      { name: 'context7', action: 'added' },
      { name: 'gh_grep', action: 'added' },
      { name: 'websearch', action: 'added' },
      { name: 'github', action: 'manual-skip' },
    ],
  });

  return { exitCode: 0, steps: 7 };
}