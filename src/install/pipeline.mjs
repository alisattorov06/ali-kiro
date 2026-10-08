// ali-kiro — the 7-step pipeline.
// 1 env/assets  2 AI selection  3 OpenCode full stack  4 other AIs
// 5 verification sweep  6 report + state  7 final/dry-run summary.
// Step 1 is fail-fast (exit 1). Steps 2-5 continue + report unless --strict.
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../core/logger.mjs';
import { detectOS, detectArch, pm, isTTY, stateDir, configDir } from '../core/platform.mjs';
import { catalog, entryById } from '../core/ai-registry.mjs';
import { binVersion, mcpList } from '../core/check.mjs';
import { selectFromCatalog } from '../cli/menu.mjs';
import { installAndVerify } from './installer.mjs';
import { installFullStack } from '../providers/opencode.mjs';
import { writeState } from '../core/state.mjs';
import { resolveAssetsRoot } from '../core/assets.mjs';

export const TOTAL_STEPS = 7;
export const EXIT = { OK: 0, ENV: 1, INSTALL: 2, VERIFY: 3, USAGE: 4 };

export const STEP_DESCRIPTIONS = [
  'Environment check: OS/arch, package managers, assets integrity',
  'AI selection: menu (TTY) or --only/--skip filters (default: all 7)',
  'OpenCode full stack: config, plugins+deps+smoke, skills, MCP, service',
  'Other AI assistants: install + verify each selected tool',
  'Verification sweep: re-check every binary version, plugins, MCP list',
  'Report + state write (~/.ali-kiro/state.json, atomic)',
  'Final report + dry-run summary + exit code',
];

function dirNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

export async function runPipeline(opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const strict = Boolean(opts.strict);
  const os = detectOS();
  const arch = detectArch();
  const pms = pm();

  logger.info(`ali-kiro installer — ${os}/${arch} · node ${process.version}${dryRun ? ' · DRY RUN (nothing will be changed)' : ''}`);

  const ctx = {
    opts, os, arch, pms, dryRun, strict,
    assetsRoot: resolveAssetsRoot(opts || {}),
    selected: [],
    tools: {},          // id -> {name, installed, version, action}
    plugins: [],        // [{name, id, ok, tsEntry}]
    skillsCount: 0,     // actual skill dirs present under the target's skills dir
    mcps: [],           // [{name, action}]
    errors: [],         // error strings
    verifyErrors: [],   // tools installed at install-time but missing at sweep
    envFailed: false,
  };

  // ── Step 1: environment / assets integrity ──────────────────────────────
  logger.step(1, STEP_DESCRIPTIONS[0]);
  const env = await stepEnvironment(ctx);
  ctx.envFailed = !env.ok;
  if (ctx.envFailed && !dryRun) {
    logger.err('Aborting — environment check failed (exit 1).');
    logger.finalReport(summaryFor(ctx));
    return EXIT.ENV;
  }
  if (env.ok) logger.ok('Environment OK.');

  // ── Step 2: selection ───────────────────────────────────────────────────
  logger.step(2, STEP_DESCRIPTIONS[1]);
  ctx.selected = await stepSelection(ctx);

  // ── Step 3: OpenCode full stack ─────────────────────────────────────────
  if (ctx.selected.includes('opencode')) {
    logger.step(3, STEP_DESCRIPTIONS[2]);
    const abort = await stepOpenCode(ctx);
    if (abort) {
      logger.finalReport(summaryFor(ctx));
      return EXIT.INSTALL;
    }
  } else {
    logger.info('OpenCode not selected — skipping the full stack.');
  }

  // ── Step 4: other AIs ───────────────────────────────────────────────────
  const others = ctx.selected.filter((id) => id !== 'opencode');
  if (others.length) {
    logger.step(4, STEP_DESCRIPTIONS[3]);
    for (const id of others) {
      const r = await installOne(ctx, id);
      if (r === 'abort') {
        logger.finalReport(summaryFor(ctx));
        return EXIT.INSTALL;
      }
    }
  } else {
    logger.info('No additional AI assistants selected — skipping.');
  }

  // ── Step 5: verification sweep ──────────────────────────────────────────
  logger.step(5, STEP_DESCRIPTIONS[4]);
  await stepSweep(ctx);

  // ── Step 6: report + state ──────────────────────────────────────────────
  logger.step(6, STEP_DESCRIPTIONS[5]);
  await stepReport(ctx);

  // ── Step 7: final / dry-run summary ─────────────────────────────────────
  logger.step(7, STEP_DESCRIPTIONS[6]);
  const code = dryRun ? EXIT.OK : finalCode(ctx);
  if (dryRun) {
    logger.info('DRY-RUN COMPLETE — no changes were made. Re-run without --dry-run to apply.');
  } else if (ctx.selected.includes('opencode')) {
    logger.info('Done. Restart OpenCode (or run `opencode service restart`) to pick up changes.');
  } else {
    logger.info('Done. Restart the installed tools to pick up changes.');
  }
  logger.finalReport(summaryFor(ctx));
  return code;
}

