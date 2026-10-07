// ali-kiro — assets-root resolution precedence.
// Explicit opts.assetsRoot > ALI_KIRO_ASSETS env > probe beside execPath >
// probe under cwd > module-relative REAL_ASSETS fallback (node/source mode).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REAL_ASSETS, probeAssets, resolveAssetsRoot } from '../src/core/assets.mjs';

// A minimal valid assets tree: config/opencode.json, mcp/mcp-servers.json,
// plugins/ with >= 1 entry (matches the probe requirements).
function makeAssetsRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ali-kiro-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'mcp'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugins', 'one-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'opencode.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(root, 'mcp', 'mcp-servers.json'), '[]', 'utf8');
  return root;
}

function makeEmptyDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ali-kiro-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function withEnv(name, value) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  };
}

function withCwd(dir) {
  const prev = process.cwd();
  process.chdir(dir);
  return () => process.chdir(prev);
}

test('probeAssets returns true for a valid assets tree and false otherwise', (t) => {
  const good = makeAssetsRoot(t);
  const empty = makeEmptyDir(t);
  assert.strictEqual(probeAssets(good), true);
  assert.strictEqual(probeAssets(empty), false);
  assert.strictEqual(probeAssets(path.join(good, 'nope', 'missing')), false, 'missing path never throws');
});

test('resolveAssetsRoot: opts.assetsRoot wins over ALI_KIRO_ASSETS env', (t) => {
  const a = makeAssetsRoot(t);
  const b = makeAssetsRoot(t);
  const restore = withEnv('ALI_KIRO_ASSETS', b);
  try {
    assert.strictEqual(resolveAssetsRoot({ assetsRoot: a }), a);
  } finally {
    restore();
  }
});

test('resolveAssetsRoot: env wins over a valid cwd probe', (t) => {
  const envRoot = makeAssetsRoot(t);
  const cwdRoot = makeAssetsRoot(t); // ./assets under the cwd
  const top = makeEmptyDir(t);
  fs.mkdirSync(path.join(top, 'assets'), { recursive: true });
  fs.cpSync(cwdRoot, path.join(top, 'assets'), { recursive: true });

  const restoreEnv = withEnv('ALI_KIRO_ASSETS', envRoot);
  const restoreCwd = withCwd(top);
  try {
    assert.strictEqual(resolveAssetsRoot({}), envRoot);
  } finally {
    restoreCwd();
    restoreEnv();
  }
});

test('resolveAssetsRoot: explicit override returns the given root verbatim (trusted, not probed)', (t) => {
  const empty = makeEmptyDir(t); // not a valid assets tree
  const restore = withEnv('ALI_KIRO_ASSETS', makeAssetsRoot(t));
  try {
    assert.strictEqual(resolveAssetsRoot({ assetsRoot: empty }), empty);
  } finally {
    restore();
  }
});

test('resolveAssetsRoot: node mode falls back to REAL_ASSETS and it passes the probe', (t) => {
  const restoreEnv = withEnv('ALI_KIRO_ASSETS', undefined);
  const restoreCwd = withCwd(makeEmptyDir(t)); // no valid ./assets, no assets beside node
  try {
    assert.strictEqual(resolveAssetsRoot({}), REAL_ASSETS);
    assert.strictEqual(probeAssets(REAL_ASSETS), true, 'src/assets satisfies the probe');
  } finally {
    restoreCwd();
    restoreEnv();
  }
});