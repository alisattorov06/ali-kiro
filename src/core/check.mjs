// ali-kiro — verification helpers: version parsing, sha256, plugin smoke, MCP list.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { run } from './executor.mjs';

/** First semver-ish token in `text`, or null. */
export function parseVersion(text) {
  const m = String(text || '').match(/(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/);
  return m ? m[1] : null;
}

/** Run `<cmd> <args>` and parse the version from its output; null when it fails/absent. */
export async function binVersion(cmd, args = ['--version'], opts = {}) {
  try {
    const res = await run(cmd, args, {
      capture: true,
      silent: true,
      retries: 1,
      timeoutMs: 15000,
      ...opts,
    });
    const text = `${res.out}\n${res.err}`.trim();
    if (!text) return null;
    return parseVersion(text);
  } catch {
    return null;
  }
}

/** Verify a file's SHA-256 hex digest (crypto). Throws if the file is missing. */
export function verifySha256(file, expected) {
  const data = fs.readFileSync(file);
  const actual = createHash('sha256').update(data).digest('hex');
  return actual === String(expected).toLowerCase();
}

/** Resolve the importable entry of a plugin directory (package.json main, then fallbacks). */
export function resolvePluginEntry(pluginDir) {
  const pkgPath = path.join(pluginDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      let main = pkg.main;
      if (typeof main === 'string' && main) {
        const entry = path.resolve(pluginDir, main.replace(/^\.\//, ''));
        if (fs.existsSync(entry)) return entry;
      }
    } catch {
      /* fall through to defaults */
    }
  }
  for (const name of ['index.mjs', 'index.js', 'dist/index.mjs', 'dist/index.js', 'src/index.mjs', 'src/index.js']) {
    const entry = path.join(pluginDir, name);
    if (fs.existsSync(entry)) return entry;
  }
  return null;
}

/**
 * Smoke-test an OpenCode plugin by dynamically importing its entry in a child
 * node process. Expects stdout `"<id> function"` (m.default.id + typeof setup).
 * cwd is set to the plugin dir. Returns { id, ok, error?, tsEntry? }.
 * Graceful for TS entries (node cannot import .ts — opencode loads them natively).
 */
export async function pluginImportSmoke(pluginDir, opts = {}) {
  const entry = resolvePluginEntry(pluginDir);
  if (!entry) {
    return { id: null, ok: false, error: `no importable entry found under ${pluginDir}` };
  }
  if (/\.(ts|mts|cts)$/.test(entry)) {
    return {
      id: null,
      ok: false,
      tsEntry: true,
      entry,
      error: 'TypeScript entry point — plain node cannot import .ts; opencode loads it natively, smoke skipped',
    };
  }
  const script = "import(process.argv[1]).then(m=>console.log(m.default?.id,typeof m.default?.setup)).catch(e=>{console.error(String(e));process.exit(1)})";
  try {
    const res = await run(process.execPath, ['-e', script, pathToFileURL(entry).href], {
      capture: true,
      silent: true,
      retries: 1,
      timeoutMs: 30000,
      cwd: pluginDir,
      ...opts,
    });
    const outLine = String(res.out || '').trim();
    const m = outLine.match(/^(\S+)\s+(\S+)/);
    const ok = Boolean(m && m[2] === 'function');
    return {
      id: m ? m[1] : null,
      ok,
      raw: outLine,
      error: ok ? '' : String(res.err || '').trim() || `unexpected output: "${outLine || '<empty>'}"`,
    };
  } catch (e) {
    return { id: null, ok: false, error: String((e && e.message) || e) };
  }
}

/** Parse `opencode mcp list` output → array of configured server names. */
export async function mcpList(opencodeBin = 'opencode', opts = {}) {
  try {
    const res = await run(opencodeBin, ['mcp', 'list'], {
      capture: true,
      silent: true,
      retries: 1,
      timeoutMs: 30000,
      ...opts,
    });
    const names = String(res.out || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const m = l.match(/^(\S+)/);
        return m ? m[1] : '';
      })
      .filter((n) => n && !/^(name|server|#)/i.test(n));
    return [...new Set(names)];
  } catch {
    return [];
  }
}