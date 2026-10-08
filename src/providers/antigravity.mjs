// ali-kiro — provider: Google Antigravity CLI (binary `agy`).
import { entryById } from '../core/ai-registry.mjs';
import { installAndVerify } from '../install/installer.mjs';

const ID = 'antigravity';

// Contract used by pipeline.mjs step 4: `mod.install({ logger, os, arch, ...opts })`.
export async function install(opts) {
  return installAndVerify(entryById(ID), opts);
}

// Alias of the thin-provider template name; delegates to the same entry point.
export const installAndVerifyTool = install;