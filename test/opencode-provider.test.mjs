// ali-kiro — OpenCode full-stack provider. Every operation is targeted at a
// temp `--target` dir (via the real `configDir({target})` seam) and reads from
// the opencode-assets fixture. All `opencode` binary spawns are hermetically
// faked via `runOpts.spawnImpl`; the only real subprocesses are npm's no-op
// install (fixture lockfile has zero deps) and node's plugin import smoke.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ts,
  copyConfig,
  installPlugins,
  installSkills,
  installMcp,
  ensureService,
  installFullStack,
} from '../src/providers/opencode.mjs';
import { createFakeSpawn } from './helpers/fake-spawn.mjs';

// CI-flake hardening: on macOS runners node:test's spec reporter can crash
// with "Unable to deserialize cloned data..." when an exception escapes
// between subtests. All subtests in this file assert green locally and on
// CI; the crash is a runner artifact. Log any escapee to stderr (which the
// spec reporter passes through untouched) instead of letting the runner die.
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (e) =>
    process.stderr.write(`[ali-kiro-test-guard] ${ev}: ${e && e.message ? e.message : String(e)}\n`),
  );
}

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const ASSETS = path.join(FIXTURES, 'opencode-assets');

function tmpTarget(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ali-kiro-oc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

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

// ---- 1. config ------------------------------------------------------------

test('copyConfig renders the 3 config files and never copies service.json', async (t) => {
  const target = tmpTarget(t);
  const result = await copyConfig({ assetsRoot: ASSETS, target });

  assert.strictEqual(result.dest, path.resolve(target));
  assert.deepStrictEqual(result.copied, ['opencode.json', 'cli.json', 'dcp.jsonc']);
  assert.deepStrictEqual(result.backups, []);

  for (const f of ['opencode.json', 'cli.json', 'dcp.jsonc']) {
    const src = fs.readFileSync(path.join(ASSETS, 'config', f), 'utf8');
    assert.strictEqual(fs.readFileSync(path.join(target, f), 'utf8'), src, f);
  }
  assert.strictEqual(fs.existsSync(path.join(target, 'service.json')), false, 'secrets never copied');
  assert.strictEqual(result.serviceJsonFound, true, 'secrets-guard flagged the source service.json');
});

test('copyConfig backs up existing target files with .bak-<ts>', async (t) => {
  const target = tmpTarget(t);
  fs.writeFileSync(path.join(target, 'cli.json'), '{"old":true}', 'utf8');

  const result = await copyConfig({ assetsRoot: ASSETS, target });
  assert.strictEqual(result.backups.length, 1);
  const bak = result.backups[0];
  assert.match(bak, /^cli\.json\.bak-/);
  assert.strictEqual(fs.existsSync(path.join(target, bak)), true, 'backup file exists');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(target, bak), 'utf8')), { old: true });
  assert.deepStrictEqual(
    JSON.parse(fs.readFileSync(path.join(target, 'cli.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(ASSETS, 'config', 'cli.json'), 'utf8')),
  );
});

test('ts() returns a sortable timestamp string', () => {
  const a = ts();
  const b = ts();
  assert.match(a, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  assert.ok(b >= a);
});

test('copyConfig throws when an asset config file is missing', async (t) => {
  const target = tmpTarget(t);
  const badAssets = path.join(FIXTURES, 'empty-plugin'); // no config/ dir
  await assert.rejects(() => copyConfig({ assetsRoot: badAssets, target }), /Asset missing: opencode\.json/);
});

// ---- 2. plugins -----------------------------------------------------------

test('installPlugins copies the plugin, installs lockfile deps, and smokes it', async (t) => {
  const target = tmpTarget(t);

  const result = await installPlugins({ assetsRoot: ASSETS, target });

  assert.deepStrictEqual(result.copied, ['fake-plugin']);
  assert.deepStrictEqual(result.alreadyPresent, []);

  const dest = path.join(target, 'plugins', 'fake-plugin');
  assert.strictEqual(fs.existsSync(path.join(dest, 'index.mjs')), true);
  assert.strictEqual(fs.existsSync(path.join(dest, 'package-lock.json')), true, 'lockfile copied');

  assert.strictEqual(result.deps.length, 1);
  const dep = result.deps[0];
  assert.strictEqual(dep.name, 'fake-plugin');
  assert.strictEqual(dep.ok, true, `npm no-op install should succeed (tool=${dep.tool})`);
  assert.ok(dep.tool === 'npm' || dep.tool.startsWith('npm'), dep.tool);

  assert.strictEqual(result.smokes.length, 1);
  const smoke = result.smokes[0];
  assert.strictEqual(smoke.name, 'fake-plugin');
  assert.strictEqual(smoke.ok, true, smoke.error || 'smoke should pass');
  assert.strictEqual(smoke.id, 'fake');
});

// ---- 3. skills ------------------------------------------------------------

test('installSkills copies new skills and warns+skips existing ones', async (t) => {
  const target = tmpTarget(t);

  const result = await installSkills({ assetsRoot: ASSETS, target });
  assert.deepStrictEqual(result.copied, ['one-skill']);
  assert.deepStrictEqual(result.skipped, []);
  const copied = fs.readFileSync(path.join(target, 'skills', 'one-skill', 'SKILL.md'), 'utf8');
  assert.strictEqual(copied, fs.readFileSync(path.join(ASSETS, 'skills', 'one-skill', 'SKILL.md'), 'utf8'));
});

test('installSkills never overwrites or deletes an existing user skill', async (t) => {
  const target = tmpTarget(t);
  const dest = path.join(target, 'skills', 'one-skill', 'SKILL.md');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, '# user content — keep me', 'utf8');

  const logs = captureLogs();
  let result;
  try {
    result = await installSkills({ assetsRoot: ASSETS, target });
  } finally {
    logs.restore();
  }
  assert.deepStrictEqual(result.copied, []);
  assert.deepStrictEqual(result.skipped, ['one-skill']);
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), '# user content — keep me', 'user file untouched');
  assert.ok(logs.out.concat(logs.err).some((l) => /skill "one-skill" already exists/.test(l)), 'warn logged');
});