// ---- steps ---------------------------------------------------------------

async function stepEnvironment(ctx) {
  const assets = ctx.assetsRoot;
  const cfgDir = path.join(assets, 'config');
  const plDir = path.join(assets, 'plugins');
  const skDir = path.join(assets, 'skills');
  const mcpFile = path.join(assets, 'mcp', 'mcp-servers.json');

  const required = ['opencode.json', 'cli.json', 'dcp.jsonc'];
  const missingCfg = required.filter((f) => !fs.existsSync(path.join(cfgDir, f)));
  const hasService = fs.existsSync(path.join(cfgDir, 'service.json'));
  const pluginCount = dirNames(plDir).length;
  const skillCount = dirNames(skDir).length;
  const mcpOk = fs.existsSync(mcpFile);

  const problems = [];
  if (missingCfg.length) problems.push(`assets/config missing files: ${missingCfg.join(', ')} (expected in assets/config/)`);
  if (hasService) problems.push('service.json must NOT ship in assets/config (secret file)');
  if (pluginCount < 5) problems.push(`assets/plugins: expected >=5 plugins, found ${pluginCount}`);
  if (skillCount < 38) problems.push(`assets/skills: expected >=38 skills, found ${skillCount}`);
  if (!mcpOk) problems.push('assets/mcp/mcp-servers.json missing');

  logger.info(`Platform: ${ctx.os}/${ctx.arch} · package managers: ${ctx.pms.length ? ctx.pms.join(', ') : 'none found'}`);
  logger.info(`Assets: config ${required.length - missingCfg.length}/${required.length} · plugins ${pluginCount} · skills ${skillCount} · mcp ${mcpOk ? 'present' : 'MISSING'}`);

  ctx.pluginSourceCount = pluginCount;
  ctx.skillSourceCount = skillCount;

  if (problems.length) {
    if (ctx.dryRun) {
      for (const p of problems) logger.warn(`assets incomplete: ${p} (dry-run continues)`);
      logger.info('Assets may still be landing from the assets lane — dry-run continues with the plan.');
    } else {
      for (const p of problems) logger.err(`ASSETS/ENV INCOMPLETE: ${p}`);
      ctx.errors.push(...problems);
    }
  }
  if (!ctx.pms.includes('npm') && !ctx.pms.includes('curl') && !ctx.pms.includes('pwsh') && !ctx.pms.includes('winget')) {
    const msg = 'no package manager found (npm, curl, winget, pwsh) — most installs will fail';
    if (ctx.dryRun) logger.warn(`env: ${msg} (dry-run continues)`);
    else { logger.err(msg); problems.push(msg); ctx.errors.push(msg); }
  }
  return { ok: problems.length === 0 };
}

