// ali-kiro — command executor: retries, capture, timeout, sudo passthrough,
// secret redaction. All spawning goes through the injectable `spawnImpl`
// option backed by the fake-spawn helper.
import { test } from 'node:test';
import assert from 'node:assert';
import { run, redact } from '../src/core/executor.mjs';
import { createFakeSpawn } from './helpers/fake-spawn.mjs';

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

// ---- retries --------------------------------------------------------------

test('run retries on failure and returns the success result', async () => {
  const fake = createFakeSpawn([
    { code: 1, out: '', err: 'first failure' },
    { code: 1, out: '', err: 'second failure' },
    { code: 0, out: 'yay\n', err: '' },
  ]);
  const res = await run('tool', ['arg1', 'arg2'], { spawnImpl: fake, capture: true, silent: true });

  assert.strictEqual(res.code, 0);
  assert.strictEqual(res.out, 'yay\n');
  assert.strictEqual(res.err, '');
  assert.strictEqual(res.stdout, 'yay\n'); // capture convenience alias
  assert.strictEqual(fake.calls.length, 3, '2 failures then 1 success → 3 spawns');

  assert.strictEqual(fake.calls[0].cmd, 'tool');
  assert.deepStrictEqual(fake.calls[0].args, ['arg1', 'arg2']);
  assert.strictEqual(fake.calls[1].cmd, 'tool');
  assert.strictEqual(fake.calls[2].cmd, 'tool');
});

test('run with retries:1 does not retry', async () => {
  const fake = createFakeSpawn([{ code: 2, err: 'nope' }]);
  const res = await run('tool', [], { spawnImpl: fake, retries: 1, silent: true });
  assert.strictEqual(res.code, 2);
  assert.strictEqual(fake.calls.length, 1);
});

test('run env option is merged over process.env and seen by spawn', async () => {
  const fake = createFakeSpawn([{ code: 0, out: '' }]);
  const res = await run('tool', [], { spawnImpl: fake, env: { FOO: 'bar', __ALI_KIRO_PROBE: '1' }, silent: true, capture: true });
  assert.strictEqual(res.code, 0);
  assert.ok(fake.calls[0].env);
  assert.strictEqual(fake.calls[0].env.FOO, 'bar');
  assert.strictEqual(fake.calls[0].env.__ALI_KIRO_PROBE, '1');
  assert.ok(
    Object.keys(fake.calls[0].env).some((k) => k.toLowerCase() === 'path'),
    'inherits process.env',
  );
});

// ---- capture --------------------------------------------------------------

test('capture collects stdout and stderr separately', async () => {
  const fake = createFakeSpawn([{ code: 0, out: 'out-line-1\nout-line-2\n', err: 'err-line\n' }]);
  const res = await run('tool', [], { spawnImpl: fake, capture: true, silent: true });
  assert.strictEqual(res.out, 'out-line-1\nout-line-2\n');
  assert.strictEqual(res.err, 'err-line\n');
  assert.strictEqual(res.stdout, res.out);
});

test('non-capture mode does not set the stdout alias', async () => {
  const fake = createFakeSpawn([{ code: 0, out: 'ignored\n' }]);
  const res = await run('tool', [], { spawnImpl: fake, silent: true });
  assert.strictEqual(res.code, 0);
  assert.ok(!('stdout' in res));
});

// ---- timeout --------------------------------------------------------------

test('run times out with code 124 when the child never closes', async () => {
  const fake = createFakeSpawn([{ code: 0, out: '', err: '', close: false }]);
  const res = await run('sleeper', [], {
    spawnImpl: fake,
    timeoutMs: 30,
    retries: 1,
    silent: true,
    capture: true,
  });
  assert.strictEqual(res.code, 124);
  assert.match(res.err, /timed out after 30ms/);
  assert.ok(fake.calls[0].child.killed, 'child was SIGKILLed by the timeout path');
});

// ---- spawn errors ---------------------------------------------------------

test('run resolves code -1 when the child emits an error event', async () => {
  const fake = createFakeSpawn([{ code: 0, fail: new Error('spawn ENOENT') }]);
  const res = await run('tool', [], { spawnImpl: fake, retries: 1, silent: true });
  assert.strictEqual(res.code, -1);
  assert.match(res.err, /spawn ENOENT/);
});

test('run resolves code -1 when spawnImpl throws synchronously', async () => {
  const throwing = () => {
    throw new Error('sync spawn failure');
  };
  const res = await run('tool', [], { spawnImpl: throwing, retries: 1, silent: true });
  assert.strictEqual(res.code, -1);
  assert.match(res.err, /sync spawn failure/);
});

// ---- secret redaction -----------------------------------------------------

test('redact() masks credential-flag arguments', () => {
  assert.strictEqual(redact('--api-key abc123'), '--api-key ***REDACTED***');
  assert.strictEqual(redact('--token hunter2'), '--token ***REDACTED***');
  assert.strictEqual(redact('--password s3cr3t'), '--password ***REDACTED***');
  assert.strictEqual(redact('--bearer-token abc'), '--bearer-token ***REDACTED***');
  assert.strictEqual(redact('upload --secret xyz --keep me'), 'upload --secret ***REDACTED*** --keep me');
  // values attached with "=" are not whitespace-separated → left untouched
  assert.strictEqual(redact('--api-key=inline'), '--api-key=inline');
  assert.strictEqual(redact('nothing secret here'), 'nothing secret here');
  assert.strictEqual(redact(undefined), '');
  assert.strictEqual(redact(null), '');
});

test('failed run never echoes the secret in logged output', async () => {
  const fake = createFakeSpawn([{ code: 7, err: 'auth rejected' }]);
  const logs = captureLogs();
  try {
    const res = await run('deploy', ['--token', 'SUPER-SECRET-99'], {
      spawnImpl: fake,
      retries: 1,
      silent: false,
      capture: true,
    });
    assert.strictEqual(res.code, 7);
    const all = [...logs.out, ...logs.err].join('\n');
    assert.ok(all.includes('***REDACTED***'), 'failure log shows the redacted form');
    assert.ok(!all.includes('SUPER-SECRET-99'), 'raw secret never reaches the log');
  } finally {
    logs.restore();
  }
});