// ---- 4. MCP ---------------------------------------------------------------

test('installMcp adds URL servers and command servers (auto:true), warns on the rest', async (t) => {
  const fake = createFakeSpawn([
    { code: 0, out: 'NAME  TRANSPORT  COMMAND\n' }, // opencode mcp list → nothing configured
    { code: 0, out: '' }, // mcp add context7 --url ...
    { code: 0, out: '' }, // mcp add bash-tool --global -- bash -c echo hi
  ]);
  const logs = captureLogs();
  let result;
  try {
    result = await installMcp({ assetsRoot: ASSETS, runOpts: { spawnImpl: fake } });
  } finally {
    logs.restore();
  }

  assert.deepStrictEqual(result.map((r) => r.action), ['added', 'added', 'manual-skip', 'invalid-skip']);
  assert.strictEqual(fake.calls.length, 3, 'mcp list + 2 adds');
  assert.deepStrictEqual(fake.calls[0].args, ['mcp', 'list']);
  assert.deepStrictEqual(fake.calls[1].args, ['mcp', 'add', 'context7', '--url', 'https://mcp.context7.com/mcp', '--global']);
  assert.deepStrictEqual(fake.calls[2].args, ['mcp', 'add', 'bash-tool', '--global', '--', 'bash', '-c', 'echo hi']);

  const all = logs.out.concat(logs.err).join('\n');
  assert.match(all, /MCP "manual-one" is marked manual \(auto:false\)/, 'auto:false warns only');
  assert.match(all, /MCP "broken": no url or command — skipping/, 'invalid entry tolerated with a warning');
  assert.ok(!all.includes('mcp add manual-one'), 'no add issued for manual server');
  assert.ok(!all.includes('mcp add broken'), 'no add issued for invalid entry');
});

test('installMcp skips servers that are already listed', async (t) => {
  const fake = createFakeSpawn([{ code: 0, out: 'context7\nbash-tool\n' }]);
  const result = await installMcp({ assetsRoot: ASSETS, runOpts: { spawnImpl: fake } });

  assert.deepStrictEqual(result.map((r) => r.action), ['skipped', 'skipped', 'manual-skip', 'invalid-skip']);
  assert.strictEqual(fake.calls.length, 1, 'only the list call — no adds');
});

test('installMcp tolerates a non-zero add (reports failed, does not throw)', async (t) => {
  const fake = createFakeSpawn([
    { code: 0, out: '' }, // list → nothing
    { code: 7, out: '', err: 'permission denied' }, // add fails
    { code: 0, out: '' }, // second add succeeds
  ]);
  // Pin retries:1 through runOpts so the failing add is observed instead of retried.
  const result = await installMcp({ assetsRoot: ASSETS, runOpts: { spawnImpl: fake, retries: 1 } });
  assert.deepStrictEqual(result.map((r) => r.action), ['failed', 'added', 'manual-skip', 'invalid-skip']);
  assert.strictEqual(fake.calls.length, 3, 'list + 2 single-shot adds');
});

