// ali-kiro — command executor. Wraps child_process.spawn with retries, timeouts,
// sudo handling, capture and secret-redaction. Node builtins only.
import { spawn } from 'node:child_process';
import { detectOS } from './platform.mjs';
import { logger } from './logger.mjs';

const DEFAULT_TIMEOUT = 180000; // ms
const RETRY_BASE_MS = 600;

const REDACT_RE = /(--?[a-z0-9-]*(?:key|token|secret|password|auth|bearer)[a-z0-9-]*)(\s+)(\S+)/gi;

/** Never echo secrets: mask anything that looks like a credential argument. */
export function redact(s) {
  return String(s ?? '').replace(REDACT_RE, '$1$2***REDACTED***');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function backoff(attempt) {
  return RETRY_BASE_MS * attempt;
}

function commandLabel(cmd, args) {
  return redact([cmd, ...args].join(' ')).slice(0, 220);
}

function spawnOnce(cmd, args, opts, timeoutMs, env) {
  return new Promise((resolve) => {
    const capture = Boolean(opts.capture);
    const spawnImpl = opts.spawnImpl || spawn;
    const stdio = capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'inherit'];
    let out = '';
    let err = '';
    let child;
    try {
      child = spawnImpl(cmd, args, {
        stdio,
        env: { ...(process.env || {}), ...(env || {}) },
        shell: false,
        cwd: opts.cwd,
      });
    } catch (e) {
      resolve({ code: -1, out: '', err: String((e && e.message) || e) });
      return;
    }
    if (capture) {
      child.stdout?.on('data', (d) => {
        out += String(d);
      });
      child.stderr?.on('data', (d) => {
        err += String(d);
      });
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* noop */
      }
      resolve({ code: 124, out, err: err + (err ? '\n' : '') + `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String((e && e.message) || e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: typeof code === 'number' ? code : -1, out, err });
    });
  });
}

/**
 * Run a command with up to `retries` attempts (default 3) and backoff.
 *
 * Resolves to `{ code, out, err }`. When `opts.capture` is true, stdout/stderr
 * are collected into `out`/`err` (a convenience `.stdout` alias is also set).
 * Secrets in args are never echoed (redacted). `silent` suppresses retry/failure
 * logging (still returns the result object).
 *
 * @param {string} cmd
 * @param {string[]} [args]
 * @param {object} [opts]  { timeoutMs=180000, retries=3, capture=false, sudo=false,
 *                          silent=false, env={}, cwd, spawnImpl (testing) }
 */
export async function run(cmd, args = [], opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const retries = opts.retries ?? 3;
  const silent = Boolean(opts.silent);
  const sudo = Boolean(opts.sudo);
  const env = opts.env || {};

  let realCmd = cmd;
  let realArgs = args;
  if (sudo) {
    if (detectOS() === 'windows') {
      // Windows has no POSIX sudo; node cannot trigger a UAC elevation from a
      // plain spawn. Run un-elevated and document the limitation.
      if (!silent) {
        logger.warn(
          'Windows: elevated (sudo) execution is not available from node — running un-elevated. ' +
            'If a command needs admin rights, run the terminal as Administrator.',
        );
      }
    } else {
      realCmd = 'sudo';
      realArgs = [cmd, ...(args || [])];
    }
  }

  let last = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    last = await spawnOnce(realCmd, realArgs, { ...opts, silent: true }, timeoutMs, env);
    if (last.code === 0) break;
    if (attempt < retries) {
      if (!silent) {
        const why = last.err ? `: ${redact(last.err).slice(0, 160)}` : ` (exit code ${last.code})`;
        logger.warn(`${commandLabel(realCmd, realArgs)} failed on attempt ${attempt}/${retries}${why} — retrying in ${backoff(attempt)}ms`);
      }
      await sleep(backoff(attempt));
    }
  }
  if (!silent && last && last.code !== 0 && last.code !== 124) {
    logger.err(`${commandLabel(realCmd, realArgs)} failed: ${redact(last.err || `exit code ${last.code}`).slice(0, 300)}`);
  }
  if (opts.capture && last) last.stdout = last.out;
  return last;
}

/** Run a shell line (pipes etc.). Windows → `powershell -NoProfile -Command <line>`. */
export async function runShell(line, opts = {}) {
  if (detectOS() === 'windows') {
    return run('powershell', ['-NoProfile', '-Command', line], opts);
  }
  return run('sh', ['-c', line], opts);
}