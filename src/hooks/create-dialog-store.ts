/**
 * Global Dialog Store Factory (#1099)
 *
 * Module store + useSyncExternalStore for a dialog that is mounted once in the
 * app shell and opened from anywhere — including non-React callers like the
 * query client's global mutation error handler.
 *
 * Deliberately free of app imports so `query-client.ts` can depend on stores
 * built here without an import cycle.
 *
 * The state is module-global, which on Workers means it is shared across
 * requests in an isolate. That is safe ONLY because the open/close commands
 * are called from client event handlers and `getServerSnapshot` always returns
 * `false`, so nothing server-rendered ever reads a leaked value.
 */

import { useSyncExternalStore } from 'react';

export type DialogStore<P extends string = string> = {
  /** `payload` names why/where it was opened; read it back via `getPayload`. */
  open: (payload?: P) => void;
  close: () => void;
  useIsOpen: () => boolean;
  getPayload: () => P | undefined;
};

export function createDialogStore<P extends string = string>(): DialogStore<P> {
  let isOpen = false;
  let payload: P | undefined;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const set = (next: boolean) => {
    if (isOpen === next) return;
    isOpen = next;
    emit();
  };

  return {
    open: (next?: P) => {
      payload = next;
      set(true);
    },
    close: () => set(false),
    getPayload: () => payload,
    useIsOpen: () =>
      useSyncExternalStore(
        subscribe,
        () => isOpen,
        () => false
      ),
  };
}