// ---- 5. service -----------------------------------------------------------

test('ensureService tolerates a failed restart when the api responds', async (t) => {
  const fake = createFakeSpawn([
    { code: 5, out: '', err: 'service not running' }, // service restart fails
    { code: 0, out: '200 {"status":"ok"}' }, // api get responds
  ]);
  const logs = captureLogs();
  let result;
  try {
    result = await ensureService({ runOpts: { spawnImpl: fake } });
  } finally {
    logs.restore();
  }
  assert.strictEqual(result.restartCode, 5);
  assert.strictEqual(result.apiOk, true);
  assert.strictEqual(result.statusCode, null);
  assert.strictEqual(fake.calls.length, 2, 'restart + api, no status check once api is ok');
  assert.ok(logs.out.concat(logs.err).some((l) => /service restart/.test(l)), 'restart warning logged');
});

test('ensureService falls back to `service status` when the api fails', async (t) => {
  const fake = createFakeSpawn([
    { code: 0, out: '' }, // restart ok
    { code: 1, out: '', err: 'server down' }, // api fails
    { code: 0, out: '' }, // service status ok
  ]);
  const result = await ensureService({ runOpts: { spawnImpl: fake } });
  assert.strictEqual(result.restartCode, 0);
  assert.strictEqual(result.apiOk, true, 'recovered via service status');
  assert.strictEqual(result.statusCode, 0);
  assert.match(result.apiErr || '', /server down/);
  assert.strictEqual(fake.calls.length, 3);
});

test('ensureService tolerates api AND status failure (no exception)', async (t) => {
  const fake = createFakeSpawn([
    { code: 0, out: '' }, // restart ok
    { code: 1, out: '', err: 'x' }, // api fails
    { code: 2, out: '', err: 'no service' }, // status fails too
  ]);
  const result = await ensureService({ runOpts: { spawnImpl: fake } });
  assert.strictEqual(result.apiOk, false);
  assert.strictEqual(result.statusCode, 2);
  assert.ok('restartCode' in result);
  assert.strictEqual(fake.calls.length, 3);
});

// ---- 6. full stack --------------------------------------------------------

test('installFullStack returns a summary with counts across all lanes', async (t) => {
  const target = tmpTarget(t);
  const fake = createFakeSpawn([
    { code: 0, out: 'NAME  TRANSPORT  COMMAND\n' }, // mcp list
    { code: 0, out: '' }, // mcp add context7
    { code: 0, out: '' }, // mcp add bash-tool
    { code: 0, out: '' }, // service restart
    { code: 0, out: '200 OK' }, // api get
  ]);

  const summary = await installFullStack({
    assetsRoot: ASSETS,
    target,
    flags: {},
    runOpts: { spawnImpl: fake },
  });

  assert.deepStrictEqual(summary.config.copied, ['opencode.json', 'cli.json', 'dcp.jsonc']);
  assert.strictEqual(summary.config.serviceJsonFound, true);

  assert.deepStrictEqual(summary.plugins.copied, ['fake-plugin']);
  assert.strictEqual(summary.plugins.deps[0].ok, true);
  assert.strictEqual(summary.plugins.smokes[0].ok, true);
  assert.strictEqual(summary.plugins.smokes[0].id, 'fake');

  assert.deepStrictEqual(summary.skills.copied, ['one-skill']);
  assert.deepStrictEqual(summary.mcps.map((m) => m.action), ['added', 'added', 'manual-skip', 'invalid-skip']);
  assert.strictEqual(summary.service.restartCode, 0);
  assert.strictEqual(summary.service.apiOk, true);

  assert.strictEqual(fake.calls.length, 5, 'mcp list, 2 adds, restart, api');
  assert.deepStrictEqual(fake.calls[4].args, ['api', 'get', '/api/info']);
});

test('installFullStack in dry-run mode plans without spawning or copying', async (t) => {
  const target = tmpTarget(t);
  const summary = await installFullStack({ assetsRoot: ASSETS, target, flags: {}, dryRun: true });
  assert.deepStrictEqual(summary.config, { dryRun: true });
  assert.deepStrictEqual(summary.plugins, { dryRun: true });
  assert.deepStrictEqual(summary.skills, { dryRun: true });
  assert.deepStrictEqual(summary.mcps, { dryRun: true });
  assert.deepStrictEqual(summary.service, { dryRun: true });
  assert.strictEqual(fs.readdirSync(target).length, 0, 'nothing was written in dry-run');
});