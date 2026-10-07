import { type AgentDefinition, resolvePrompt } from './orchestrator';
import { createSynthesisOnlyPermission } from './permissions';

// NOTE: Councillor system prompts live in the councillor agent factory.
// The council agent synthesizes councillor responses passed by the orchestrator.

export const COUNCIL_COMPACTION_EXCEPTION =
  'Exception: if the host asks you to produce a session checkpoint or compaction summary in a specific template, follow that template exactly and do not use the council report format.';

/** Idempotent: `createAgents` and the later host-agent merge can drop
 * the exception. Re-apply it to the effective council prompt without
 * duplicating or imposing the synthesis reinforcement. */
export function ensureCouncilCompactionException(prompt: string): string {
  if (prompt.includes(COUNCIL_COMPACTION_EXCEPTION)) return prompt;
  return `${prompt}\n\n${COUNCIL_COMPACTION_EXCEPTION}`;
}

// The synthesis reinforcement must survive a custom prompt override. When
// the effective base prompt still carries the report format, a lean pointer
// suffices; when an override dropped it, the fallback carries the required
// structure itself. The compaction exception is kept in both places
// deliberately — a custom prompt override must not be able to drop it.
const COUNCIL_SYNTHESIS_POINTER = `\n\n---\n\nYou MUST follow the Synthesis Process and Required Output Format above. ${COUNCIL_COMPACTION_EXCEPTION}`;

const COUNCIL_SYNTHESIS_FALLBACK = `\n\n---\n\nYou MUST produce: ## Council Response (the best synthesized answer), ## Per-Councillor Details (each councillor by exact seat name, e.g. "alpha", not the model label; note failed or timed-out seats instead of omitting them), and ## Council Summary (Consensus Level: unanimous|majority|split; Agreed Points; Disagreements + resolution; Remaining Uncertainty; Recommended Action). ${COUNCIL_COMPACTION_EXCEPTION}`;

/** Idempotent dual-track synthesis reinforcement. Applied to the FINAL
 * effective council prompt (after `resolvePrompt` and the host-agent merge
 * can replace the generated content) so a custom override cannot drop the
 * required output structure. Lean pointer when the base still carries the
 * format; compact fallback when an override dropped it. */
export function ensureCouncilSynthesisReinforcement(prompt: string): string {
  // Already reinforced (marker texts appear only in the two variants).
  if (
    prompt.includes(
      'You MUST follow the Synthesis Process and Required Output Format above',
    ) ||
    prompt.includes('You MUST produce: ## Council Response')
  ) {
    return prompt;
  }
  return prompt.includes('## Council Response')
    ? prompt + COUNCIL_SYNTHESIS_POINTER
    : prompt + COUNCIL_SYNTHESIS_FALLBACK;
}

const COUNCIL_AGENT_PROMPT = `You are the Council agent - a \
synthesizer for multi-model consensus.

**Role**: You receive raw responses from multiple councillors (different models) and synthesize them into a structured council report. You do NOT dispatch councillors yourself - the orchestrator handles dispatch and provides the councillor results.

**Tools**: You have NO tools. You synthesize purely from the councillor responses provided in your context. Do not read, glob, grep, or run shell commands.

**Synthesis Process** (MANDATORY - follow in order):
1. Read the original user prompt (provided in the context)
2. Review each councillor's response individually - note each councillor's \
key insight and unique contribution by name
3. Identify agreements and contradictions between councillors
4. Resolve contradictions with explicit reasoning
5. Synthesize the optimal final answer
6. Format output per the Required Output Format below

**Behavior**:
- Credit specific insights from individual councillors using their names
- If councillors disagree, explain why you chose one approach over another
- Be transparent about trade-offs when different approaches have valid pros/cons
- Do not omit per-councillor details from the final response
- Do not collapse the output into only a final summary - keep the per-councillor and summary sections distinct
- Don't just average responses - choose the best approach and improve upon it

**Required Output Format**:
${COUNCIL_COMPACTION_EXCEPTION}

Always include these sections in your final response:

## Council Response
Provide the best synthesized answer. Integrate the strongest points from the \
councillors, resolve disagreements, and give the user a clear final \
recommendation or answer. Include relevant code examples and concrete details.

## Per-Councillor Details
For each councillor, show:
- Their key insight, idea, or recommendation (using their exact name - the seat name, e.g. "alpha", not the model label)
- Their confidence level (if expressed)
- Notable points of agreement/disagreement with other councillors
- If a councillor failed or timed out, note that status briefly instead of omitting it

## Council Summary
- **Consensus Level**: unanimous | majority | split (pick one)
- **Agreed Points**: what all councillors agreed on
- **Disagreements**: where councillors differed and your resolution
- **Remaining Uncertainty**: any caveats, untested assumptions, or open questions the council could not fully resolve
- **Recommended Action**: what to do next`;

/**
 * Create the council agent definition.
 * The council agent synthesizes councillor responses into a structured report.
 * It does not dispatch councillors — the orchestrator handles that.
 */
export function createCouncilAgent(
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  // Base only: the synthesis reinforcement is applied at the assembly layer
  // (agents/index.ts + registry.ts) to the FINAL effective prompt, because
  // `resolvePrompt` and the host-agent merge replace the factory output
  // after this returns.
  const prompt = resolvePrompt(
    'council',
    customPrompt,
    undefined,
    COUNCIL_AGENT_PROMPT,
    customAppendPrompt,
  );

  return {
    name: 'council',
    description:
      'Multi-model consensus agent that synthesizes viewpoints from council members',
    config: {
      model,
      prompt,
      permission: {
        ...createSynthesisOnlyPermission(),
      },
    },
  };
}
