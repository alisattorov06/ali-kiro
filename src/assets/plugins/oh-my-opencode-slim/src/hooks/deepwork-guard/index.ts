import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import type { PluginInput } from '@opencode-ai/plugin';

import { loadPluginConfig } from '../../config';
import { log } from '../../utils/logger';

const GUARD_HOOK_NAME = 'deepwork-guard';
const DEEPWORK_DIR = '.slim/deepwork';
const RUNTIME_DIR = '.runtime';
const WRITE_TOOLS = new Set(['write', 'edit']);
const MAX_CAPTURED = 256;
const HEAD_BYTES = 64;
/** The tombstone flip: the SKILL.md contract's completion shape (single
 * source, pinned by the SSoT fixture test). */
const COMPLETED_FLIP = /^status:\s*completed\b/;

interface CapturedWrite {
  slug: string;
  filePath: string;
  refPath: string;
  isProgress: boolean;
  existedBefore: boolean;
  sizeBefore: number;
  mtimeBefore: number;
  wasCompleted: boolean;
  mode: 'shadow' | 'enforce';
}

export interface GuardOptions {
  enabled: boolean;
  mode: 'shadow' | 'enforce';
}

interface BeforeInput {
  tool: string;
  sessionID: string;
  callID: string;
}

interface BeforeOutput {
  args?: {
    /** v2 core write/edit parameter. */
    path?: unknown;
    /** v1 write/edit parameter. */
    filePath?: unknown;
    content?: unknown;
    newString?: unknown;
    [key: string]: unknown;
  };
}

interface AfterInput {
  tool: string;
  sessionID: string;
  callID: string;
}

/** Pure decision: the guard's options from a disabled-hooks list and a raw
 * mode value. Invalid explicit modes fall back to shadow with a warning. */
export function guardOptionsFrom(
  disabledHooks: readonly string[],
  rawMode: unknown,
): GuardOptions {
  if (disabledHooks.includes(GUARD_HOOK_NAME)) {
    return { enabled: false, mode: 'shadow' };
  }
  if (rawMode === 'enforce') return { enabled: true, mode: 'enforce' };
  if (rawMode === 'shadow' || rawMode === undefined || rawMode === null) {
    return { enabled: true, mode: 'shadow' };
  }
  log('[deepwork-guard] invalid deepworkGuardMode, falling back to shadow', {
    value: String(rawMode),
  });
  return { enabled: true, mode: 'shadow' };
}

/** Hot-read the guard options per call. The off switch is the existing
 * `disabled_hooks` key; an absent or unreadable config keeps the guard on
 * in shadow mode. */
export function readGuardOptions(
  directory: string,
  hostFlavor?: string,
): GuardOptions {
  try {
    const config = loadPluginConfig(directory, { silent: true, hostFlavor });
    return guardOptionsFrom(
      Array.isArray(config.disabled_hooks) ? config.disabled_hooks : [],
      config.deepworkGuardMode,
    );
  } catch {
    return { enabled: true, mode: 'shadow' };
  }
}

/** Resolve the deepwork task slug a write targets, or null when the write
 * is not a task-directory write: root-level files (router heads, strays),
 * `.runtime/` bookkeeping, and paths outside `.slim/deepwork/` are not
 * task writes. */
export function taskSlug(
  deepworkRoot: string,
  filePath: string,
): string | null {
  const rel = path.relative(deepworkRoot, filePath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!rel.includes(path.sep)) return null;
  const first = rel.split(path.sep)[0];
  if (!first || first === RUNTIME_DIR) return null;
  return first;
}

/** Record occupancy: the first writer of a task directory owns the claim
 * marker and the owner refreshes it. Pure increment — never blocks, never
 * denies, foreign claims are left untouched (enforcement is a later,
 * evidence-gated phase). */
