// ali-kiro — `--list`: catalog with installed status (binVersion each).
import { catalog } from '../core/ai-registry.mjs';
import { binVersion } from '../core/check.mjs';
import { logger } from '../core/logger.mjs';

export async function listCatalog(_opts = {}) {
  const rows = [];
  for (const e of catalog) {
    const v = await binVersion(e.verifyCmd, e.verifyArg);
    rows.push({
      id: e.id,
      name: e.name,
      installed: Boolean(v),
      version: v,
      verify: `${e.verifyCmd} ${e.verifyArg.join(' ')}`,
      check: e.check || '',
    });
  }
  const w = Math.max(10, ...rows.map((r) => r.id.length));
  logger.info('AI coding assistants known to ali-kiro:');
  logger.info(`${'TOOL'.padEnd(w + 2)}${'STATUS'.padEnd(14)}${'VERSION'.padEnd(18)}VERIFY COMMAND`);
  for (const r of rows) {
    const status = r.installed ? 'installed' : 'not installed';
    logger.info(`${r.id.padEnd(w + 2)}${status.padEnd(14)}${String(r.version || '—').padEnd(18)}${r.verify}`);
  }
  logger.info('');
  logger.info('Use --only <id1,id2> / --skip <id1> to filter, --yes for non-interactive, --dry-run to preview.');
  return rows;
}