// ali-kiro — shared install+verify helper used by the per-tool providers.
import { run, runShell } from '../core/executor.mjs';
import { binVersion } from '../core/check.mjs';
import { detectOS, detectArch, pm } from '../core/platform.mjs';

function interpolate(line, vars) {
  return String(line).replace(/\{(\w+)\}/g, (_, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : `{${k}}`));
}

/**
 * Install a single tool from its registry entry (OS-aware, idempotent).
 * - already installed (binVersion) → skipped with version
 * - --dry-run → 'planned', nothing executed
 * - otherwise: walk perOS.cmds (fallback chain, each with retries) then verify.
 * Returns { id, name, status, action, version?, reason?, error?, installed }.
 */
export async function installAndVerify(entry, opts = {}) {
  const os = opts.os || detectOS();
  const arch = opts.arch || detectArch();
  const logger = opts.logger;
  const dryRun = Boolean(opts.dryRun);
  const noNpm = Boolean(opts.noNpm);
  const settings = entry.perOS[os];

  const existing = await binVersion(entry.verifyCmd, entry.verifyArg);
  if (existing) {
    logger?.info(`${entry.name} already installed (v${existing}) — skipping install.`);
    return {
      id: entry.id, name: entry.name, status: 'skipped', reason: 'already-installed',
      version: existing, action: 'already-installed', installed: true,
    };
  }

  if (dryRun) {
    logger?.info(`DRY: would install ${entry.name} (${entry.verifyCmd} ${entry.verifyArg.join(' ')})`);
    return { id: entry.id, name: entry.name, status: 'planned', action: 'install', installed: false };
  }

  if (!settings || !Array.isArray(settings.cmds) || settings.cmds.length === 0) {
    const msg = `${entry.name}: no install commands defined for ${os}`;
    logger?.err(msg);
    return { id: entry.id, name: entry.name, status: 'failed', action: 'install', error: msg, installed: false };
  }

  const usesNpm = settings.type === 'npm' || settings.cmds.some((c) => c.type === 'exec' && c.cmd === 'npm');
  if (noNpm && usesNpm) {
    const msg = `${entry.name}: --no-npm set and its commands need npm — skipping`;
    logger?.warn(`${msg}. Manual: ${(entry.manual || [entry.homepage]).map((m) => `  ${m}`).join('\n  ')}`);
    return { id: entry.id, name: entry.name, status: 'skipped', reason: 'no-npm', action: 'skipped-no-npm', installed: false };
  }

  const present = new Set(pm());
  let lastError = null;
  for (const c of settings.cmds) {
    const needs = (c.requires || []).filter((r) => !present.has(r));
    if (needs.length) {
      logger?.warn(`${entry.name}: missing ${needs.join(', ')} — trying next fallback command.`);
      lastError = new Error(`missing tool(s): ${needs.join(', ')}`);
      continue;
    }
    let res;
    try {
      if (c.type === 'shell') {
        res = await runShell(interpolate(c.line, { arch }), { retries: 3 });
      } else {
        res = await run(c.cmd, c.args, { retries: 3, sudo: Boolean(c.sudo) });
      }
    } catch (e) {
      res = { code: -1, err: String((e && e.message) || e) };
    }
    if (res && res.code === 0) {
      lastError = null;
      break;
    }
    lastError = new Error((res && res.err ? String(res.err).slice(0, 200) : `exit code ${res ? res.code : -1}`));
    logger?.warn(`${entry.name}: command failed (${lastError.message}) — trying fallback if any.`);
  }

  const v2 = await binVersion(entry.verifyCmd, entry.verifyArg);
  if (v2) {
    logger?.ok(`${entry.name} installed (v${v2})`);
    return { id: entry.id, name: entry.name, status: 'installed', action: 'install', version: v2, installed: true };
  }

  const manualLines = (entry.manual || [`see ${entry.homepage || 'the project homepage'}`]).map((m) => `  ${m}`);
  logger?.err(`Failed to install ${entry.name}. Manual instructions:\n${manualLines.join('\n')}`);
  return {
    id: entry.id, name: entry.name, status: 'failed', action: 'install',
    error: (lastError && lastError.message) || 'install failed', manual: manualLines.join('\n'), installed: false,
  };
}