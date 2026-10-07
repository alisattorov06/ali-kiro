/**
 * Shared message type shapes for the OpenCode plugin API's `messages` array.
 *
 * These types describe the structure of chat messages passed through
 * `experimental.chat.messages.transform` and related hooks. All fields
 * are unioned across the files that previously defined them privately -
 * optional extras are harmless under structural typing.
 */

export type MessageInfo = {
  role: string;
  agent?: string;
  sessionID?: string;
  id?: string;
};

export type MessagePart = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

export type MessageWithParts = {
  info: MessageInfo;
  parts: MessagePart[];
};

export function isMessageWithParts(
  message: unknown,
): message is MessageWithParts {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = message as Partial<MessageWithParts>;
  return (
    !!candidate.info &&
    typeof candidate.info === 'object' &&
    typeof candidate.info.role === 'string' &&
    Array.isArray(candidate.parts)
  );
}

export function isUserMessageWithParts(
  message: unknown,
): message is MessageWithParts {
  return isMessageWithParts(message) && message.info.role === 'user';
}

export function findLatestUserMessage(
  messages: unknown[],
): MessageWithParts | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (isUserMessageWithParts(message)) {
      return message;
    }
  }
  return undefined;
}

/**
 * A user message that can be replayed into a fallback prompt.
 *
 * Accepts both the v1 transform shape (`{ info: { role: 'user' }, parts }`)
 * and the v2 `session.messages()` shape (`{ type: 'user', text }`) returned
 * by the plugin SDK's HTTP API since OpenCode 1.18.
 */
export type ReplayableUserMessage =
  | MessageWithParts
  | {
      type: 'user';
      text?: string;
    };

export function isReplayableUserMessage(
  message: unknown,
): message is ReplayableUserMessage {
  if (isUserMessageWithParts(message)) {
    return true;
  }
  if (!message || typeof message !== 'object') {
    return false;
  }
  const candidate = message as { type?: unknown };
  return candidate.type === 'user';
}

export function partsFromReplayMessage(
  message: ReplayableUserMessage,
): MessagePart[] {
  const parts = (message as Partial<MessageWithParts>).parts;
  if (Array.isArray(parts)) {
    return parts;
  }
  const text = (message as { text?: string }).text;
  return typeof text === 'string' && text.length > 0
    ? [{ type: 'text', text }]
    : [];
}
