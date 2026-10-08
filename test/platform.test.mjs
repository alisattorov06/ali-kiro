// ali-kiro — platform detection & environment helpers.
// Uses real seams: env vars (HOME/XDG_CONFIG_HOME/APPDATA/USERPROFILE/PATH)
// plus process.platform / process.arch / process.stdout.isTTY overrides
// (those are configurable globals, not unexported module internals).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectOS,
  detectArch,
  homeDir,
  configDir,
  stateDir,
  isTTY,
  isRoot,
  has,
  pm,
  shellStyle,
  PM_NAMES,
} from '../src/core/platform.mjs';

// ---- tiny helpers ---------------------------------------------------------

const REAL_PLATFORM = process.platform; // captured once, before any override
const REAL_ARCH = process.arch;

function setPlatform(v) {
  Object.defineProperty(process, 'platform', { value: v, configurable: true });
}
function restorePlatform() {
  Object.defineProperty(process, 'platform', {
    value: REAL_PLATFORM,
    configurable: true,
  });
}

function setArch(v) {
  Object.defineProperty(process, 'arch', { value: v, configurable: true });
}
function restoreArch() {
  Object.defineProperty(process, 'arch', {
    value: REAL_ARCH,
    configurable: true,
  });
}

/** Run fn with the given env overrides; always restores the previous values. */
async function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ---- OS / arch detection --------------------------------------------------

test('detectOS maps the real platform', () => {
  assert.strictEqual(detectOS(), detectOS()); // smoke: no throw
  const expected = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
  assert.strictEqual(detectOS(), expected);
});

test('detectOS overrides: win32→windows, darwin→macos', () => {
  try {
    setPlatform('win32');
    assert.strictEqual(detectOS(), 'windows');
    setPlatform('darwin');
    assert.strictEqual(detectOS(), 'macos');
    setPlatform('freebsd');
    assert.strictEqual(detectOS(), 'linux'); // anything non-darwin/win32 is linux
  } finally {
    restorePlatform();
  }
});

test('detectArch maps common arch strings', () => {
  assert.strictEqual(detectArch(), process.arch); // real arch always "resolves"
  try {
    setArch('amd64');
    assert.strictEqual(detectArch(), 'x64');
    setArch('ia32');
    assert.strictEqual(detectArch(), 'x64');
    setArch('arm64');
    assert.strictEqual(detectArch(), 'arm64');
    setArch('aarch64');
    assert.strictEqual(detectArch(), 'arm64');
    setArch('arm');
    assert.strictEqual(detectArch(), 'arm64');
    setArch('riscv64');
    assert.strictEqual(detectArch(), 'riscv64'); // unknown → passthrough
  } finally {
    restoreArch();
  }
});

// ---- path resolution ------------------------------------------------------

test('configDir linux: honors XDG_CONFIG_HOME', async () => {
  await withEnv(
    { XDG_CONFIG_HOME: '/opt/xdg', HOME: '/home/tester', APPDATA: undefined, USERPROFILE: undefined },
    () => {
      setPlatform('linux');
      try {
        assert.strictEqual(configDir(), path.join('/opt/xdg', 'opencode'));
      } finally {
        restorePlatform();
      }
    },
  );
});

test('configDir linux: falls back to ~/.config/opencode', async (t) => {
  if (process.platform === 'win32') {
    t.skip('HOME-based fallback is POSIX-only; os.homedir() reads USERPROFILE on Windows');
    return;
  }
  await withEnv({ HOME: '/home/tester', XDG_CONFIG_HOME: undefined }, () => {
    setPlatform('linux');
    try {
      const expected = path.join(os.homedir(), '.config', 'opencode');
      assert.strictEqual(configDir(), expected);
      assert.ok(configDir().startsWith(path.join('/home/tester', '.config')));
    } finally {
      restorePlatform();
    }
  });
});

