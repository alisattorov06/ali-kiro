import type { PluginInput } from '@opencode-ai/plugin';
import { SMARTFETCH_SECONDARY_SESSION_TITLE } from '../../config/constants';
import { getClient } from '../../utils/opencode-client';
import { abortSessionWithTimeout } from '../../utils/session';
import { MAX_MODEL_CONTENT_CHARS } from './constants';
import type { CachedFetch, SecondaryModel } from './types';

interface SecondaryModelResolutionInput {
  /** Dedicated webfetch model(s) from the plugin config (highest priority). */
  webfetchModels?: Array<{ id: string; variant?: string }>;
  /** `small_model` from the host's already-loaded merged OpenCode config. */
  smallModel?: string;
  /** Explorer agent model id, resolved from in-memory config at construction. */
  explorerModel?: string;
  /** Librarian agent model id, resolved from in-memory config at construction. */
  librarianModel?: string;
}

function parseModelRef(value: string | undefined) {
  if (!value) return undefined;
  const [providerID, ...rest] = value.split('/');
  const modelID = rest.join('/');
  if (!providerID || !modelID) return undefined;
  return { providerID, modelID };
}

export function pickAgentModelRef(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') return entry;
      if (
        entry &&
        typeof entry === 'object' &&
        'id' in entry &&
        typeof (entry as { id?: unknown }).id === 'string'
      ) {
        return (entry as { id: string }).id;
      }
    }
  }
  return undefined;
}

/**
 * Resolve the secondary-model chain purely from in-memory inputs.
 *
 * No filesystem or config-file access: every value is captured once at
 * plugin construction (`src/index.ts`) from the already-loaded plugin config
 * and the host's merged OpenCode config. Keeps the webfetch hot path free of
 * disk reads.
 */
export function resolveSecondaryModels(
  input: SecondaryModelResolutionInput = {},
): SecondaryModel[] {
  const models: SecondaryModel[] = [];
  const seen = new Set<string>();
  const refs: Array<{ id: string | undefined; variant?: string }> = [
    ...(input.webfetchModels ?? []),
    ...[input.smallModel, input.explorerModel, input.librarianModel].map(
      (id) => ({ id }),
    ),
  ];
  for (const ref of refs) {
    const parsed = parseModelRef(ref.id);
    if (!parsed) continue;
    const model: SecondaryModel =
      'variant' in ref ? { ...parsed, variant: ref.variant } : parsed;
    const key = `${model.providerID}/${model.modelID}${model.variant ? `#${model.variant}` : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(model);
  }
  return models;
}

function buildPrompt(content: string, prompt: string) {
  return [
    'Use only the fetched content below.',
    'Do not use tools, outside knowledge, or unstated assumptions.',
    'Answer concisely and directly.',
    'If the requested information is missing from the content, say that clearly.',
    'Preserve code examples or exact values only when they are relevant to the task.',
    '',
    'Fetched content:',
    '---',
    content,
    '---',
    '',
    'Task:',
    prompt,
  ].join('\n');
}

function prepareInput(content: string, prompt: string) {
  const sourceChars = content.length;
  const truncatedContent = content.slice(0, MAX_MODEL_CONTENT_CHARS);
  const inputChars = truncatedContent.length;
  const inputTruncated = inputChars < sourceChars;
  const effectivePrompt = inputTruncated
    ? `${prompt}\n\nNote: only the first ${inputChars} characters of a longer fetched document were provided.`
    : prompt;
  return {
    truncatedContent,
    effectivePrompt,
    inputTruncated,
    inputChars,
    sourceChars,
  };
}

export function decideSecondaryModelUse(
  fetchResult: CachedFetch,
  prompt: string | undefined,
  secondaryModels: SecondaryModel[],
) {
  if (!prompt?.trim()) return { use: false, reason: 'no_prompt' as const };
  if (!secondaryModels.length) {
    return {
      use: false,
      reason: 'no_secondary_model_configured' as const,
    };
  }
  if (!fetchResult.markdown.trim()) {
    return { use: false, reason: 'empty_content' as const };
  }
  if (fetchResult.wordCount > 0 && fetchResult.wordCount < 25) {
    return { use: false, reason: 'content_too_short' as const };
  }
  return { use: true, reason: 'prompt_present' as const };
}

