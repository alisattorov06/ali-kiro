/**
 * Process-local registry of in-flight host-session prune deletes (#1387).
 *
 * Closes the GC/revive race: a retention trim evicts a record and its
 * fire-and-forget `session.delete` starts; a `task_revive` for the raw ID
 * can still read the session while the delete is in flight, adopt it, and
 * relaunch — and the pending delete would then kill the live relaunched
 * run. Recovery awaits any registered prune before trusting a host read.
 */

const pending = new Map<string, Promise<unknown>>();

/** Track an in-flight prune; the entry removes itself once it settles. */
export function registerPendingSessionPrune(
  taskID: string,
  prune: Promise<unknown>,
): void {
  // Store a caught copy so the registry never rejects; only a newer
  // registration for the same ID may outlive this entry's settle.
  const entry = prune.catch(() => {});
  pending.set(taskID, entry);
  void entry.finally(() => {
    if (pending.get(taskID) === entry) pending.delete(taskID);
  });
}

/** The in-flight prune for a task, or undefined when none is registered. */
export function pendingSessionPrune(
  taskID: string,
): Promise<unknown> | undefined {
  return pending.get(taskID);
}
