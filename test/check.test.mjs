// ali-kiro — verification helpers: version parsing, sha256, plugin import smoke,
// and `opencode mcp list` parsing. Everything hermetic: the real node child is
// used for plugin smoke (it must be importable by plain node anyway), and all
// binary spawns go through the fake-spawn helper.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  parseVersion,
  binVersion,
  verifySha256,
  resolvePluginEntry,
  pluginImportSmoke,
  mcpList,
} from '../src/core/check.mjs';
import { createFakeSpawn } from './helpers/fake-spawn.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const FAKE_PLUGIN = path.join(FIXTURES, 'fake-plugin');
const EMPTY_PLUGIN = path.join(FIXTURES, 'empty-plugin');

// ---- parseVersion ---------------------------------------------------------

test('parseVersion extracts semver-ish tokens from v-prefixed output', () => {
  assert.strictEqual(parseVersion('v24.21.0'), '24.21.0');
  assert.strictEqual(parseVersion('node v24.21.0 (npm 11.0.0)'), '24.21.0');
  assert.strictEqual(parseVersion('ali-kiro 1.0.0\n'), '1.0.0');
  assert.strictEqual(parseVersion('1.2'), '1.2');
  assert.strictEqual(parseVersion('2.0.24-rc.1'), '2.0.24-rc.1');
});

test('parseVersion returns null on empty or version-less text', () => {
  assert.strictEqual(parseVersion(''), null);
  assert.strictEqual(parseVersion(null), null);
  assert.strictEqual(parseVersion(undefined), null);
  assert.strictEqual(parseVersion('command not found'), null);
});

// ---- binVersion -----------------------------------------------------------

test('binVersion parses `--version` output through the injectable spawn', async () => {
  const fake = createFakeSpawn([{ code: 0, out: 'v24.21.0\n', err: '' }]);
  const v = await binVersion('node', ['--version'], { spawnImpl: fake, retries: 1, silent: true });
  assert.strictEqual(v, '24.21.0');
  assert.strictEqual(fake.calls[0].cmd, 'node');
  assert.deepStrictEqual(fake.calls[0].args, ['--version']);
});

test('binVersion returns null on a failing/absent binary', async () => {
  const fake = createFakeSpawn([{ code: 1, out: '', err: 'command not found' }]);
  const v = await binVersion('no-such-tool', ['--version'], { spawnImpl: fake, retries: 1, silent: true });
  assert.strictEqual(v, null);
});

test('binVersion returns null when spawnImpl throws', async () => {
  const throwing = () => {
    throw new Error('spawn ENOENT');
  };
  const v = await binVersion('ghost', ['--version'], { spawnImpl: throwing, retries: 1, silent: true });
  assert.strictEqual(v, null);
});

test('binVersion returns null on empty output', async () => {
  const fake = createFakeSpawn([{ code: 0, out: '', err: '' }]);
  const v = await binVersion('silent-tool', [], { spawnImpl: fake, retries: 1, silent: true });
  assert.strictEqual(v, null);
});

// ---- verifySha256 ---------------------------------------------------------

test('verifySha256 accepts the real digest (case-insensitive) and rejects others', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ali-kiro-sha-'));
  const file = path.join(dir, 'payload.bin');
  const payload = Buffer.from('ali-kiro verifySha256 payload \x00\x01\x02');
  fs.writeFileSync(file, payload);
  const digest = createHash('sha256').update(payload).digest('hex');
  try {
    assert.strictEqual(verifySha256(file, digest), true);
    assert.strictEqual(verifySha256(file, digest.toUpperCase()), true);
    assert.strictEqual(verifySha256(file, '0'.repeat(64)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verifySha256 throws when the file is missing', () => {
  const missing = path.join(os.tmpdir(), `ali-kiro-missing-${Date.now()}.bin`);
  assert.throws(() => verifySha256(missing, '0'.repeat(64)));
});

// ---- plugin import smoke --------------------------------------------------

test('resolvePluginEntry finds importable entries and null for empty dirs', () => {
  assert.ok(resolvePluginEntry(FAKE_PLUGIN).endsWith('index.mjs'));
  assert.strictEqual(resolvePluginEntry(EMPTY_PLUGIN), null);
});

test('pluginImportSmoke passes on a real importable plugin (id: x)', async () => {
  const r = await pluginImportSmoke(FAKE_PLUGIN);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.id, 'x');
  assert.strictEqual(r.error, '');
});

test('pluginImportSmoke fails gracefully on a plugin with no importable entry', async () => {
  const r = await pluginImportSmoke(EMPTY_PLUGIN);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.id, null);
  assert.match(r.error, /no importable entry/);
});

// ---- mcpList --------------------------------------------------------------

test('mcpList parses `opencode mcp list` output into unique server names', async () => {
  const fake = createFakeSpawn([
    { code: 0, out: 'NAME  TRANSPORT  COMMAND\ncontext7  remote  url\ngithub  command  local\ncontext7  remote  url\n' },
  ]);
  const names = await mcpList('opencode', { spawnImpl: fake, retries: 1, silent: true });
  assert.deepStrictEqual(names, ['context7', 'github']);
  assert.strictEqual(fake.calls[0].cmd, 'opencode');
  assert.deepStrictEqual(fake.calls[0].args, ['mcp', 'list']);
});

test('mcpList ignores the NAME header and blank lines', async () => {
  const fake = createFakeSpawn([{ code: 0, out: 'NAME  TRANSPORT  COMMAND\n\nwebsearch  url  remote\n' }]);
  const names = await mcpList('opencode', { spawnImpl: fake, retries: 1, silent: true });
  assert.deepStrictEqual(names, ['websearch']);
});

test('mcpList returns [] on empty output or failure', async () => {
  const empty = createFakeSpawn([{ code: 0, out: '', err: '' }]);
  assert.deepStrictEqual(await mcpList('opencode', { spawnImpl: empty, retries: 1, silent: true }), []);
  const failed = createFakeSpawn([{ code: 1, out: '', err: 'not installed' }]);
  assert.deepStrictEqual(await mcpList('opencode', { spawnImpl: failed, retries: 1, silent: true }), []);
});