export function recordClaim(
  deepworkRoot: string,
  slug: string,
  sessionID: string,
  now: number = Date.now(),
): 'created' | 'refreshed' | 'foreign' | 'unrecorded' {
  try {
    const claimsDir = path.join(deepworkRoot, RUNTIME_DIR, 'claims');
    mkdirSync(claimsDir, { recursive: true });
    const claimPath = path.join(claimsDir, `${slug}.json`);
    try {
      writeFileSync(
        claimPath,
        JSON.stringify({ owner: sessionID, since: now, lastActive: now }),
        { flag: 'wx' },
      );
      return 'created';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const claim = JSON.parse(readFileSync(claimPath, 'utf-8')) as {
        owner?: string;
        since?: number;
        lastActive?: number;
      };
      if (claim.owner === sessionID) {
        writeFileSync(
          claimPath,
          JSON.stringify({
            owner: claim.owner,
            since: claim.since ?? now,
            lastActive: now,
          }),
        );
        return 'refreshed';
      }
      // Foreign write on a claimed task: record-only (enforcement is a
      // later, evidence-gated phase). A corrupt claim also lands here —
      // fail toward not-stealing: never overwrite an unreadable owner.
      return 'foreign';
    }
  } catch (error) {
    log('[deepwork-guard] claim recording failed', {
      slug,
      error: String(error),
    });
    return 'unrecorded';
  }
}

/** Record a receipt for a completed write: path, size, first-bytes hash.
 * Witness only — a stat/read failure records nothing and never blocks;
 * the completion gate treats a missing receipt as unverified. */
export function recordReceipt(
  deepworkRoot: string,
  write: CapturedWrite,
  sessionID: string,
): void {
  try {
    const info = statSync(write.filePath);
    if (!info.isFile()) return;
    const head = createHash('sha256')
      .update(readFileSync(write.filePath).subarray(0, HEAD_BYTES))
      .digest('hex');
    const receiptsDir = path.join(deepworkRoot, RUNTIME_DIR, 'receipts');
    mkdirSync(receiptsDir, { recursive: true });
    appendFileSync(
      path.join(receiptsDir, `${write.slug}.jsonl`),
      `${JSON.stringify({
        path: write.refPath,
        bytes: info.size,
        head,
        sessionID,
        ts: Date.now(),
      })}\n`,
    );
  } catch (error) {
    log('[deepwork-guard] receipt recording failed', {
      path: write.filePath,
      error: String(error),
    });
  }
}

