import { isValidAudioModel, type AudioModel } from '@/lib/ai/models';
import { useCallback, useSyncExternalStore } from 'react';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ui', 'use-active-audio-model']);

/**
 * Viewer-local "active audio model" selection for a sequence (#546).
 *
 * Audio is generated per-sequence (one track per model in
 * `sequence_music_variants`); which model's track the music tab plays is a
 * per-viewer preference, stored in localStorage keyed by sequence. Same
 * module-store + `useSyncExternalStore` pattern as {@link useActiveVideoModel}
 * so the header dropdown and the music tab stay in sync within the tab and
 * across tabs. `null` means "no explicit pick" — fall back to the live
 * `sequences.music*` primary.
 */

const KEY_PREFIX = 'openstory:active-audio-model:';
const storageKey = (sequenceId: string) => `${KEY_PREFIX}${sequenceId}`;

const store = new Map<string, AudioModel | null | undefined>();
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
      event.newValue && isValidAudioModel(event.newValue)
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

function hydrate(sequenceId: string): AudioModel | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(storageKey(sequenceId));
    if (raw && isValidAudioModel(raw)) return raw;
  } catch (error) {
    logger.warn('Failed to read active audio model from localStorage', {
      err: error,
    });
  }
  return null;
}

function read(sequenceId: string): AudioModel | null {
  const cached = store.get(sequenceId);
  if (cached !== undefined) return cached;
  const hydrated = hydrate(sequenceId);
  store.set(sequenceId, hydrated);
  return hydrated;
}

function write(sequenceId: string, model: AudioModel | null) {
  store.set(sequenceId, model);
  if (typeof window !== 'undefined') {
    try {
      if (model) {
        localStorage.setItem(storageKey(sequenceId), model);
      } else {
        localStorage.removeItem(storageKey(sequenceId));
      }
    } catch (error) {
      logger.warn('Failed to persist active audio model to localStorage', {
        err: error,
      });
    }
  }
  emit();
}

export function useActiveAudioModel(sequenceId: string) {
  const activeAudioModel = useSyncExternalStore(
    subscribe,
    () => read(sequenceId),
    () => null
  );

  const selectAudioModel = useCallback(
    (model: AudioModel | null) => {
      write(sequenceId, model);
    },
    [sequenceId]
  );

  return { activeAudioModel, selectAudioModel };
}
