/**
 * Lightweight pub/sub so non-React callers (the query client's mutation
 * cache) can fire the low-balance toast without importing it.
 *
 * `useLowBalanceWarning` is mounted in the app shell and owns the toast.
 */

const listeners = new Set<() => void>();

export function notifyInsufficientCredits(): void {
  for (const listener of listeners) listener();
}

export function subscribeInsufficientCredits(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
