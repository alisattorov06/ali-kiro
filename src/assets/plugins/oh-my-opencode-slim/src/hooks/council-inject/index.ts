/**
 * Keyword-triggered Council Mode injection (omo keyword-detector pattern,
 * ported onto the omo-s cache-safe injection discipline).
 *
 * The full Council Mode dispatch procedure is NOT part of the orchestrator's
 * static prompt: it is appended as a tagged synthetic part only to
 * orchestrator user messages whose text matches a council trigger (e.g.
 * "@council", "consensus", "共识"). Messages without a trigger never carry
 * the block, so a session that never asks for a council pays zero tokens
 * for it.
 *
 * Cache safety (see ../cache-safe-injection): the block is a
 * construction-time constant (seat list + delegation vocabulary) and the
 * trigger decision is a pure function of the message text — re-running this
 * transform on later turns reproduces the same bytes at the same positions.
 * Do not make this tail-only (PR #790) and never gate it on in-memory
 * session state: a plugin restart would drop the block and rewrite already-
 * cached prefix bytes every turn.
 *
 * Compaction: the compaction bridge strips this part
 * (COMPACTION_STRIP_METADATA_KEYS). If a triggering message survives
 * compaction, the block is regenerated on the next turn by the same
 * pure-function re-derivation — no restoration state is needed.
 */
import { formatSystemReminder } from '../../config/constants';
import { isInternalInitiatorPart } from '../../utils/internal-initiator';
import {
  appendTaggedSyntheticPart,
  isTaggedPart,
} from '../cache-safe-injection';
import { findLatestUserMessage, isUserMessageWithParts } from '../types';

export const COUNCIL_INJECT_METADATA_KEY = 'oh-my-opencode-slim.councilInject';

/**
 * Council trigger keywords. Recall-biased by design: a false positive only
 * appends the block once (~190 tokens, harmless — the block itself instructs
 * the orchestrator to run a council only for consensus requests), while a
 * false negative leaves the orchestrator unaware of the Council Mode
 * procedure. ASCII words use \b word boundaries (covers "@council" and
 * "@councillor-<seat>"); CJK words use plain substring matching (JS \b is
 * ASCII-only). Deliberately excluded: bare seat names in prose, vote/投票.
 */
const COUNCIL_TRIGGER_PATTERN =
  /\b(?:councillors?|councils?|consensus|second opinions?|roundtable|multiple opinions|multiple models|several models|multi-model)\b|议会|顾问团|圆桌|共识|第二意见|多方意见|多模型|多个模型|几个模型|别的模型|其他模型/i;

const CODE_FENCE_PATTERN = /```[\s\S]*?```/g;
const INLINE_CODE_PATTERN = /`[^`\n]*`/g;
const SLASH_COMMAND_LEAD_PATTERN = /^\s*\/[a-zA-Z][\w-]*(?:\s|$)/;

/** Strip fenced code blocks and inline code so pasted configs/logs that
 * merely mention "council" do not trigger the injection. */
export function stripCodeForTriggerMatch(text: string): string {
  return text
    .replace(CODE_FENCE_PATTERN, ' ')
    .replace(INLINE_CODE_PATTERN, ' ');
}

/** Pure function of the message text: deterministic across turns and
 * across plugin restarts (the cache-safety contract above). */
export function matchesCouncilTrigger(text: string): boolean {
  const clean = stripCodeForTriggerMatch(text);
  if (SLASH_COMMAND_LEAD_PATTERN.test(clean)) return false;
  return COUNCIL_TRIGGER_PATTERN.test(clean);
}

/** Delegation wording subset needed to render the dispatch examples.
 * Structurally typed so the hooks layer does not import from src/v2. */
export interface CouncilWording {
  tool: string;
  agentParam: string;
}

/**
 * Build the Council Mode dispatch block. Pure function of the seat list and
 * delegation vocabulary — both are construction-time constants, so the
 * rendered bytes are stable for the lifetime of the plugin generation.
 */
export function buildCouncilModeBlock(
  seats: readonly string[],
  wording: CouncilWording,
): string {
  const firstSeat = seats[0] ?? 'councillor-a';
  const seatList = seats.join(', ');
  return [
    '## Council Mode',
    '',
    'Run this procedure INSTEAD of delegating straight to @council:',
    '1. If the question references external resources (PR/URL/docs), fetch them FIRST and embed a concise summary in each councillor prompt — councillors are read-only.',
    `2. Dispatch the user's question to every seat in PARALLEL via ${wording.tool}() — one call per seat (${seatList}):`,
    `   - ${wording.tool}(${wording.agentParam}='${firstSeat}', description='Councillor on <brief topic>', prompt=<question + fetched context>)`,
    '3. Collect ALL responses; retry an empty seat once. If a seat does not respond within 3 minutes, proceed without waiting indefinitely. Mark failed or timed-out seats explicitly, never omit them.',
    `4. Call ${wording.tool}(${wording.agentParam}='council', description='Synthesize council report', prompt=<question + all seat responses labeled by seat name and model>) and present its report.`,
  ].join('\n');
}

