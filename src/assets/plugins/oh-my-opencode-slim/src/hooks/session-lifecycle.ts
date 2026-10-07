export class SessionLifecycle {
  #cleanupCallbacks: Array<(sessionId: string) => void> = [];
  #log: (msg: string, meta?: Record<string, unknown>) => void;

  constructor(log: (msg: string, meta?: Record<string, unknown>) => void) {
    this.#log = log;
  }

  onSessionDeleted(callback: (sessionId: string) => void): void {
    this.#cleanupCallbacks.push(callback);
  }

  dispatchSessionDeleted(sessionId: string): void {
    for (const cb of this.#cleanupCallbacks) {
      try {
        cb(sessionId);
      } catch (error) {
        this.#log(
          `[session-lifecycle] cleanup callback failed for session ${sessionId}`,
          { error },
        );
      }
    }
  }
}
