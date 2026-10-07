import { tool } from '@opencode-ai/plugin';
import type { CanonicalTaskReference } from '../hooks/task-session-manager/session-recovery';
import { controlParamName } from '../v2/adapters';

export type { CanonicalTaskReference };

const z = tool.schema;

/**
 * The identifier fields a control tool's `args` object accepts, as a
 * plugin-tool raw shape. On v2 the native field is `sessionID` with a
 * deprecated `task_id` alias; on v1/unknown flavors it is only `task_id`.
 */
type TaskRefArgs = Parameters<typeof tool>[0]['args'];

/** Resolve the host's model-visible control-tool identifier parameter. */
export function idParamFor(input: unknown): string {
  return controlParamName(
    (input as { hostFlavor?: string } | undefined)?.hostFlavor,
  );
}

/**
 * Build a control tool's identifier arg fields: `{ sessionID?, task_id? }` on
 * v2, `{ task_id }` on v1. Spread into each control tool's `args` object.
 *
 * Both v2 fields are schema-optional on purpose. `src/v2/setup.ts` derives each
 * tool's JSON Schema with `z.object(def.args)` → `z.toJSONSchema`, so a
 * required `sessionID` would land in the schema's `required` array and the host
 * would reject an alias-only `{ task_id }` call before `execute()`/`readTaskRef`
 * ever run. Requiredness is instead enforced at execution: `readTaskRef`
 * returns '' when neither field is present, and each caller raises its existing
 * `<tool> requires <param>` error.
 */
export function taskRefArgs(param: string): TaskRefArgs {
  const native = z
    .string()
    .describe('Tracked task ID or Background Job Board alias');
  if (param === 'task_id') return { task_id: native };
  return {
    sessionID: native.optional(),
    task_id: z.string().optional().describe('Deprecated alias for sessionID'),
  };
}

/**
 * Read a control tool's identifier from its args, preferring the host's
 * native parameter and falling back to the alias. Returns '' when absent so
 * the caller keeps its existing `<tool> requires <param>` error.
 */
export function readTaskRef(
  args: Record<string, unknown>,
  param: string,
): string {
  const alias = param === 'task_id' ? 'sessionID' : 'task_id';
  const value = args[param] ?? args[alias];
  return typeof value === 'string' ? value.trim() : '';
}

export type CanonicalTaskResolver = (
  parentSessionID: string,
  requested: string,
) => Promise<CanonicalTaskReference>;
