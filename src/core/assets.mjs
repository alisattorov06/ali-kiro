// ali-kiro — assets-root resolution.
//
// Compiled standalone binaries cannot read module-relative paths (bun's
// virtual filesystem), so the assets directory is located via an explicit
// probe order. In node/source mode the (c)/(d) probes normally fail and the
// final fallback (module-relative REAL_ASSETS) passes, keeping behavior
// unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REAL_ASSETS = fileURLToPath(new URL('../assets', import.meta.url));

// A candidate root is a valid assets tree when it has the config + mcp +
// plugins shape. Probe failures never throw (try/catch → next candidate).
export function probeAssets(root) {
  try {
    return (
      fs.existsSync(path.join(root, 'config', 'opencode.json')) &&
      fs.existsSync(path.join(root, 'mcp', 'mcp-servers.json')) &&
      fs.readdirSync(path.join(root, 'plugins')).length >= 1
    );
  } catch {
    return false;
  }
}

export function resolveAssetsRoot(opts = {}) {
  // (a) explicit override (tests, --assets-root style callers)
  if (opts.assetsRoot) return opts.assetsRoot;
  // (b) environment override
  if (process.env.ALI_KIRO_ASSETS) return process.env.ALI_KIRO_ASSETS;
  // (c) assets directory beside the running binary (distribution layout)
  const beside = path.join(path.dirname(process.execPath), 'assets');
  if (probeAssets(beside)) return beside;
  // (d) assets directory under the current working directory
  const cwd = path.join(process.cwd(), 'assets');
  if (probeAssets(cwd)) return cwd;
  // (e) module-relative (node/source mode); also the final error-reporting fallback
  return REAL_ASSETS;
}