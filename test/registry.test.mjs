// ali-kiro — AI assistant catalog (registry). Checks that all 6 known ids are
// present in the catalog, that each resolves via entryById, and that every
// entry has a verify command plus concrete per-OS install commands.
import { test } from 'node:test';
import assert from 'node:assert';
import { catalog, entryById, TOOL_IDS } from '../src/core/ai-registry.mjs';

const IDS = ['opencode', 'claude-code', 'codex', 'cursor', 'aider', 'gemini'];
const OSES = ['linux', 'macos', 'windows'];

test('catalog exposes exactly the 6 known tool ids', () => {
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