const DEEPWORK_REF = /`?(\.slim\/deepwork\/[^`\s)\]]+)`?/g;

/** Deepwork artifact paths the tombstone references, under its own slug. */
export function referencedArtifacts(content: string, slug: string): string[] {
  const refs: string[] = [];
  for (const match of content.matchAll(DEEPWORK_REF)) {
    // Strip trailing sentence punctuation: "see .slim/deepwork/t1/a.md."
    // must match the receipted path, which carries no punctuation.
    const ref = match[1]?.replace(/[.,;:!?]+$/, '');
    if (
      ref?.startsWith(`.slim/deepwork/${slug}/`) &&
      !ref.includes(`/${RUNTIME_DIR}/`)
    ) {
      if (!refs.includes(ref)) refs.push(ref);
    }
  }
  return refs;
}

/** Referenced artifacts with no recorded receipt. */
export function missingReceipts(
  deepworkRoot: string,
  slug: string,
  refs: string[],
): string[] {
  if (refs.length === 0) return [];
  let recorded: Set<string>;
  try {
    recorded = new Set(
      readFileSync(
        path.join(deepworkRoot, RUNTIME_DIR, 'receipts', `${slug}.jsonl`),
        'utf-8',
      )
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return (JSON.parse(line) as { path?: string }).path ?? '';
          } catch {
            return '';
          }
        }),
    );
  } catch {
    recorded = new Set();
  }
  return refs.filter((ref) => !recorded.has(ref));
}

/** Artifact paths the tombstone references that have no recorded receipt —
 * the completion gate's verdict. Pure: the callers own the mode behavior
 * (the before phase blocks write completions; the after phase prunes on
 * pass and alerts on missing, since its throws are swallowed by the
 * per-hook error isolation). */
export function unreceiptedArtifacts(
  deepworkRoot: string,
  slug: string,
  content: string,
): string[] {
  return missingReceipts(
    deepworkRoot,
    slug,
    referencedArtifacts(content, slug),
  );
}

/** Deepwork guard: machine evidence for the contract's acceptance protocol.
 * Receipts witness every write into a task directory; claim markers record
 * occupancy; the completion gate validates receipts at the only transaction
 * boundary the contract names. Silent when passing — the cost is code, not
 * context. */
export function createDeepworkGuardHook(ctx: PluginInput): {
  'tool.execute.before': (
    input: BeforeInput,
    output: BeforeOutput,
  ) => Promise<void>;
  'tool.execute.after': (input: AfterInput, output: unknown) => Promise<void>;
} {
  const deepworkRoot = path.resolve(ctx.directory, DEEPWORK_DIR);
  const captured = new Map<string, CapturedWrite>();

  return {
    'tool.execute.before': async (input, output) => {
      if (!WRITE_TOOLS.has(input.tool.toLowerCase())) return;
      const raw = output.args?.path ?? output.args?.filePath;
      if (typeof raw !== 'string' || raw === '') return;
      const filePath = path.isAbsolute(raw)
        ? raw
        : path.resolve(ctx.directory, raw);
      const slug = taskSlug(deepworkRoot, filePath);
      if (!slug) return;

      // Config is read only for deepwork task writes — ordinary file-tool
      // calls pay no schema work.
      const options = readGuardOptions(
        ctx.directory,
        (ctx as PluginInput & { hostFlavor?: string }).hostFlavor,
      );
      if (!options.enabled) return;

      const refPath = path
        .relative(ctx.directory, filePath)
        .split(path.sep)
        .join('/');
      const claimState = recordClaim(deepworkRoot, slug, input.sessionID);
      if (claimState === 'foreign') {
        // Shadow evidence for the enforcement phase's graduation criteria:
        // legal delegated sub-sessions and true foreign claims are
        // distinguishable only with this line recorded.
        log('[deepwork-guard] foreign write on claimed task (shadow)', {
          slug,
          sessionID: input.sessionID,
          path: refPath,
        });
      }

      // Capture the before-state: the after phase uses it to tell a landed
      // write from a failed one, and a completion flip from a re-edit.
      const isProgress =
        filePath === path.join(deepworkRoot, slug, 'progress.md');
      let existedBefore = false;
      let sizeBefore = 0;
      let mtimeBefore = 0;
      let wasCompleted = false;
      let currentContent: string | null = null;
      try {
        const info = statSync(filePath);
        existedBefore = info.isFile();
        sizeBefore = info.size;
        mtimeBefore = info.mtimeMs;
        if (isProgress && existedBefore) {
          currentContent = readFileSync(filePath, 'utf-8');
          wasCompleted = COMPLETED_FLIP.test(currentContent.trimStart());
        }
      } catch {
        // No file yet — first write.
      }

      // The gate needs the full resulting content. Write completions carry
      // it in args; edit completions are simulated from the current content
      // (plain string replacement, mirroring the edit tool's semantics) so
      // they are blocked before they land too. The flip format is the
      // SKILL.md contract's tombstone shape (single source); a contract
      // format change must update this regex — pinned by the SSoT fixture
      // test. The after phase remains the safety net for anything the
      // simulation misses.
      let resulting: string | null = null;
      if (isProgress && !wasCompleted) {
        if (input.tool.toLowerCase() === 'write') {
          const next = output.args?.content;
          if (typeof next === 'string') resulting = next;
        } else if (currentContent !== null) {
          const oldString = output.args?.oldString;
          const newString = output.args?.newString;
          if (typeof oldString === 'string' && typeof newString === 'string') {
            resulting =
              output.args?.replaceAll === true
                ? currentContent.split(oldString).join(newString)
                : currentContent.replace(oldString, newString);
          }
        }
      }
      if (resulting !== null && COMPLETED_FLIP.test(resulting.trimStart())) {
        const missing = unreceiptedArtifacts(deepworkRoot, slug, resulting);
        if (missing.length > 0) {
          if (options.mode === 'shadow') {
            log('[deepwork-guard] would-deny completion (shadow)', {
              slug,
              missing,
              sessionID: input.sessionID,
            });
          } else {
            throw new Error(
              `Completion blocked: the ${slug} tombstone references ${missing.length} artifact(s) with no recorded receipt: ${missing.join(', ')}. ` +
                'Lanes must write artifacts through file tools before completion is accepted. ' +
                'Write the missing artifacts, remove the references, or set deepworkGuardMode to "shadow" to skip this check.',
            );
          }
        }
      }

      captured.set(input.callID, {
        slug,
        filePath,
        refPath,
        isProgress,
        existedBefore,
        sizeBefore,
        mtimeBefore,
        wasCompleted,
        mode: options.mode,
      });
      if (captured.size > MAX_CAPTURED) {
        const oldest = captured.keys().next();
        if (oldest.value !== undefined) {
          captured.delete(oldest.value);
          log('[deepwork-guard] capture entry evicted before its receipt', {
            callID: oldest.value,
          });
        }
      }
    },

    'tool.execute.after': async (input, output) => {
      const write = captured.get(input.callID);
      if (!write) return;
      captured.delete(input.callID);

      // A failed call leaves the file untouched: no change, no receipt,
      // no gate. A landed write changed size or mtime (or is new).
      let changed = false;
      let content: string | null = null;
      try {
        const info = statSync(write.filePath);
        changed =
          info.isFile() &&
          (!write.existedBefore ||
            info.size !== write.sizeBefore ||
            info.mtimeMs !== write.mtimeBefore);
        if (changed && write.isProgress) {
          content = readFileSync(write.filePath, 'utf-8');
        }
      } catch {
        changed = false;
      }
      if (!changed) return;

      recordReceipt(deepworkRoot, write, input.sessionID);

      // A landed completion flip (edit fragments never carried the full
      // content, so the verdict is made here from the landed file): prune
      // receipts on pass; on missing, keep them as evidence and surface the
      // alert on the tool output — an after-hook throw would be swallowed
      // by the per-hook error isolation.
      if (
        content !== null &&
        !write.wasCompleted &&
        COMPLETED_FLIP.test(content.trimStart())
      ) {
        const missing = unreceiptedArtifacts(deepworkRoot, write.slug, content);
        if (missing.length === 0) {
          // Pass: prune the receipts and release the claim — the task is
          // complete, its evidence served its purpose, and a released claim
          // lets a later session adopt the tombstone directory (Trellis
          // clears the sessions pointing at a task it archives).
          for (const leaf of [
            path.join(RUNTIME_DIR, 'receipts', `${write.slug}.jsonl`),
            path.join(RUNTIME_DIR, 'claims', `${write.slug}.json`),
          ]) {
            try {
              unlinkSync(path.join(deepworkRoot, leaf));
            } catch {
              // Nothing to prune.
            }
          }
        } else {
          log('[deepwork-guard] completion without receipts', {
            slug: write.slug,
            missing,
            sessionID: input.sessionID,
          });
          if (write.mode === 'enforce') {
            const out = output as { output?: unknown };
            if (typeof out.output === 'string') {
              out.output +=
                `\n[deepwork-guard] Completion not accepted: ${missing.length} referenced artifact(s) have no recorded receipt: ${missing.join(', ')}. ` +
                'Write the missing artifacts or remove the references, then complete again.';
            }
          }
        }
      }
    },
  };
}
