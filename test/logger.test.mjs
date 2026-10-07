// ali-kiro — console logger: counters, --quiet, final report, ANSI/TTY control.
// Module state is global per process, so each test pins the options explicitly.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  TOTAL_STEPS,
  setLoggerOptions,
  isQuiet,
  getCounts,
  clearCounters,
  logger,
} from '../src/core/logger.mjs';

function captureLogs() {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => out.push(a.map(String).join(' '));
  console.error = (...a) => err.push(a.map(String).join(' '));
  return {
    out,
    err,
    restore() {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

test('TOTAL_STEPS is 7', () => {
  assert.strictEqual(TOTAL_STEPS, 7);
});

test('warn/err increment the counters', () => {
  setLoggerOptions({ tty: false, quiet: false });
  clearCounters();
  logger.warn('w-one');
  logger.warn('w-two');
  logger.err('e-one');
  assert.deepStrictEqual(getCounts(), { errors: 1, warnings: 2 });
});

test('isQuiet reflects the --quiet option', () => {
  setLoggerOptions({ quiet: true });
  assert.strictEqual(isQuiet(), true);
  setLoggerOptions({ quiet: false });
  assert.strictEqual(isQuiet(), false);
});

test('--quiet suppresses info/ok/step but warnings still count', () => {
  setLoggerOptions({ tty: false, quiet: true });
  clearCounters();
  const logs = captureLogs();
  try {
    logger.info('hidden info');
    logger.ok('hidden ok');
    logger.step(2, 'hidden step');
    logger.warn('still counted');
    assert.strictEqual(logs.out.length, 0, 'no stdout output while quiet');
    assert.strictEqual(logs.err.length, 0, 'no stderr output while quiet');
  } finally {
    logs.restore();
  }
  assert.deepStrictEqual(getCounts(), { errors: 0, warnings: 1 });
});

test('err is never suppressed by --quiet', () => {
  setLoggerOptions({ tty: false, quiet: true });
  clearCounters();
  const logs = captureLogs();
  try {
    logger.err('critical failure');
  } finally {
    logs.restore();
  }
  assert.strictEqual(logs.err.length, 1);
  assert.match(logs.err[0], /critical failure/);
  assert.strictEqual(getCounts().errors, 1);
});

test('finalReport produces a human summary', () => {
  setLoggerOptions({ tty: false, quiet: false });
  clearCounters();
  const logs = captureLogs();
  try {
    logger.finalReport({
      tools: { opencode: { installed: true, version: '2.0.24', action: 'install' } },
      plugins: [
        { name: 'fake-plugin', ok: true, version: '1.0.0' },
        { name: 'broken-plugin', ok: false },
      ],
      skillsCount: 3,
      mcps: [
        { name: 'context7', action: 'added' },
        { name: 'manual-one', action: 'manual-skip' },
      ],
    });
  } finally {
    logs.restore();
  }
  const all = logs.out.join('\n');
  assert.match(all, /FINAL REPORT/);
  assert.match(all, /opencode/);
  assert.match(all, /installed/);
  assert.match(all, /2\.0\.24/);
  assert.match(all, /fake-plugin/);
  assert.match(all, /\(smoke failed\)/);
  assert.match(all, /Skills copied: 3/);
  assert.match(all, /MCP servers:/);
  assert.match(all, /Errors: 0   Warnings: 0/);
});

test('no ANSI escape codes when not a TTY', () => {
  setLoggerOptions({ tty: false, quiet: false });
  clearCounters();
  const logs = captureLogs();
  try {
    logger.step(1, 'step msg');
    logger.ok('all good');
    logger.warn('a warning');
    logger.err('an error');
    logger.finalReport({ tools: { opencode: { installed: true, version: '1.2.3' } } });
  } finally {
    logs.restore();
  }
  const all = [...logs.out, ...logs.err].join('\n');
  assert.ok(!all.includes('\x1b['), `no escape sequences, got: ${all.slice(0, 200)}`);
});

test('step format is "[n/7]"', () => {
  setLoggerOptions({ tty: false, quiet: false });
  const logs = captureLogs();
  try {
    logger.step(3, 'three');
  } finally {
    logs.restore();
  }
  assert.strictEqual(logs.out.length, 1);
  assert.match(logs.out[0], /\[3\/7\]/);
  assert.match(logs.out[0], /three/);
});

test('ANSI paint is applied when a TTY is reported', () => {
  setLoggerOptions({ tty: true, quiet: false });
  const logs = captureLogs();
  try {
    logger.ok('tty-ok');
  } finally {
    logs.restore();
    setLoggerOptions({ tty: false });
  }
  assert.match(logs.out[0], /\x1b\[/);
});