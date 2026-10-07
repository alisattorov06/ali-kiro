// ali-kiro — hermetic spawn fake for tests.
//
// Mirrors the exact child_process surface that src/core/executor.mjs consumes:
//   - spawnImpl(cmd, args, { stdio, env, shell, cwd }) returns a child
//   - child.stdout / child.stderr are EventEmitters that emit 'data'
//   - child emits 'close' (code) and 'error' (err)
//   - child.kill(signal) is a no-op-safe method
//
// Usage:
//   import { createFakeSpawn } from './helpers/fake-spawn.mjs';
//   const spawn = createFakeSpawn([
//     { code: 1, err: 'boom' },        // consumed per spawn call (FIFO)
//     { code: 0, out: 'hello\n' },
//   ]);
//   const res = await run('cmd', ['x'], { spawnImpl: spawn, capture: true });
//   spawn.calls // [{ cmd, args, cwd, env, opts, child }]
//
// Behavior fields:
//   code   exit code passed to 'close'
//   out    stdout payload ('data' event; Buffer or string)
//   err    stderr payload
//   close  false → never emit 'close' (for timeout tests); default: emit
//   fail   Error → emit 'error' instead of data/close (spawn child error)

import { EventEmitter } from 'node:events';

export class FakeChild extends EventEmitter {
  constructor(behavior) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.behavior = behavior;
    this.killed = false;
    this.pid = 4242;
    this.exitCode = behavior.code;

    const out = Buffer.isBuffer(behavior.out)
      ? behavior.out
      : Buffer.from(String(behavior.out ?? ''));
    const err = String(behavior.err ?? '');

    // Defer emission so the executor can attach its listeners first.
    process.nextTick(() => {
      if (behavior.fail) {
        this.emit('error', behavior.fail);
        return;
      }
      if (out.length) this.stdout.emit('data', out);
      if (err.length) this.stderr.emit('data', err);
      if (behavior.close !== false) {
        this.emit('close', behavior.code);
      }
      // close === false → never resolves (timeout / hangs scenarios).
    });
  }

  kill(signal) {
    this.killed = true;
    this.signal = signal;
  }
}

/**
 * Build a spawn implementation from a queue of behaviors.
 * Behaviors are consumed FIFO; once exhausted, remaining spawns fall back
 * to a success behavior ({ code: 0 }) so tests never hang on miscounts.
 */
export function createFakeSpawn(behaviors = []) {
  const queue = behaviors.map((b) => ({ ...b }));
  const calls = [];

  const spawn = (cmd, args = [], opts = {}) => {
    const b = queue.length ? queue.shift() : { code: 0, out: '', err: '' };
    const child = new FakeChild(b);
    calls.push({ cmd, args, cwd: opts.cwd, env: opts.env, opts, child });
    return child;
  };

  spawn.calls = calls;
  return spawn;
}