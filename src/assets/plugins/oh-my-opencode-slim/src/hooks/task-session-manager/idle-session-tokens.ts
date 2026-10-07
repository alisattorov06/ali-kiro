import { clearUserWait, clearUserWaitForMessage } from './user-wait-gate';

/**
 * Per-instance session tokens used to invalidate delayed idle-reconciliation
 * timers when the parent becomes busy, errors, waits, or is deleted.
 */
export function createIdleSessionTokens(options?: {
  onInvalidate?: (sessionID: string) => void;
}) {
  const sessionTokens = new Map<string, symbol>();

  function getSessionToken(sessionID: string): symbol {
    const existing = sessionTokens.get(sessionID);
    if (existing) return existing;
    const token = Symbol(sessionID);
    sessionTokens.set(sessionID, token);
    return token;
  }

  function isCurrentSessionToken(
    sessionID: string,
    sessionToken: symbol,
  ): boolean {
    return sessionTokens.get(sessionID) === sessionToken;
  }

  function invalidate(sessionID: string): void {
    options?.onInvalidate?.(sessionID);
    sessionTokens.delete(sessionID);
  }

  /**
   * Real external user message: clear process-global wait_for_user (idempotent
   * per message identity) and invalidate local idle timers.
   */
  function onExternalUserMessage(
    sessionID: string,
    messageIdentity: string | object,
  ): void {
    clearUserWaitForMessage(sessionID, messageIdentity);
    invalidate(sessionID);
  }

  /** Genuine session deletion: local tokens + process-global wait state. */
  function clearSession(sessionID: string): void {
    invalidate(sessionID);
    clearUserWait(sessionID);
  }

  /**
   * Instance disposal: drop local tokens only. Process-global wait_for_user
   * state stays so another hook instance in the same process keeps the latch.
   */
  function disposeLocalState(): void {
    for (const sessionID of [...sessionTokens.keys()]) {
      options?.onInvalidate?.(sessionID);
    }
    sessionTokens.clear();
  }

  return {
    getSessionToken,
    isCurrentSessionToken,
    invalidate,
    onExternalUserMessage,
    clearSession,
    disposeLocalState,
    sessionTokens,
  };
}
