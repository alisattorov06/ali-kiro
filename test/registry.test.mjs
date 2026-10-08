// ali-kiro — AI assistant catalog (registry). Checks that all 7 known ids are
// present in the catalog, that each resolves via entryById, and that every
// entry has a verify command plus concrete per-OS install commands.
import { test } from 'node:test';
import assert from 'node:assert';
import { catalog, entryById, TOOL_IDS } from '../src/core/ai-registry.mjs';

const IDS = ['opencode', 'claude-code', 'codex', 'cursor', 'aider', 'gemini', 'antigravity'];
const OSES = ['linux', 'macos', 'windows'];

test('catalog exposes exactly the 7 known tool ids', () => {
  assert.deepStrictEqual(catalog.map((e) => e.id), IDS);
  assert.deepStrictEqual(TOOL_IDS, IDS);
  assert.strictEqual(new Set(IDS).size, IDS.length, 'ids are unique');
});

test('entryById resolves every id and returns undefined for unknown ids', () => {
  for (const id of IDS) {
    const e = entryById(id);
    assert.ok(e, `entry found for ${id}`);
    assert.strictEqual(e.id, id);
  }
  assert.strictEqual(entryById('not-a-tool'), undefined);
  assert.strictEqual(entryById(''), undefined);
  assert.strictEqual(entryById(), undefined);
});

test('every entry has a name, verifyCmd, verifyArg and a homepage', () => {
  for (const e of catalog) {
    assert.ok(typeof e.name === 'string' && e.name.length, e.id);
    assert.ok(e.verifyCmd, `${e.id}.verifyCmd`);
    assert.ok(Array.isArray(e.verifyArg) && e.verifyArg.length, `${e.id}.verifyArg`);
    assert.ok(e.homepage, `${e.id}.homepage`);
  }
});

test('every entry has non-empty cmds for linux/macos/windows plus a matching verifyCmd', () => {
  for (const e of catalog) {
    for (const os of OSES) {
      const per = e.perOS[os];
      assert.ok(per, `${e.id}.perOS.${os} exists`);
      assert.ok(Array.isArray(per.cmds) && per.cmds.length > 0, `${e.id}.perOS.${os}.cmds non-empty`);
      for (const cmd of per.cmds) {
        assert.ok(cmd && cmd.type, `${e.id}.${os} cmd type`);
        assert.ok(cmd.line || cmd.cmd, `${e.id}.${os} cmd body`);
      }
    }
    // verifyCmd lives at the entry level, not per-OS — cheaper to run.
    assert.strictEqual(entryById(e.id).verifyCmd, e.verifyCmd);
  }
});

test('commands that need tools declare their requires (npm/curl/pipx/...)', () => {
  for (const e of catalog) {
    for (const os of OSES) {
      for (const cmd of e.perOS[os].cmds) {
        if (cmd.cmd) {
          assert.ok(Array.isArray(cmd.requires) && cmd.requires.some((r) => typeof r === 'string'), `${e.id}.${os}`);
        }
      }
    }
  }
});

test('antigravity entry targets the Antigravity CLI (agy)', () => {
  const e = entryById('antigravity');
  assert.ok(e, 'antigravity entry found');
  assert.strictEqual(e.name, 'Antigravity');
  assert.strictEqual(e.verifyCmd, 'agy');
  assert.deepStrictEqual(e.verifyArg, ['--version']);
  assert.ok(e.homepage.includes('antigravity.google'), 'homepage points at antigravity.google');
  assert.strictEqual(e.needsNode, false);
  assert.strictEqual(e.needsPython, false);
  for (const os of OSES) {
    assert.ok(Array.isArray(e.perOS[os].cmds) && e.perOS[os].cmds.length > 0, `${os} cmds non-empty`);
  }
  // Official script installers first, package-manager fallbacks second.
  assert.ok(e.perOS.linux.cmds[0].line.includes('antigravity.google/cli/install.sh'), 'linux uses curl|bash script');
  assert.ok(e.perOS.macos.cmds[0].line.includes('antigravity.google/cli/install.sh'), 'macos uses curl|bash script');
  assert.ok(e.perOS.windows.cmds[0].line.includes('antigravity.google/cli/install.ps1'), 'windows uses irm|iex script');
  assert.strictEqual(e.perOS.windows.cmds[0].requires[0], 'pwsh');
  assert.deepStrictEqual(e.perOS.windows.cmds[1].args, ['install', '--id', 'Google.AntigravityCLI', '-e']);
  assert.ok(e.note && /sign-in/.test(e.note), 'note mentions the Google sign-in requirement');
});