const SESSION_DELETE_RETRIES = 3;
const SESSION_DELETE_RETRY_DELAY_MS = 500;
const SECONDARY_MODEL_TIMEOUT_MS = 30_000;
const pendingSecondaryModelCleanups = new WeakMap<object, number>();

/**
 * Exposed for tests so they can avoid real wall-clock sleeps.
 * Not part of the public API.
 */
export const _testConfig = {
  deleteRetryDelayMs: SESSION_DELETE_RETRY_DELAY_MS,
  secondaryModelTimeoutMs: SECONDARY_MODEL_TIMEOUT_MS,
};

async function raceTimeout<T>(operation: Promise<T>, onTimeout?: () => void) {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          onTimeout?.();
          reject(new Error('Secondary model timed out'));
        }, _testConfig.secondaryModelTimeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

/**
 * Delete a temporary secondary-model session with retry.
 *
 * The previous implementation swallowed all errors silently via
 * `.catch(() => undefined)`, which left orphaned sessions in the database
 * whenever the delete failed (e.g. during an OpenCode instance dispose/reload
 * cycle). This retries transient failures and logs persistent ones so the
 * issue is visible instead of silently leaking sessions.
 */
async function deleteSessionSafely(
  input: PluginInput,
  sessionId: string,
): Promise<void> {
  const client = getClient(input);
  for (let attempt = 1; attempt <= SESSION_DELETE_RETRIES; attempt++) {
    try {
      await client.session.delete({
        path: { id: sessionId },
        query: { directory: input.directory },
      });
      return;
    } catch (error) {
      if (attempt >= SESSION_DELETE_RETRIES) {
        console.warn(
          `[smartfetch] Failed to clean up secondary session ${sessionId} ` +
            `after ${SESSION_DELETE_RETRIES} attempts: ` +
            (error instanceof Error ? error.message : String(error)),
        );
        return;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, _testConfig.deleteRetryDelayMs),
      );
    }
  }
}

/** One-shot generation channel exposed by the v2 host
 * (`ctx.generate.text`), threaded through `PluginInput.experimental_v2`. */
export type V2GenerateText = (
  prompt: string,
  model?: { id: string; providerID: string; variant?: string },
) => Promise<{ text: string }>;

/**
 * v2 path: one-shot `ctx.generate.text`, no temporary session.
 *
 * Skips session.create / tool.ids / session.delete entirely (the v2 host
 * manages generation lifetime) while preserving the v1 contract: the same
 * deterministic `buildPrompt` embedding (generate.text has no separate
 * content channel), the same truncation + note behavior, the same
 * `{text, inputTruncated, inputChars, sourceChars}` result shape, and the
 * same `Promise.race` timeout error so the fallback chain treats v2
 * timeouts exactly like v1 timeouts.
 */
async function runSecondaryModelViaGenerateText(
  generateText: V2GenerateText,
  model: SecondaryModel,
  prompt: string,
  content: string,
) {
  const { truncatedContent, effectivePrompt, ...inputStats } = prepareInput(
    content,
    prompt,
  );

  const { variant, ...modelOnly } = model;
  const modelRef = {
    id: modelOnly.modelID,
    providerID: modelOnly.providerID,
    ...(variant ? { variant } : {}),
  };

  const result = await raceTimeout(
    generateText(buildPrompt(truncatedContent, effectivePrompt), modelRef),
  );
  return { text: result.text.trim(), ...inputStats };
}