async function stepSelection(ctx) {
  const onlySet = new Set(ctx.opts.only || []);
  const skipSet = new Set(ctx.opts.skip || []);
  const items = catalog.filter((e) => (!onlySet.size || onlySet.has(e.id)) && !skipSet.has(e.id));
  if (!items.length) {
    logger.warn('No tools left after --only/--skip filters.');
    return [];
  }
  let selected;
  if (ctx.dryRun) {
    for (const e of items) logger.info(`DRY: would select ${e.name} (verify: ${e.verifyCmd} ${e.verifyArg.join(' ')})`);
    selected = items.map((e) => e.id);
  } else {
    selected = ctx.opts.yes || ctx.opts.quiet || !isTTY()
      ? items.map((e) => e.id)
      : await selectFromCatalog(items, ctx.opts);
  }
  for (const e of items) {
    if (!ctx.dryRun) {
      const v = await binVersion(e.verifyCmd, e.verifyArg);
      ctx.tools[e.id] = { name: e.name, installed: Boolean(v), version: v || null, action: v ? 'already-installed' : 'pending' };
      if (v) logger.info(`${e.name} already installed (v${v}) — will not reinstall.`);
    } else {
      ctx.tools[e.id] = { name: e.name, installed: false, version: null, action: 'planned' };
    }
  }
  logger.info(`Selected ${selected.length} tool(s): ${selected.length ? selected.join(', ') : '(none)'}`);
  return selected;
}

async function stepOpenCode(ctx) {
  if (ctx.dryRun) {
    logger.info('DRY: would install the opencode binary if missing, then apply the full stack:');
    logger.info('DRY:   config  — copy opencode.json, cli.json, dcp.jsonc with .bak-<ts> backups');
    logger.info(`DRY:   plugins — copy ${ctx.pluginSourceCount} plugins, install deps per lockfile, import-smoke each`);
    logger.info(`DRY:   skills  — copy ${ctx.skillSourceCount} skills (existing user skills preserved)`);
    logger.info('DRY:   mcp     — sync auto MCP servers via `opencode mcp add --global`');
    logger.info('DRY:   service — restart opencode service + verify api /api/info');
    return false;
  }

  const existing = await binVersion('opencode', ['--version']);
  if (existing) {
    logger.info(`OpenCode binary present (v${existing}).`);
    ctx.tools.opencode = { name: 'OpenCode', installed: true, version: existing, action: 'already-installed' };
  } else {
    logger.info('OpenCode binary not found — installing it first.');
    const r = await installAndVerify(entryById('opencode'), { logger, ...ctx.opts });
    if (r.status === 'failed') {
      ctx.errors.push(`${r.name} binary install failed: ${r.error || 'unknown'}`);
      logger.err('OpenCode binary install failed — skipping the full stack (re-run with --only opencode or fix manually).');
      return true;
    }
    if (r.status === 'skipped' && r.reason === 'no-npm') {
      ctx.tools.opencode = { name: 'OpenCode', installed: false, version: null, action: 'skipped-no-npm' };
      logger.warn('OpenCode binary skipped (--no-npm) — full stack needs the binary; skipping.');
      return false;
    }
    ctx.tools.opencode = { name: 'OpenCode', installed: true, version: r.version, action: 'install' };
  }

  const result = await installFullStack({
    target: ctx.opts.target,
    flags: ctx.opts,
    assetsRoot: ctx.assetsRoot,
    logger,
  });
  if (result.skills && result.skills.copied) {
    ctx.skillsCount = dirNames(path.join(configDir({ target: ctx.opts.target }), 'skills')).length;
  }
  ctx.mcps.push(...(result.mcps || []));
  const smokes = (result.plugins && result.plugins.smokes) || [];
  ctx.plugins.push(...smokes.map((s) => ({ name: s.name, id: s.id, ok: s.ok, tsEntry: Boolean(s.tsEntry) })));
  if (result.service && !result.service.apiOk) {
    ctx.errors.push('OpenCode service not responding after install');
  }
  return false;
}

// Static import registry so `bun build --compile` can bundle every provider
// module into the standalone binary (template-literal dynamic imports cannot
// be resolved from bun's virtual filesystem at runtime).
const PROVIDER_LOADERS = {
  opencode: () => import('../providers/opencode.mjs'),
  'claude-code': () => import('../providers/claude-code.mjs'),
  codex: () => import('../providers/codex.mjs'),
  cursor: () => import('../providers/cursor.mjs'),
  aider: () => import('../providers/aider.mjs'),
  gemini: () => import('../providers/gemini.mjs'),
  antigravity: () => import('../providers/antigravity.mjs'),
};

