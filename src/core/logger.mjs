// ali-kiro — console logger. All output is English. Colors only on TTY.
// Counts errors/warnings; `--quiet` suppresses non-error output.
const COLORS = {
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

export const TOTAL_STEPS = 7;

let useTty = Boolean(process.stdout && process.stdout.isTTY);
let quiet = false;
const counts = { errors: 0, warnings: 0 };

export function setLoggerOptions({ tty, quiet: q } = {}) {
  if (typeof tty === 'boolean') useTty = tty;
  if (typeof q === 'boolean') quiet = q;
}

export function isQuiet() {
  return quiet;
}

export function getCounts() {
  return { errors: counts.errors, warnings: counts.warnings };
}

export function clearCounters() {
  counts.errors = 0;
  counts.warnings = 0;
}

function paint(color, s) {
  return useTty && COLORS[color] ? `${COLORS[color]}${s}${COLORS.reset}` : s;
}

export const logger = {
  /** `▸ [n/7] msg` — numbered pipeline step. */
  step(n, msg) {
    if (quiet) return;
    console.log(`${paint('cyan', '▸')} [${n}/${TOTAL_STEPS}] ${paint('cyan', String(msg))}`);
  },
  ok(msg) {
    if (quiet) return;
    console.log(`${paint('green', '✔')} ${msg}`);
  },
  info(msg) {
    if (quiet) return;
    console.log(String(msg));
  },
  warn(msg) {
    counts.warnings += 1;
    if (quiet) return;
    console.log(`${paint('yellow', '!')} warn: ${paint('yellow', String(msg))}`);
  },
  err(msg) {
    counts.errors += 1;
    console.error(`${paint('red', '✘')} error: ${paint('red', String(msg))}`);
  },
  /** Human summary table for the end of a run. */
  finalReport(summary) {
    if (quiet) return;
    const s = summary || {};
    console.log('');
    console.log(paint('cyan', '──────────────────────────────────────────────'));
    console.log(paint('cyan', 'FINAL REPORT'));

    const tools = s.tools || {};
    const ids = Object.keys(tools);
    if (ids.length) {
      const w = Math.max(8, ...ids.map((i) => i.length));
      console.log(`${'TOOL'.padEnd(w + 2)}${'STATUS'.padEnd(12)}${'VERSION'.padEnd(18)}ACTION`);
      for (const id of ids) {
        const t = tools[id] || {};
        const status = t.installed ? paint('green', 'installed') : paint('yellow', 'missing');
        console.log(
          `${id.padEnd(w + 2)}${status.padEnd(12)}${String(t.version || '—').padEnd(18)}${t.action || ''}`,
        );
      }
    }

    const plugins = s.plugins || [];
    if (plugins.length) {
      console.log('');
      console.log('Plugins:');
      for (const p of plugins) {
        const mark = p.ok ? paint('green', '✔') : paint('red', '✘');
        console.log(`  ${mark} ${p.name}${p.ok ? '' : '  (smoke failed)'}${p.version ? `  v${p.version}` : ''}`);
      }
    }

    if (s.skillsCount != null) {
      console.log(`Skills copied: ${s.skillsCount} (existing user skills are preserved)`);
    }

    const mcps = s.mcps || [];
    if (mcps.length) {
      console.log('MCP servers:');
      for (const m of mcps) {
        const mark = m.action === 'added' || m.action === 'skipped' ? paint('green', '✔') : paint('yellow', '!');
        console.log(`  ${mark} ${m.name}  (${m.action})`);
      }
    }

    console.log('');
    console.log(`Errors: ${counts.errors}   Warnings: ${counts.warnings}`);
    console.log(paint('cyan', '──────────────────────────────────────────────'));
  },
};