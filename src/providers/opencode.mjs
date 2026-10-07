// ali-kiro — OpenCode full-stack installer (the flagship lane).
// Renders config, installs/copies plugins + deps + smoke tests, copies skills,
// registers MCP servers and (re)starts/verifies the opencode service.
// All operations target the opencode config dir; `--target` redirects (testing).
// Assets are read from ../assets (relative to src); missing assets raise clear errors.
import fs from 'node:fs';
import path from 'node:path';
import { configDir, has } from '../core/platform.mjs';
import { run } from '../core/executor.mjs';
import { mcpList, pluginImportSmoke } from '../core/check.mjs';
import { logger } from '../core/logger.mjs';
import { resolveAssetsRoot } from '../core/assets.mjs';

const CONFIG_FILES = ['opencode.json', 'cli.json', 'dcp.jsonc'];

export function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function copyDir(src, dest) {
  await fs.promises.mkdir(dest, { recursive: true });
  await fs.promises.cp(src, dest, { recursive: true, force: true });
}

function listDirNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

// ---- 1. config ------------------------------------------------------------
export async function copyConfig(opts = {}) {
  const srcDir = path.join(resolveAssetsRoot(opts), 'config');
  const destDir = configDir({ target: opts.target });
  await fs.promises.mkdir(destDir, { recursive: true });

  const result = { dest: destDir, copied: [], backups: [] };
  for (const f of CONFIG_FILES) {
    const s = path.join(srcDir, f);
    if (!fs.existsSync(s)) {
      throw new Error(`Asset missing: ${f} (expected at ${s}). The assets lane may not have finished.`);
    }
    const d = path.join(destDir, f);
    if (fs.existsSync(d)) {
      const bak = `${d}.bak-${ts()}`;
      await fs.promises.copyFile(d, bak);
      result.backups.push(path.basename(bak));
    }
    await fs.promises.copyFile(s, d);
    result.copied.push(f);
  }
  // Guard: service.json (secrets) must NEVER be copied, even if present.
  if (fs.existsSync(path.join(srcDir, 'service.json'))) {
    logger.warn('service.json was found in assets/config but is NEVER copied (it may hold secrets).');
    result.serviceJsonFound = true;
  }
  logger.ok(`config rendered into ${destDir}${result.backups.length ? ` — backups: ${result.backups.join(', ')}` : ''}`);
  return result;
}

// ---- 2. plugins -----------------------------------------------------------
export async function installPlugins(opts = {}) {
  const srcDir = path.join(resolveAssetsRoot(opts), 'plugins');
  const destBase = path.join(configDir({ target: opts.target }), 'plugins');
  const names = listDirNames(srcDir);
  const result = { copied: [], alreadyPresent: [], deps: [], smokes: [] };

  const destDirs = [];
  for (const name of names) {
    const dest = path.join(destBase, name);
    if (fs.existsSync(dest)) {
      logger.info(`plugin "${name}" already present — skipping copy (existing install kept).`);
      result.alreadyPresent.push(name);
    } else {
      await copyDir(path.join(srcDir, name), dest);
      result.copied.push(name);
    }
    destDirs.push({ name, dir: dest });
  }

  for (const { name, dir } of destDirs) {
    const hasBunLock = ['bun.lock', 'bun.lockb'].some((f) => fs.existsSync(path.join(dir, f)));
    const hasPkgLock = fs.existsSync(path.join(dir, 'package-lock.json'));
    let record = { name, tool: 'none', ok: true, code: 0 };
    if (hasBunLock && has('bun')) {
      const r = await run('bun', ['install', '--no-save'], { cwd: dir, retries: 3, timeoutMs: 300000 });
      record = { name, tool: 'bun', code: r.code, ok: r.code === 0 };
      if (r.code !== 0) logger.warn(`plugin "${name}": bun install failed (code ${r.code}).`);
    } else if ((hasPkgLock || hasBunLock) && has('npm')) {
      // bun.lock-without-bun falls back to npm; package-lock.json uses npm.
      // --legacy-peer-deps: bundled 3rd-party plugin source; peer resolution is
      // the publisher's concern, and opencode's own plugin loader installs leniently too.
      const r = await run('npm', ['install', '--no-audit', '--no-fund', '--legacy-peer-deps'], { cwd: dir, retries: 3, timeoutMs: 300000 });
      record = { name, tool: hasBunLock ? 'npm (bun.lock fallback)' : 'npm', code: r.code, ok: r.code === 0 };
      if (r.code !== 0) logger.warn(`plugin "${name}": npm install failed (code ${r.code}).`);
    } else if (hasBunLock || hasPkgLock) {
      logger.warn(`plugin "${name}": lockfile present but no bun/npm found — deps not installed.`);
      record = { name, tool: 'missing-runner', ok: false, code: -1 };
    }
    result.deps.push(record);
  }

  for (const { name, dir } of destDirs) {
    const smoke = await pluginImportSmoke(dir);
    result.smokes.push({ name, id: smoke.id, ok: smoke.ok, tsEntry: Boolean(smoke.tsEntry), error: smoke.error || '' });
    if (smoke.ok) logger.ok(`plugin "${name}" smoke OK (id=${smoke.id})`);
    else if (smoke.tsEntry) logger.warn(`plugin "${name}": ${smoke.error}`);
    else logger.warn(`plugin "${name}": smoke failed — ${smoke.error || 'unknown'}`);
  }
  return result;
}