async function installOne(ctx, id) {
  const load = PROVIDER_LOADERS[id] || (() => import(`../providers/${id}.mjs`));
  const mod = await load();
  const r = await mod.install({ logger, os: ctx.os, arch: ctx.arch, ...ctx.opts });
  ctx.tools[r.id] = {
    name: r.name || id,
    installed: Boolean(r.installed),
    version: r.version || null,
    action: r.action || r.status,
  };
  if (r.status === 'failed') {
    ctx.errors.push(`${r.name} install failed: ${r.error || 'unknown'}`);
    if (ctx.strict) {
      logger.err(`--strict: aborting after install failure (exit ${EXIT.INSTALL}).`);
      return 'abort';
    }
  } else if (r.status === 'skipped' && r.reason === 'no-npm') {
    ctx.errors.push(`${r.name} skipped because --no-npm`);
  }
  return 'ok';
}

async function stepSweep(ctx) {
  if (ctx.dryRun) {
    logger.info('DRY: would re-verify each selected binary version, plugin smokes, and the MCP list');
    return;
  }
  for (const id of ctx.selected) {
    const t = ctx.tools[id];
    if (!t) continue;
    const v = await binVersion((entryById(id) || {}).verifyCmd || id, (entryById(id) || {}).verifyArg || ['--version']);
    t.version = v || t.version;
    t.installed = Boolean(v);
    if (!v && t.action !== 'pending' && t.action !== 'planned') {
      ctx.verifyErrors.push(id);
      logger.err(`verification failed: ${id} was expected but is not on PATH`);
    }
    logger.info(`sweep: ${id} → ${v ? `v${v}` : 'not found'}`);
  }
  if (ctx.selected.includes('opencode')) {
    const existingMcp = await mcpList(ctx.opts.opencodeBin || 'opencode');
    logger.info(`MCP servers currently configured: ${existingMcp.length ? existingMcp.join(', ') : 'none or opencode not available'}`);
  } else {
    logger.info('Skipped OpenCode MCP sweep (opencode not selected)');
  }
  for (const p of ctx.plugins) {
    if (p.ok) logger.ok(`plugin smoke OK: ${p.name}${p.id ? ` (id=${p.id})` : ''}`);
    else logger.warn(`plugin smoke failed: ${p.name}${p.tsEntry ? ' (TS entry — imported natively by opencode)' : ''}`);
  }
}

async function stepReport(ctx) {
  const statePath = ctx.opts.statePath || path.join(stateDir(), 'state.json');
  const state = {
    ranAt: new Date().toISOString(),
    os: ctx.os,
    arch: ctx.arch,
    tools: Object.fromEntries(Object.entries(ctx.tools).map(([id, t]) => [id, { installed: Boolean(t.installed), version: t.version || null, action: t.action || '' }])),
    plugins: ctx.plugins.map((p) => (p.tsEntry ? { id: p.id || p.name, ok: 'skip', warn: true } : { id: p.id, ok: p.ok })),
    skillsCount: ctx.skillsCount,
    mcps: ctx.mcps,
    errors: ctx.errors,
    warnings: [], // runtime warnings are surfaced via the logger counters / report
  };
  if (ctx.dryRun) {
    logger.info(`DRY: would write state to ${statePath}`);
    return;
  }
  try {
    await writeState(statePath, state);
    logger.info(`State written to ${statePath}`);
  } catch (e) {
    logger.err(`failed to write state: ${(e && e.message) || e}`);
    ctx.errors.push('state write failed');
  }
}

function finalCode(ctx) {
  if (ctx.verifyErrors.length) return EXIT.VERIFY;
  if (ctx.errors.length) return EXIT.INSTALL;
  return EXIT.OK;
}

function summaryFor(ctx) {
  return { tools: ctx.tools, plugins: ctx.plugins, skillsCount: ctx.skillsCount, mcps: ctx.mcps };
}