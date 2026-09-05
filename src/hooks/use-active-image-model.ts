import {
  isValidTextToImageModel,
  type TextToImageModel,
} from '@/shared/ai/models';
import { useCallback, useSyncExternalStore } from 'react';

import { getLogger } from '@/shared/observability/logger';

const logger = getLogger(['openstory', 'ui', 'use-active-image-model']);

/**
 * Viewer-local "active image model" selection for a sequence. Mirrors
 * {@link useActiveVideoModel} — which model's image the scenes view displays is
 * a per-viewer preference stored in localStorage keyed by sequence, kept in
 * sync within and across tabs via a module store + `useSyncExternalStore`.
 * `null` means "no explicit pick" — fall back to each shot's own image.
 */

const KEY_PREFIX = 'openstory:active-image-model:';
const storageKey = (sequenceId: string) => `${KEY_PREFIX}${sequenceId}`;

const store = new Map<string, TextToImageModel | null | undefined>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

let storageListenerAttached = false;
function ensureStorageListener() {
  if (storageListenerAttached || typeof window === 'undefined') return;
  storageListenerAttached = true;
  window.addEventListener('storage', (event) => {
    if (!event.key || !event.key.startsWith(KEY_PREFIX)) return;
    const sequenceId = event.key.slice(KEY_PREFIX.length);
    const next =
      event.newValue && isValidTextToImageModel(event.newValue)
        ? event.newValue
        : null;
    store.set(sequenceId, next);
    emit();
  });
}

function subscribe(listener: () => void) {
  ensureStorageListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function hydrate(sequenceId: string): TextToImageModel | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(storageKey(sequenceId));
    if (raw && isValidTextToImageModel(raw)) return raw;
  } catch (error) {
    logger.warn('Failed to read active image model from localStorage', {
      err: error,
    });
  }
  return null;
}

function read(sequenceId: string): TextToImageModel | null {
  const cached = store.get(sequenceId);
  if (cached !== undefined) return cached;
  const hydrated = hydrate(sequenceId);
  store.set(sequenceId, hydrated);
  return hydrated;
}

function write(sequenceId: string, model: TextToImageModel | null) {
  store.set(sequenceId, model);
  if (typeof window !== 'undefined') {
    try {
      if (model) {
        localStorage.setItem(storageKey(sequenceId), model);
      } else {
        localStorage.removeItem(storageKey(sequenceId));
      }
    } catch (error) {
      logger.warn('Failed to persist active image model to localStorage', {
        err: error,
      });
    }
  }
  emit();
}

export function useActiveImageModel(sequenceId: string) {
  const activeImageModel = useSyncExternalStore(
    subscribe,
    () => read(sequenceId),
    () => null
  );

  const selectImageModel = useCallback(
    (model: TextToImageModel | null) => {
      write(sequenceId, model);
    },
    [sequenceId]
  );

  return { activeImageModel, selectImageModel };
}
