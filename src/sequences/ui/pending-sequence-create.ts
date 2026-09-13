/**
 * In-flight sequence creates that already have a client-minted id in the URL
 * (#1601). The destination page seeds its query cache and skips network reads
 * until the insert lands — otherwise `getSequenceFn` 404s and the layout
 * throws.
 *
 * Module-level so route loaders (not just hooks) can see it on the same tick
 * as `navigate()`. Not durable: a refresh during the gap is a real 404.
 */
import { useSyncExternalStore } from 'react';

const pending = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function markPendingSequenceCreate(id: string): void {
  pending.add(id);
  emit();
}

export function clearPendingSequenceCreate(id: string): void {
  if (!pending.delete(id)) return;
  emit();
}

export function isPendingSequenceCreate(id: string): boolean {
  return pending.has(id);
}

function useIsPendingSequenceCreate(id: string): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      listeners.add(onStoreChange);
      return () => {
        listeners.delete(onStoreChange);
      };
    },
    () => pending.has(id),
    () => false
  );
}

/** True once the row is safe to fetch (or there is no id yet). */
export function useSequenceReady(sequenceId: string | undefined): boolean {
  const pendingCreate = useIsPendingSequenceCreate(sequenceId ?? '');
  return Boolean(sequenceId) && !pendingCreate;
}