async function runSecondaryModel(
  input: PluginInput,
  model: SecondaryModel,
  prompt: string,
  content: string,
  parentSessionID?: string,
) {
  const generateText = (
    input as { experimental_v2?: { generateText?: unknown } }
  ).experimental_v2?.generateText;
  if (typeof generateText === 'function') {
    return runSecondaryModelViaGenerateText(
      generateText as V2GenerateText,
      model,
      prompt,
      content,
    );
  }

  const client = getClient(input);
  const directory = input.directory;
  if (pendingSecondaryModelCleanups.has(client)) {
    throw new Error(
      'A secondary model session cleanup is still pending; using fetched content without starting another session',
    );
  }
  let sessionId: string | undefined;
  let promptPromise: Promise<unknown> | undefined;
  let promptTimedOut = false;
  try {
    const sessionResponse = await client.session.create({
      query: { directory },
      body: {
        title: SMARTFETCH_SECONDARY_SESSION_TITLE,
        ...(parentSessionID ? { parentID: parentSessionID } : {}),
      },
      throwOnError: true,
    });

    const session = sessionResponse.data;
    sessionId = session?.id;
    if (!sessionId) {
      const errorDetail =
        sessionResponse && 'error' in sessionResponse
          ? `: ${JSON.stringify(sessionResponse.error)}`
          : '';
      throw new Error(
        `Secondary model session did not return an id${errorDetail}`,
      );
    }

    const { truncatedContent, effectivePrompt, ...inputStats } = prepareInput(
      content,
      prompt,
    );
    const toolIDsResponse = await client.tool.ids({
      query: { directory },
    });
    const toolIDs = toolIDsResponse.data ?? [];
    const disabledTools = Object.fromEntries(
      (toolIDs || []).map((id: string) => [id, false]),
    );

    const { variant, ...modelOnly } = model;
    promptPromise = client.session.prompt({
      path: { id: sessionId },
      query: { directory },
      body: {
        model: modelOnly,
        // The v1 runtime reads the variant from the body top level and
        // strips unknown keys from `model`; the SDK type omits it, so
        // spread it through the body shape directly.
        ...(variant ? { variant } : {}),
        system:
          'Answer only from the supplied content. Do not use tools or outside knowledge.',
        tools: disabledTools,
        parts: [
          {
            type: 'text',
            text: buildPrompt(truncatedContent, effectivePrompt),
          },
        ],
      },
    });
    const result = await raceTimeout(promptPromise, () => {
      promptTimedOut = true;
      pendingSecondaryModelCleanups.set(
        client,
        (pendingSecondaryModelCleanups.get(client) ?? 0) + 1,
      );
    });

    const parts =
      (result as { data?: { parts?: Array<{ type?: string; text?: string }> } })
        ?.data?.parts ?? [];
    const text = parts
      .map((part) => (part?.type === 'text' ? part.text || '' : ''))
      .join('')
      .trim();

    return { text, ...inputStats };
  } catch (error) {
    if (promptTimedOut && sessionId) {
      try {
        await abortSessionWithTimeout(client, sessionId);
      } catch {
        // Keep the original timeout error. Cleanup remains gated on the
        // prompt settling so a failed abort cannot recreate the FK race.
      }
    }
    throw error;
  } finally {
    const cleanupSessionId = sessionId;
    if (promptTimedOut && promptPromise && cleanupSessionId) {
      void promptPromise
        .catch(() => undefined)
        .then(() => deleteSessionSafely(input, cleanupSessionId))
        .finally(() => {
          const remaining =
            (pendingSecondaryModelCleanups.get(client) ?? 1) - 1;
          if (remaining) pendingSecondaryModelCleanups.set(client, remaining);
          else pendingSecondaryModelCleanups.delete(client);
        });
    } else if (cleanupSessionId) {
      await deleteSessionSafely(input, cleanupSessionId);
    }
  }
}

export async function runSecondaryModelWithFallback(
  input: PluginInput,
  models: SecondaryModel[],
  prompt: string,
  content: string,
  parentSessionID?: string,
) {
  let lastError: unknown;
  for (const model of models) {
    try {
      const result = await runSecondaryModel(
        input,
        model,
        prompt,
        content,
        parentSessionID,
      );
      if (
        !result.text.trim() ||
        /^no response from secondary model\.?$/i.test(result.text.trim())
      ) {
        lastError = new Error('Secondary model returned no usable text');
        continue;
      }
      return { ...result, model };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? 'Secondary model failed'));
}
