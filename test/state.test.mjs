// ali-kiro — atomic state persistence: write → read round-trips, overwrites
// stay valid, custom paths work, and missing/corrupt files read as null.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeState, readState } from '../src/core/state.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ali-kiro-state-'));
}

test('write → read round-trip preserves the data', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'state.json');
  const data = {
    ranAt: '2026-10-07T00:00:00.000Z',
    tools: { opencode: { installed: true, version: '2.0.24', action: 'install' } },
    skillsCount: 38,
    errors: [],
  };
  try {
    const returned = await writeState(file, data);
    assert.strictEqual(returned, file);
    assert.deepStrictEqual(await readState(file), data);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic write: overwriting twice leaves valid JSON and no stray temp files', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'state.json');
  try {
    await writeState(file, { v: 1, nested: { a: true } });
    const afterFirst = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(afterFirst, { v: 1, nested: { a: true } });

    await writeState(file, { v: 2, list: [1, 2, 3] });
    const afterSecond = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(afterSecond, { v: 2, list: [1, 2, 3] });
    assert.deepStrictEqual(await readState(file), { v: 2, list: [1, 2, 3] });

    const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, [], 'no .tmp files remain after rename');
    assert.deepStrictEqual(fs.readdirSync(dir), ['state.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('custom output path (nested, not in a `test` dir) works', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'nested', 'deep', 'custom.json');
  try {
    await writeState(file, { custom: true });
    assert.strictEqual(fs.existsSync(file), true);
    assert.deepStrictEqual(await readState(file), { custom: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing state file reads as null', async () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'does-not-exist.json');
    assert.strictEqual(await readState(file), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupt (non-JSON) state file reads as null', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{ this is not json', 'utf8');
  try {
    assert.strictEqual(await readState(file), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});