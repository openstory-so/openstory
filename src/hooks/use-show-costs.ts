/**
 * Show Costs Preference Hook (#1140)
 *
 * One localStorage-backed toggle for transparent pricing UI:
 * - credit balance in the sidebar
 * - likely cost under generation actions
 *
 * **Default ON** (product default for transparent pricing). Bump the storage
 * key when that default changes so prior localStorage snapshots are ignored.
 *
 * Module store + useSyncExternalStore so welcome dialog, billing settings,
 * CreditBalancePill, and ActionCost stay in sync without a reload.
 */

import { useCallback, useSyncExternalStore } from 'react';

// v2: unified pref; ignore split-era keys + any accidental default-off writes.
const STORAGE_KEY = 'openstory:show-costs:v2';
const LEGACY_KEYS = [
  'openstory:show-costs',
  'openstory:show-balance',
  'openstory:show-action-costs',
] as const;

/** Product default — transparent pricing visible until the user turns it off. */
const DEFAULT_SHOW_COSTS = true;

/** `undefined` = not yet hydrated from localStorage. */
let cached: boolean | undefined;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

let storageListenerAttached = false;
function ensureStorageListener() {
  if (storageListenerAttached || typeof window === 'undefined') return;
  storageListenerAttached = true;
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    cached = parseStored(event.newValue);
    emit();
  });
}

function parseStored(raw: string | null): boolean {
  // Missing key → default ON. Only the string "true" is on; anything else is off.
  if (raw === null) return DEFAULT_SHOW_COSTS;
  return raw === 'true';
}

function clearLegacyKeys() {
  for (const key of LEGACY_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // private mode / quota
    }
  }
}

function subscribe(listener: () => void) {
  ensureStorageListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function hydrate(): boolean {
  if (typeof window === 'undefined') return DEFAULT_SHOW_COSTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      // First visit on v2 — product default ON; drop split-era keys.
      clearLegacyKeys();
      localStorage.setItem(STORAGE_KEY, String(DEFAULT_SHOW_COSTS));
      return DEFAULT_SHOW_COSTS;
    }
    clearLegacyKeys();
    return parseStored(raw);
  } catch {
    return DEFAULT_SHOW_COSTS;
  }
}

function read(): boolean {
  if (cached !== undefined) return cached;
  const value = hydrate();
  cached = value;
  return value;
}

function write(value: boolean) {
  cached = value;
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
      clearLegacyKeys();
    } catch {
      // private mode / quota — keep in-memory value
    }
  }
  emit();
}

export function useShowCosts() {
  const showCosts = useSyncExternalStore(
    subscribe,
    read,
    () => DEFAULT_SHOW_COSTS
  );

  const setShowCosts = useCallback((value: boolean) => {
    write(value);
  }, []);

  return { showCosts, setShowCosts };
}
