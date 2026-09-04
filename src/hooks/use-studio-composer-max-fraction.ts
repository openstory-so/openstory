import {
  DEFAULT_STUDIO_COMPOSER_MAX_FRACTION,
  loadStudioComposerMaxFraction,
  saveStudioComposerMaxFraction,
} from '@/lib/studio/composer-max-height';
import { useCallback, useSyncExternalStore } from 'react';

let cached: number | undefined;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function read(): number {
  if (cached !== undefined) return cached;
  cached = loadStudioComposerMaxFraction();
  return cached;
}

function write(value: number) {
  cached = saveStudioComposerMaxFraction(value);
  emit();
}

/**
 * Composer max-height as a fraction of the studio column. Server snapshot is
 * the default; localStorage hydrates on the client.
 */
export function useStudioComposerMaxFraction() {
  const fraction = useSyncExternalStore(
    subscribe,
    read,
    () => DEFAULT_STUDIO_COMPOSER_MAX_FRACTION
  );

  const persist = useCallback((next: number) => {
    write(next);
  }, []);

  return [fraction, persist] as const;
}
