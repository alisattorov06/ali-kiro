import { createHash } from 'node:crypto';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

/** Hash the complete finalized marketplace projection deterministically. */
export function marketplaceConfigFingerprint(input: {
  readonly id: string;
  readonly runtimeName: string;
  readonly identity: string | undefined;
  readonly canonicalConfig: unknown;
  readonly visibleConfig: unknown;
  readonly canonicalPolicy: unknown;
  readonly visiblePolicy: unknown;
  readonly canonicalModelCandidates: unknown;
  readonly visibleModelCandidates: unknown;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonical({
          id: input.id,
          runtimeName: input.runtimeName,
          identity: input.identity,
          canonicalConfig: input.canonicalConfig,
          visibleConfig: input.visibleConfig,
          canonicalPolicy: input.canonicalPolicy,
          visiblePolicy: input.visiblePolicy,
          canonicalModelCandidates: input.canonicalModelCandidates,
          visibleModelCandidates: input.visibleModelCandidates,
        }),
      ),
    )
    .digest('hex');
}
