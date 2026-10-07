/**
 * Appends the reminder to every eligible orchestrator user message in the session.
 * Historical copies are re-appended deterministically because reminders are not
 * persisted; dropping them would rewrite already-cached prefix bytes every turn
 * (PR #790). Do not make this tail-only.
 */
import { PHASE_REMINDER } from '../../config/constants';
import { isInternalInitiatorPart } from '../../utils';
import {
  appendTaggedSyntheticPart,
  isTaggedPart,
} from '../cache-safe-injection';
import {
  findLatestUserMessage,
  isUserMessageWithParts,
  type MessagePart,
} from '../types';

export { PHASE_REMINDER };

export const PHASE_REMINDER_METADATA_KEY = 'oh-my-opencode-slim.phaseReminder';

export function hasPhaseReminder(part: MessagePart): boolean {
  return isTaggedPart(part, PHASE_REMINDER_METADATA_KEY);
}

interface PhaseReminderOptions {
  shouldInject?: (sessionID: string) => boolean;
}

/**
 * Creates the experimental.chat.messages.transform hook for phase reminder injection.
 * This hook runs right before sending to API, so it doesn't affect UI display.
 * Only injects for the orchestrator agent.
 */
export function createPhaseReminderHook(options: PhaseReminderOptions = {}) {
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
      if (
        agent !== 'orchestrator' ||
        !sessionID ||
        (options.shouldInject && !options.shouldInject(sessionID))
      ) {
        return;
      }

      // Append as a separate part instead of mutating user-authored text;
      // the reminder stays out of the UI display and history (issue #448).
      for (const message of messages) {
        if (
          !isUserMessageWithParts(message) ||
          message.info.agent !== 'orchestrator' ||
          message.info.sessionID !== sessionID
        ) {
          continue;
        }

        const textPart = message.parts.find(
          (part) => part.type === 'text' && part.text !== undefined,
        );
        if (
          !textPart ||
          isInternalInitiatorPart(textPart) ||
          message.parts.some(hasPhaseReminder)
        ) {
          continue;
        }

        appendTaggedSyntheticPart(message, {
          text: PHASE_REMINDER,
          metadataKey: PHASE_REMINDER_METADATA_KEY,
        });
      }
    },
  };
}
