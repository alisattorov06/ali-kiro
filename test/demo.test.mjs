// ali-kiro — `--demo` scripted session. It must be fast, fully deterministic,
// exit 0, report all 7 steps, and emit zero ANSI codes (colors are forced off).
import { test } from 'node:test';
import assert from 'node:assert';
import { runDemo } from '../src/install/demo.mjs';

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

test('runDemo exits 0 and reports 7 steps', async () => {
  const logs = captureLogs();
  try {
    const result = await runDemo({ sleepMs: 0 });
    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.steps, 7);
  } finally {
    logs.restore();
  }
  const all = logs.out.join('\n');
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    assert.match(all, new RegExp(`\\[${n}/7\\]`), `step ${n}/7 printed`);
  }
});

test('runDemo output is deterministic across two runs', async () => {
  const first = captureLogs();
  let run1;
  try {
    run1 = await runDemo({ sleepMs: 0 });
  } finally {
    first.restore();
  }
  const second = captureLogs();
  let run2;
  try {
    run2 = await runDemo({ sleepMs: 0 });
  } finally {
    second.restore();
  }
  assert.deepStrictEqual(run1, run2);
  assert.deepStrictEqual(first.out, second.out, 'identical stdout');
  assert.deepStrictEqual(first.err, second.err, 'identical stderr');
});

test('runDemo emits no ANSI escape codes (colors forced off)', async () => {
  const logs = captureLogs();
  try {
    await runDemo({ sleepMs: 0 });
  } finally {
    logs.restore();
  }
  const all = [...logs.out, ...logs.err].join('\n');
  assert.ok(!all.includes('\x1b['), 'no escape sequences in demo output');
});

test('runDemo output contains the FINAL REPORT and key install lines', async () => {
  const logs = captureLogs();
  try {
    await runDemo({ sleepMs: 0 });
  } finally {
    logs.restore();
  }
  const all = logs.out.join('\n');
  assert.match(all, /FINAL REPORT/);
  assert.match(all, /plugin smoke OK: FlowDeck/);
  assert.match(all, /MCP "context7" added/);
  assert.match(all, /Errors: 0   Warnings: 2/);
});