test('configDir windows: APPDATA\\opencode takes precedence', async () => {
  await withEnv({ APPDATA: 'C:\\Users\\X\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\X' }, () => {
    setPlatform('win32');
    try {
      assert.strictEqual(configDir(), path.join('C:\\Users\\X\\AppData\\Roaming', 'opencode'));
    } finally {
      restorePlatform();
    }
  });
});

test('configDir windows: USERPROFILE\\<home>\\.config\\opencode without APPDATA', async () => {
  await withEnv({ APPDATA: undefined, USERPROFILE: 'C:\\Users\\X' }, () => {
    setPlatform('win32');
    try {
      assert.strictEqual(configDir(), path.join('C:\\Users\\X', '.config', 'opencode'));
    } finally {
      restorePlatform();
    }
  });
});

test('configDir: explicit --target wins over everything', async () => {
  const t = path.join(os.tmpdir(), 'ali-kiro-target-test');
  await withEnv({ XDG_CONFIG_HOME: '/opt/xdg', APPDATA: 'C:\\AppData' }, () => {
    setPlatform('win32');
    try {
      assert.strictEqual(configDir({ target: t }), path.resolve(t));
    } finally {
      restorePlatform();
    }
  });
});

test('stateDir lives under the home dir', async () => {
  await withEnv({ HOME: '/home/tester' }, () => {
    assert.strictEqual(stateDir(), path.join(os.homedir(), '.ali-kiro'));
  });
});

test('homeDir is non-empty and absolute', () => {
  assert.ok(homeDir());
  assert.ok(path.isAbsolute(homeDir()));
});

// ---- has() / pm() ---------------------------------------------------------

test('has() finds real commands and rejects nonsense', () => {
  assert.strictEqual(has('node'), true);
  assert.strictEqual(has('ali-kiro-no-such-command-9f3k2'), false);
});

test('has() resolves commands via PATH (injected lookup)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ali-kiro-has-'));
  fs.writeFileSync(path.join(dir, 'ali-kiro-fake-tool'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(dir, 'ali-kiro-fake-tool'), 0o755);
  try {
    const orig = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${orig || ''}`;
    try {
      assert.strictEqual(has('ali-kiro-fake-tool'), true);
    } finally {
      process.env.PATH = orig;
    }
    assert.strictEqual(has('ali-kiro-fake-tool'), false); // off PATH again
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pm() returns a subset of PM_NAMES and reflects PATH', async () => {
  const pkg = pm();
  assert.ok(Array.isArray(pkg));
  for (const p of pkg) assert.ok(PM_NAMES.includes(p));
  if (has('npm')) assert.ok(pkg.includes('npm'));
  if (has('bun')) assert.ok(pkg.includes('bun'));
});

// ---- tty / root / shell style --------------------------------------------

test('isTTY() is false in a captured test process', () => {
  assert.strictEqual(isTTY(), false);
});

test('isTTY() flips with process.stdout.isTTY', () => {
  const desc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  try {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    assert.strictEqual(isTTY(), true);
    Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
    assert.strictEqual(isTTY(), false);
  } finally {
    if (desc) Object.defineProperty(process.stdout, 'isTTY', desc);
    else Object.defineProperty(process.stdout, 'isTTY', { value: undefined, configurable: true });
  }
});

test('isRoot() is a boolean (never throws)', () => {
  assert.strictEqual(typeof isRoot(), 'boolean');
  try {
    setPlatform('win32');
    assert.strictEqual(isRoot(), false); // windows → always false
  } finally {
    restorePlatform();
  }
  assert.strictEqual(typeof isRoot(), 'boolean');
});

test('shellStyle(): sh on unix, powershell on windows', () => {
  try {
    setPlatform('linux');
    assert.strictEqual(shellStyle(), 'sh');
    setPlatform('win32');
    assert.strictEqual(shellStyle(), 'powershell');
  } finally {
    restorePlatform();
  }
});