interface CouncilInjectOptions {
  /** Dispatchable councillor seat names ('councillor-<seat>'), derived from
   * the same createAgents output the orchestrator prompt's seat list uses. */
  seats: readonly string[];
  /** Native delegation wording for the host flavor (construction-time). */
  wording: CouncilWording;
}

/**
 * Creates the experimental.chat.messages.transform hook for keyword-triggered
 * Council Mode injection. Runs right before sending to API (no UI display).
 * Only injects for the orchestrator agent, and only onto messages whose text
 * matches a council trigger.
 */
export function createCouncilInjectHook(options: CouncilInjectOptions) {
  const block = formatSystemReminder(
    buildCouncilModeBlock(options.seats, options.wording),
  );

  return {
    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages?: unknown },
    ): Promise<void> => {
      const messages = Array.isArray(output.messages) ? output.messages : [];

      const lastUserMessage = findLatestUserMessage(messages);
      if (!lastUserMessage) {
        return;
      }

      const { agent, sessionID } = lastUserMessage.info;
      if (agent !== 'orchestrator' || !sessionID) {
        return;
      }

      for (const message of messages) {
        if (
          !isUserMessageWithParts(message) ||
          message.info.agent !== 'orchestrator' ||
          message.info.sessionID !== sessionID
        ) {
          continue;
        }
        if (
          message.parts.some((part) =>
            isTaggedPart(part, COUNCIL_INJECT_METADATA_KEY),
          )
        ) {
          continue;
        }

        // Collect eligible text parts once: the message-level slash gate
        // and the trigger scan share the same eligibility.
        const eligibleTexts: string[] = [];
        for (const part of message.parts) {
          if (
            part.type === 'text' &&
            typeof part.text === 'string' &&
            part.synthetic !== true &&
            !isInternalInitiatorPart(part)
          ) {
            eligibleTexts.push(part.text);
          }
        }

        // Slash commands never trigger (documented behavior): a message
        // whose FIRST eligible text part leads with a slash is a host
        // command, and the whole message is skipped — a later part
        // containing a trigger word must not inject around the command.
        if (
          eligibleTexts.length > 0 &&
          SLASH_COMMAND_LEAD_PATTERN.test(
            stripCodeForTriggerMatch(eligibleTexts[0]),
          )
        ) {
          continue;
        }

        // Scan every eligible text part (not just the first): a trigger in
        // any part of a multi-part message still injects.
        if (eligibleTexts.some((text) => matchesCouncilTrigger(text))) {
          appendTaggedSyntheticPart(message, {
            text: block,
            metadataKey: COUNCIL_INJECT_METADATA_KEY,
          });
        }
      }
    },
  };
}