// ---- 3. skills ------------------------------------------------------------
export async function installSkills(opts = {}) {
  const srcDir = path.join(resolveAssetsRoot(opts), 'skills');
  const destBase = path.join(configDir({ target: opts.target }), 'skills');
  const names = listDirNames(srcDir);
  const result = { copied: [], skipped: [] };
  for (const name of names) {
    const dest = path.join(destBase, name);
    if (fs.existsSync(dest)) {
      logger.warn(`skill "${name}" already exists — skipping (user skills are never overwritten).`);
      result.skipped.push(name);
    } else {
      await copyDir(path.join(srcDir, name), dest);
      result.copied.push(name);
    }
  }
  logger.ok(`skills: copied ${result.copied.length}, skipped ${result.skipped.length} (existing user skills preserved)`);
  return result;
}

// ---- 4. MCP ---------------------------------------------------------------
function normalizeServers(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.servers)) return parsed.servers;
  if (parsed && typeof parsed === 'object') {
    return Object.entries(parsed)
      .filter(([, v]) => v && typeof v === 'object')
      .map(([name, v]) => ({ name, ...v }));
  }
  return [];
}

export async function installMcp(opts = {}) {
  const mcpFile = path.join(resolveAssetsRoot(opts), 'mcp', 'mcp-servers.json');
  const opencodeBin = opts.opencodeBin || 'opencode';
  const runOpts = opts.runOpts || {}; // injectable for tests
  const result = [];

  if (!fs.existsSync(mcpFile)) {
    throw new Error(`Asset missing: mcp-servers.json (expected at ${mcpFile}).`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
  } catch (e) {
    throw new Error(`mcp-servers.json is not valid JSON: ${(e && e.message) || e}`);
  }
  const servers = normalizeServers(parsed);
  const existing = await mcpList(opencodeBin, runOpts);

  for (const s of servers) {
    if (!s || !s.name) continue;
    if (s.auto === false) {
      const note = s.note || s.install_hint || '';
      logger.warn(`MCP "${s.name}" is marked manual (auto:false) — skipping. ${note}`);
      result.push({ name: s.name, action: 'manual-skip' });
      continue;
    }
    if (existing.includes(s.name)) {
      logger.info(`MCP "${s.name}" already configured — skipping.`);
      result.push({ name: s.name, action: 'skipped' });
      continue;
    }
    let args;
    if (s.url) {
      args = ['mcp', 'add', s.name, '--url', s.url, '--global'];
    } else if (Array.isArray(s.command) && s.command.length) {
      args = ['mcp', 'add', s.name, '--global', '--', ...s.command];
    } else {
      logger.warn(`MCP "${s.name}": no url or command — skipping.`);
      result.push({ name: s.name, action: 'invalid-skip' });
      continue;
    }
    const r = await run(opencodeBin, args, { retries: 2, timeoutMs: 60000, ...runOpts });
    if (r.code === 0) {
      logger.ok(`MCP "${s.name}" added.`);
      result.push({ name: s.name, action: 'added' });
    } else {
      logger.warn(`MCP "${s.name}" add failed (code ${r.code}).`);
      result.push({ name: s.name, action: 'failed' });
    }
  }
  return result;
}

// ---- 5. service -----------------------------------------------------------
export async function ensureService(opts = {}) {
  const opencodeBin = opts.opencodeBin || 'opencode';
  const runOpts = opts.runOpts || {};
  const result = { restartCode: null, apiOk: false, statusCode: null };

  const restart = await run(opencodeBin, ['service', 'restart'], { silent: true, retries: 1, timeoutMs: 45000, ...runOpts });
  result.restartCode = restart.code;
  if (restart.code !== 0) {
    logger.warn('`opencode service restart` did not succeed (service may not be running yet) — continuing.');
  }

  const api = await run(opencodeBin, ['api', 'get', '/api/info'], { capture: true, silent: true, retries: 1, timeoutMs: 30000, ...runOpts });
  const body = String((api && (api.out || api.stdout)) || '');
  result.apiOk = Boolean(body) && /200|"ok"|"status"|version/i.test(body);
  if (api && api.err) result.apiErr = String(api.err).slice(0, 300);

  if (!result.apiOk) {
    const st = await run(opencodeBin, ['service', 'status'], { silent: true, retries: 1, timeoutMs: 20000, ...runOpts });
    result.statusCode = st.code;
    result.apiOk = st.code === 0;
  }
  if (result.apiOk) logger.ok('OpenCode service responds (api /api/info OK).');
  else logger.warn('OpenCode service not responding — start it with `opencode` or `opencode service start`.');
  return result;
}

// ---- full stack -----------------------------------------------------------
export async function installFullStack(opts = {}) {
  const f = opts.flags || {};
  const dryRun = Boolean(opts.dryRun);
  const summary = {};

  if (!f.noConfig) {
    if (dryRun) {
      logger.info(`DRY: would render config (${CONFIG_FILES.join(', ')}) into ${configDir({ target: opts.target })} with .bak-<ts> backups`);
      summary.config = { dryRun: true };
    } else {
      summary.config = await copyConfig(opts);
    }
  } else {
    logger.info('--no-config: skipping config render.');
  }

  if (!f.noPlugins) {
    if (dryRun) {
      const n = listDirNames(path.join(resolveAssetsRoot(opts), 'plugins')).length;
      logger.info(`DRY: would copy ${n} plugins, install deps per lockfile, run import smoke on each`);
      summary.plugins = { dryRun: true };
    } else {
      summary.plugins = await installPlugins(opts);
    }
  } else {
    logger.info('--no-plugins: skipping plugins.');
  }

  if (!f.noSkills) {
    if (dryRun) {
      const n = listDirNames(path.join(resolveAssetsRoot(opts), 'skills')).length;
      logger.info(`DRY: would copy ${n} skills (existing user skills preserved)`);
      summary.skills = { dryRun: true };
    } else {
      summary.skills = await installSkills(opts);
    }
  } else {
    logger.info('--no-skills: skipping skills.');
  }

  if (!f.noMcp) {
    if (dryRun) {
      logger.info('DRY: would sync MCP servers from assets/mcp/mcp-servers.json via `opencode mcp add --global` (skipping already-configured)');
      summary.mcps = { dryRun: true };
    } else {
      summary.mcps = await installMcp(opts);
    }
  } else {
    logger.info('--no-mcp: skipping MCP.');
  }

  if (dryRun) {
    logger.info('DRY: would restart opencode service and verify api /api/info');
    summary.service = { dryRun: true };
  } else {
    summary.service = await ensureService(opts);
  }
  return summary;
}