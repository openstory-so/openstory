import {
  isValidImageToVideoModel,
  type ImageToVideoModel,
} from '@/shared/ai/models';
import { useCallback, useSyncExternalStore } from 'react';

import { getLogger } from '@/shared/observability/logger';

const logger = getLogger(['openstory', 'ui', 'use-active-video-model']);

/**
 * Viewer-local "active video model" selection for a sequence (#545).
 *
 * Which model's video the scenes view displays is a per-viewer preference, not
 * persisted server-side — stored in localStorage keyed by sequence. A
 * module-level store + `useSyncExternalStore` keeps every consumer (header
 * dropdown + scenes view) in sync within the tab without prop-drilling across
 * route levels, and survives reloads. `null` means "no explicit pick" — the
 * caller falls back to each shot's own model.
 */

const KEY_PREFIX = 'openstory:active-video-model:';
const storageKey = (sequenceId: string) => `${KEY_PREFIX}${sequenceId}`;

// Per-sequence selection cache. `undefined` = not yet hydrated from storage;
// `null` = hydrated, no explicit pick.
const store = new Map<string, ImageToVideoModel | null | undefined>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

// Keep tabs in sync: a write in another tab fires a `storage` event here. Sync
// the module store from localStorage and notify so the dropdown/player update
// without a reload. Attached lazily on first subscribe (browser-only).
let storageListenerAttached = false;
function ensureStorageListener() {
  if (storageListenerAttached || typeof window === 'undefined') return;
  storageListenerAttached = true;
  window.addEventListener('storage', (event) => {
    if (!event.key || !event.key.startsWith(KEY_PREFIX)) return;
    const sequenceId = event.key.slice(KEY_PREFIX.length);
    const next =
      event.newValue && isValidImageToVideoModel(event.newValue)
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

function hydrate(sequenceId: string): ImageToVideoModel | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(storageKey(sequenceId));
    if (raw && isValidImageToVideoModel(raw)) return raw;
  } catch (error) {
    logger.warn('Failed to read active video model from localStorage', {
      err: error,
    });
  }
  return null;
}

function read(sequenceId: string): ImageToVideoModel | null {
  const cached = store.get(sequenceId);
  if (cached !== undefined) return cached;
  const hydrated = hydrate(sequenceId);
  store.set(sequenceId, hydrated);
  return hydrated;
}

function write(sequenceId: string, model: ImageToVideoModel | null) {
  store.set(sequenceId, model);
  if (typeof window !== 'undefined') {
    try {
      if (model) {
        localStorage.setItem(storageKey(sequenceId), model);
      } else {
        localStorage.removeItem(storageKey(sequenceId));
      }
    } catch (error) {
      logger.warn('Failed to persist active video model to localStorage', {
        err: error,
      });
    }
  }
  emit();
}

export function useActiveVideoModel(sequenceId: string) {
  const activeVideoModel = useSyncExternalStore(
    subscribe,
    () => read(sequenceId),
    // Server snapshot: no localStorage, so always "no explicit pick".
    () => null
  );

  const selectVideoModel = useCallback(
    (model: ImageToVideoModel | null) => {
      write(sequenceId, model);
    },
    [sequenceId]
  );

  return { activeVideoModel, selectVideoModel };
}
