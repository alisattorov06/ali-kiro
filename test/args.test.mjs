// ali-kiro — CLI argument parsing. Table-driven coverage of every supported
// flag plus the UsageError contract (exit code 4) for unknown flags/ids/values.
import { test } from 'node:test';
import assert from 'node:assert';
import { parseArgs, UsageError, HELP } from '../src/cli/args.mjs';

const CASES = [
  { argv: ['--help'], expect: { help: true } },
  { argv: ['-h'], expect: { help: true } },
  { argv: ['--version'], expect: { version: true } },
  { argv: ['-v'], expect: { version: true } },
  { argv: ['--yes'], expect: { yes: true } },
  { argv: ['-y'], expect: { yes: true } },
  { argv: ['--quiet'], expect: { quiet: true } },
  { argv: ['-q'], expect: { quiet: true } },
  { argv: ['--strict'], expect: { strict: true } },
  { argv: ['--dry-run'], expect: { dryRun: true } },
  { argv: ['-n'], expect: { dryRun: true } },
  { argv: ['--target', '/tmp/ak-dir'], expect: { target: '/tmp/ak-dir' } },
  { argv: ['--target=/tmp/ak-dir'], expect: { target: '/tmp/ak-dir' } },
  { argv: ['--only', 'opencode,cursor'], expect: { only: ['opencode', 'cursor'] } },
  { argv: ['--only', 'opencode, claude-code'], expect: { only: ['opencode', 'claude-code'] } },
  { argv: ['--only=codex'], expect: { only: ['codex'] } },
  { argv: ['--skip', 'aider'], expect: { skip: ['aider'] } },
  { argv: ['--skip', 'gemini, cursor'], expect: { skip: ['gemini', 'cursor'] } },
  { argv: ['--list'], expect: { list: true } },
  { argv: ['--steps'], expect: { steps: true } },
  { argv: ['--demo'], expect: { demo: true } },
  { argv: ['--no-config'], expect: { noConfig: true } },
  { argv: ['--no-plugins'], expect: { noPlugins: true } },
  { argv: ['--no-skills'], expect: { noSkills: true } },
  { argv: ['--no-mcp'], expect: { noMcp: true } },
  { argv: ['--no-npm'], expect: { noNpm: true } },
];

for (const c of CASES) {
  test(`parseArgs parses: ${c.argv.join(' ')}`, () => {
    const out = parseArgs(c.argv);
    for (const [key, value] of Object.entries(c.expect)) {
      assert.deepStrictEqual(out[key], value, `field ${key}`);
    }
  });
}

test('parseArgs([]) returns all defaults', () => {
  const out = parseArgs([]);
  assert.deepStrictEqual(out.only, []);
  assert.deepStrictEqual(out.skip, []);
  assert.deepStrictEqual(out.positional, []);
  for (const key of [
    'help', 'version', 'dryRun', 'yes', 'quiet', 'strict', 'list', 'steps', 'demo',
    'noConfig', 'noPlugins', 'noSkills', 'noMcp', 'noNpm',
  ]) {
    assert.strictEqual(out[key], false, key);
  }
  assert.strictEqual(out.target, null);
});

test('parseArgs accepts a combination of flags', () => {
  const out = parseArgs(['--only', 'opencode,cursor', '--quiet', '--target=/x', '--dry-run']);
  assert.deepStrictEqual(out.only, ['opencode', 'cursor']);
  assert.strictEqual(out.quiet, true);
  assert.strictEqual(out.target, '/x');
  assert.strictEqual(out.dryRun, true);
});

test('parseArgs keeps non-flag tokens as positionals', () => {
  const out = parseArgs(['extra', '--help', 'more']);
  assert.deepStrictEqual(out.positional, ['extra', 'more']);
  assert.strictEqual(out.help, true);
});

test('unknown long flag throws a UsageError with exit code 4', () => {
  assert.throws(
    () => parseArgs(['--bogus']),
    (e) => {
      assert.ok(e instanceof UsageError);
      assert.strictEqual(e.name, 'UsageError');
      assert.strictEqual(e.exitCode, 4);
      assert.match(e.message, /unknown option: --bogus/);
      return true;
    },
  );
});

test('unknown short flag throws UsageError with exit code 4', () => {
  assert.throws(() => parseArgs(['-z']), (e) => e instanceof UsageError && e.exitCode === 4);
});

test('unknown tool id in --only throws UsageError', () => {
  assert.throws(
    () => parseArgs(['--only', 'opencode,not-a-tool']),
    (e) => {
      assert.ok(e instanceof UsageError);
      assert.match(e.message, /unknown tool id "not-a-tool" for --only/);
      return true;
    },
  );
});

test('unknown tool id in --skip throws UsageError', () => {
  assert.throws(() => parseArgs(['--skip', 'nope']), (e) => e instanceof UsageError && e.exitCode === 4);
});

test('missing value for --target throws UsageError', () => {
  assert.throws(() => parseArgs(['--target']), (e) => {
    assert.ok(e instanceof UsageError);
    assert.match(e.message, /missing value for --target/);
    return true;
  });
});

test('missing value for --only throws UsageError', () => {
  assert.throws(() => parseArgs(['--only']), (e) => e instanceof UsageError && e.exitCode === 4);
});

test('HELP documents the exit codes and the 6 known tools', () => {
  assert.match(HELP, /ali-kiro/);
  assert.match(HELP, /--dry-run/);
  assert.match(HELP, /EXIT CODES/);
  const ids = 'opencode, claude-code, codex, cursor, aider, gemini';
  assert.match(HELP, new RegExp(ids.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/, /g, ', ')));
});